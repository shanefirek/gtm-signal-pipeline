// Scoring: fit (org-structure-to-buy) × intent (behavior-says-they-will).
// Two independent dimensions, both required for the hot tier.
//
// P1: real deterministic scoring — transparent components, reasons assembled
// from what actually contributed. Zero API calls, all local math.
// P2 adds the Workers AI path behind AI_SCORING_ENABLED with schema
// validation and deterministic fallback — LLM output is Tier 1 (untrusted)
// until parsed.

import type { SignalPayload } from "./ingest";

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

export async function scoreSignal(payload: SignalPayload, _env: Env): Promise<Scores> {
  const fit = fitComponents(payload);
  const intent = intentComponents(payload);

  return {
    fit: total(fit),
    intent: total(intent),
    reasoning: `fit[${fit.map((c) => c.why).join("; ")}] intent[${intent.map((c) => c.why).join("; ")}]`,
    scoredBy: "deterministic",
  };
}
