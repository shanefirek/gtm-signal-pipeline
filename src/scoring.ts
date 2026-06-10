// Scoring: fit (org-structure-to-buy) × intent (behavior-says-they-will).
// Two independent dimensions, both required for the hot tier.
//
// Two paths, selected by AI_SCORING_ENABLED (per-integration kill switch):
//   deterministic — transparent components, zero API calls, all local math
//   Workers AI    — LLM inference, treated as an unreliable narrator:
//                   raw output is Tier 1 (untrusted) → zod parse w/ one
//                   retry = Tier 2 → bounds-clamped before write. ANY
//                   failure falls back to deterministic. The signal never
//                   dies because a model had a bad day; scored_by records
//                   which path actually ran.

import { z } from "zod";
import type { SignalPayload } from "./ingest";
import { log } from "./telemetry";

export interface Scores {
  fit: number; // 0-100
  intent: number; // 0-100
  reasoning: string;
  scoredBy: string;
}

const SENIOR_TITLES = /head|director|vp|vice president|chief|founder|owner/i;
const MID_TITLES = /manager|lead|principal/i;

interface Component {
  points: number;
  why: string;
}

function fitComponents(p: SignalPayload): Component[] {
  const components: Component[] = [];

  const count = typeof p.employee_count === "number" ? p.employee_count : null;
  if (count === null) components.push({ points: 10, why: "headcount unknown" });
  else if (count >= 500) components.push({ points: 40, why: `headcount ${count} (enterprise band)` });
  else if (count >= 100) components.push({ points: 30, why: `headcount ${count} (mid-market band)` });
  else if (count >= 20) components.push({ points: 15, why: `headcount ${count} (SMB band)` });
  else components.push({ points: 5, why: `headcount ${count} (below ICP floor)` });

  const title = typeof p.title === "string" ? p.title : "";
  if (SENIOR_TITLES.test(title)) components.push({ points: 30, why: `senior title "${title}"` });
  else if (MID_TITLES.test(title)) components.push({ points: 20, why: `mid title "${title}"` });
  else if (title) components.push({ points: 10, why: `title "${title}" (non-buyer band)` });

  if (p.domain) components.push({ points: 15, why: "resolvable domain" });
  if (p.company) components.push({ points: 15, why: "named company" });

  return components;
}

function intentComponents(p: SignalPayload): Component[] {
  const components: Component[] = [];

  const page = typeof p.page === "string" ? p.page : "";
  if (/pricing/i.test(page)) components.push({ points: 40, why: `pricing page visit (${page})` });
  else if (/demo|contact/i.test(page)) components.push({ points: 35, why: `high-intent page (${page})` });
  else if (/docs|product|features/i.test(page)) components.push({ points: 20, why: `evaluation page (${page})` });
  else if (page) components.push({ points: 5, why: `low-intent page (${page})` });

  const action = typeof p.action === "string" ? p.action : "";
  if (/demo_request|form_fill/i.test(action)) components.push({ points: 35, why: `direct action: ${action}` });
  else if (/download/i.test(action)) components.push({ points: 20, why: `content action: ${action}` });
  else if (action) components.push({ points: 10, why: `passive action: ${action}` });

  switch (p.source) {
    case "form_fill":
      components.push({ points: 25, why: "hand-raised via form" });
      break;
    case "product_event":
      components.push({ points: 20, why: "in-product behavior" });
      break;
    default:
      components.push({ points: 10, why: `source: ${p.source}` });
  }

  return components;
}

function total(components: Component[]): number {
  return Math.min(
    100,
    components.reduce((sum, c) => sum + c.points, 0),
  );
}

function deterministicScore(payload: SignalPayload, scoredBy: string): Scores {
  const fit = fitComponents(payload);
  const intent = intentComponents(payload);

  return {
    fit: total(fit),
    intent: total(intent),
    reasoning: `fit[${fit.map((c) => c.why).join("; ")}] intent[${intent.map((c) => c.why).join("; ")}]`,
    scoredBy,
  };
}

// ---------- Workers AI path ----------

const AiScoreSchema = z.object({
  fit: z.number().min(0).max(100),
  intent: z.number().min(0).max(100),
  reasoning: z.string().min(1).max(600),
});

const SCORING_PROMPT = `You score B2B GTM signals on two independent 0-100 dimensions:
- fit: does this organization look like a buyer? (headcount, title seniority, identifiability)
- intent: does this behavior look like buying? (page intent, action taken, source)
Return ONLY a JSON object: {"fit": <int>, "intent": <int>, "reasoning": "<one sentence naming the strongest factors>"}
No markdown fences. No preamble.`;

function stripFencing(raw: string): string {
  return raw
    .replace(/^[\s\S]*?(\{)/, "$1") // drop any preamble before first brace
    .replace(/```[a-z]*\n?/g, "")
    .trim();
}

async function aiScore(payload: SignalPayload, env: Env): Promise<Scores> {
  const model = String(env.AI_MODEL);
  let prompt = `${SCORING_PROMPT}\n\nSignal:\n${JSON.stringify(payload)}`;

  for (let attempt = 0; attempt <= 1; attempt++) {
    const response = (await env.AI.run(model as Parameters<Ai["run"]>[0], {
      messages: [{ role: "user", content: prompt }],
    })) as { response?: string };

    try {
      const parsed = AiScoreSchema.parse(JSON.parse(stripFencing(response.response ?? "")));
      return {
        fit: Math.round(parsed.fit),
        intent: Math.round(parsed.intent),
        reasoning: parsed.reasoning,
        scoredBy: `ai:${model}`,
      };
    } catch (err) {
      // Re-prompt once with the validation error as feedback, then give up.
      prompt = `${prompt}\n\nYour previous response failed validation: ${
        err instanceof Error ? err.message.slice(0, 200) : "invalid"
      }. Return ONLY valid JSON matching the schema.`;
    }
  }
  throw new Error("AI output failed schema validation after retry");
}

export async function scoreSignal(payload: SignalPayload, env: Env): Promise<Scores> {
  if (String(env.AI_SCORING_ENABLED) !== "true") {
    return deterministicScore(payload, "deterministic");
  }

  try {
    return await aiScore(payload, env);
  } catch (err) {
    // LLM errors never kill the signal — fall back, record which path ran.
    log("warn", "scoring", "ai_fallback_engaged", {
      error: err instanceof Error ? err.message : String(err),
    });
    return deterministicScore(payload, "deterministic-fallback");
  }
}
