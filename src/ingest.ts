// Inbox-first ingest: persist raw BEFORE acknowledging, enqueue AFTER persisting.
// If the queue send fails, the cron sweep picks the row up — the queue is a
// notifier, the database is the source of truth.

import { insertSignal } from "./db";
import { log } from "./telemetry";

const VALID_SOURCES = ["website_visit", "form_fill", "webhook", "product_event"];

export interface SignalPayload {
  source: string;
  company?: string;
  domain?: string;
  title?: string;
  employee_count?: number;
  page?: string;
  action?: string;
  [key: string]: unknown;
}

export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
}

async function contentHash(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ingestSignal(
  request: Request,
  env: Env,
): Promise<IngestResult> {
  const traceId = crypto.randomUUID();

  // Boundary validation — reject early, with structure.
  // Content-Length fast-reject avoids buffering large bodies; the post-read
  // length check covers chunked bodies where the header is absent or lies.
  const MAX_BODY_BYTES = 8192;
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) {
    return { status: 413, body: { error: `body exceeds ${MAX_BODY_BYTES} bytes`, trace_id: traceId } };
  }
  let payload: SignalPayload;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return { status: 413, body: { error: `body exceeds ${MAX_BODY_BYTES} bytes`, trace_id: traceId } };
    }
    payload = JSON.parse(text) as SignalPayload;
  } catch {
    return { status: 400, body: { error: "invalid JSON body", trace_id: traceId } };
  }
  if (!payload.source || !VALID_SOURCES.includes(payload.source)) {
    return {
      status: 400,
      body: { error: `source must be one of: ${VALID_SOURCES.join(", ")}`, trace_id: traceId },
    };
  }

  const raw = JSON.stringify(payload);
  const hash = await contentHash(raw);

  // 1. Persist first
  const { id, duplicate } = await insertSignal(env.DB, {
    trace_id: traceId,
    content_hash: hash,
    source: payload.source,
    payload: raw,
  });

  if (duplicate) {
    log("info", traceId, "ingest.duplicate", { content_hash: hash });
    return { status: 409, body: { error: "duplicate signal", content_hash: hash, trace_id: traceId } };
  }

  log("info", traceId, "ingest.persisted", { signal_id: id, source: payload.source });

  // 2. Notify second. Failure here is survivable — the row is already safe.
  try {
    await env.SIGNALS.send({ id, trace_id: traceId });
    log("info", traceId, "ingest.enqueued", { signal_id: id });
  } catch (err) {
    log("warn", traceId, "ingest.enqueue_failed_row_safe", {
      signal_id: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { status: 202, body: { accepted: true, signal_id: id, trace_id: traceId } };
}
