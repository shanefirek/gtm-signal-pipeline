// Policy is its own module. Every gate, every threshold, lives here.
// Apps call it; changing policy is a policy.ts change, never a pipeline change.
// The reason field is non-negotiable — never route without saying why.

import type { Scores } from "./scoring";

export interface RouteDecision {
  tier: "hot" | "warm" | "archive";
  action: "alert_rep" | "nurture" | "archive";
  reason: string;
}

const HOT_FIT = 70;
const HOT_INTENT = 70;
const WARM_FLOOR = 40;

export function shouldRoute(scores: Scores): RouteDecision {
  // Hot requires BOTH dimensions — fit alone is a list, intent alone is noise.
  if (scores.fit >= HOT_FIT && scores.intent >= HOT_INTENT) {
    return {
      tier: "hot",
      action: "alert_rep",
      reason: `fit ${scores.fit} ≥ ${HOT_FIT} AND intent ${scores.intent} ≥ ${HOT_INTENT}: ${scores.reasoning}`,
    };
  }
  if (scores.fit >= WARM_FLOOR || scores.intent >= WARM_FLOOR) {
    return {
      tier: "warm",
      action: "nurture",
      reason: `one dimension above ${WARM_FLOOR} (fit ${scores.fit}, intent ${scores.intent}): ${scores.reasoning}`,
    };
  }
  return {
    tier: "archive",
    action: "archive",
    reason: `both dimensions below ${WARM_FLOOR} (fit ${scores.fit}, intent ${scores.intent})`,
  };
}
