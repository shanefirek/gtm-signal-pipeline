// gtm-signal-pipeline — thin handlers only. Logic lives in the modules.
//
//   fetch:     POST /signal (ingest) · GET / (dashboard) · GET /healthz
//   queue:     claim → score → policy → route
//   scheduled: reaper sweep + orphan re-enqueue

import { ingestSignal, type SignalPayload } from "./ingest";
import { scoreSignal } from "./scoring";
import { shouldRoute } from "./policy";
import { claimSignal, completeSignal, failSignal, insertAction, reapStale } from "./db";
import { renderDashboard } from "./dashboard";
import { log } from "./telemetry";

interface QueueMessage {
  id: number;
  trace_id: string;
}

// Vars are typed as literals from wrangler.jsonc defaults — coerce before compare.
function flag(value: string): boolean {
  return String(value) === "true";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, pipeline_enabled: flag(env.PIPELINE_ENABLED) });
    }

    if (url.pathname === "/signal" && request.method === "POST") {
      // Global kill switch: stop ingesting in one config change, no deploy.
      if (!flag(env.PIPELINE_ENABLED)) {
        return Response.json({ error: "pipeline disabled" }, { status: 503 });
      }
      const result = await ingestSignal(request, env);
      return Response.json(result.body, { status: result.status });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return renderDashboard(env);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const { id, trace_id } = message.body;

      // Atomic claim: if another consumer (or a reaper-requeued run) already
      // has this row, we get null and ack without side effects. Idempotent.
      const signal = await claimSignal(env.DB, id);
      if (!signal) {
        log("info", trace_id, "consumer.claim_lost", { signal_id: id });
        message.ack();
        continue;
      }
      log("info", trace_id, "consumer.claimed", { signal_id: id });

      try {
        const payload = JSON.parse(signal.payload) as SignalPayload;
        const scores = await scoreSignal(payload, env);
        log("info", trace_id, "consumer.scored", {
          signal_id: id,
          fit: scores.fit,
          intent: scores.intent,
          scored_by: scores.scoredBy,
        });

        const decision = shouldRoute(scores);
        const dryRun = flag(env.DRY_RUN);

        // Per-integration dry-run: score + log, but write no routing actions.
        if (!dryRun) {
          await insertAction(env.DB, {
            signal_id: id,
            trace_id,
            tier: decision.tier,
            action: decision.action,
            reason: decision.reason,
            dry_run: false,
          });
        }
        await completeSignal(env.DB, id, {
          fit: scores.fit,
          intent: scores.intent,
          reasoning: scores.reasoning,
          scoredBy: scores.scoredBy,
        });
        log("info", trace_id, "consumer.routed", {
          signal_id: id,
          tier: decision.tier,
          action: decision.action,
          dry_run: dryRun,
        });
        message.ack();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await failSignal(env.DB, id, msg);
        log("error", trace_id, "consumer.failed", { signal_id: id, error: msg });
        // Ack rather than retry: the row carries the failure state, and the
        // reaper/DLQ path owns recovery. Don't let one poison message loop.
        message.ack();
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const traceId = crypto.randomUUID();
    const ttl = Number(env.CLAIM_TTL_MINUTES) || 5;

    // Reaper: rescue anything stuck in_flight past TTL...
    const reaped = await reapStale(env.DB, ttl);
    for (const row of reaped) {
      await env.SIGNALS.send({ id: row.id, trace_id: row.trace_id });
    }
    if (reaped.length > 0) {
      log("warn", traceId, "reaper.rescued", { count: reaped.length, ids: reaped.map((r) => r.id) });
    }

    // ...and re-notify any pending rows whose queue send was lost at ingest.
    const orphans = await env.DB.prepare(
      "SELECT id, trace_id FROM signals WHERE status='pending' AND created_at < datetime('now', '-2 minutes') LIMIT 50",
    ).all<{ id: number; trace_id: string }>();
    for (const row of orphans.results ?? []) {
      await env.SIGNALS.send({ id: row.id, trace_id: row.trace_id });
    }
    if ((orphans.results ?? []).length > 0) {
      log("warn", traceId, "reaper.reenqueued_orphans", { count: orphans.results?.length });
    }

    log("info", traceId, "reaper.sweep_complete", { ttl_minutes: ttl });
  },
} satisfies ExportedHandler<Env, QueueMessage>;
