// Scoring: fit (org-structure-to-buy) × intent (behavior-says-they-will).
// Two independent dimensions, both required for the hot tier.
//
// P0: stub. P1 replaces with real deterministic scoring. P2 adds the
// Workers AI path behind AI_SCORING_ENABLED with schema validation and
// deterministic fallback — LLM output is Tier 1 (untrusted) until parsed.

import type { SignalPayload } from "./ingest";

export interface Scores {
  fit: number; // 0-100
  intent: number; // 0-100
  reasoning: string;
  scoredBy: string;
}

export async function scoreSignal(
  _payload: SignalPayload,
  _env: Env,
): Promise<Scores> {
  // P0 walking skeleton: hardcoded stub. The seam exists; the logic doesn't yet.
  return {
    fit: 50,
    intent: 50,
    reasoning: "stub scoring (P0 walking skeleton)",
    scoredBy: "stub",
  };
}
