# gtm-signal-pipeline — Iteration Plan

**Purpose (one paragraph):** A miniaturized signal-driven GTM pipeline running entirely on Cloudflare primitives (Workers + D1 + Queues + Workers AI + cron triggers). Demonstrates the production patterns — inbox-first ingest, atomic claim, reapers, kill switches, LLM trust tiers — as a live, inspectable system. Demo-scope artifact: judgment on display, not a product.

**Data flow:**

```
POST /signal ──> D1 signals table (raw, content-hash dedup, status=pending)  [inbox-first]
                       │ queue notify {id, trace_id}
                       ▼
Queue consumer ──> atomic claim (UPDATE..RETURNING, pending→in_flight)
                       │
                       ▼
                 scoring (fit × intent; Workers AI w/ schema validation + deterministic fallback)
                       │
                       ▼
                 policy.shouldRoute() → {route, tier, reason}   [why-now payload]
                       │
                       ▼
                 routed_actions row + status=routed
                       
Cron (*/5) ──> reaper: in_flight past TTL → pending + reap_count++ (re-enqueued)
GET / ──> dashboard: live state machine view, trace IDs, reaper stats
```

**Module map (single deploy unit by design — see defer table):**

| Module | Responsibility | Monorepo-shape analog |
|---|---|---|
| `src/index.ts` | fetch / queue / scheduled handlers — thin routing only | the app |
| `src/ingest.ts` | validate, hash, persist, enqueue | app-local logic |
| `src/scoring.ts` | fit + intent scoring; AI path + deterministic fallback | `packages/scoring` |
| `src/policy.ts` | `shouldRoute(scores) → {route, tier, reason}` | `packages/policy` |
| `src/telemetry.ts` | structured JSON logs, trace_id threading | `packages/telemetry` |
| `src/db.ts` | typed D1 queries: claim, complete, reap | `packages/db` |
| `src/dashboard.ts` | HTML dashboard | the app's UI surface |

## Principle audit (column C is load-bearing)

| Principle | Where it lands | What code enforces it |
|---|---|---|
| Inbox-first ingest | `ingest.ts` writes raw row BEFORE queue send; UNIQUE(content_hash) dedups | INSERT precedes enqueue; SQLite constraint rejects dupes |
| Queue is notifier, DB is truth | Queue message carries only `{id, trace_id}`; consumer re-reads from D1 | Message schema has no payload fields to trust |
| Atomic claim | `db.ts claimSignal()` | `UPDATE..SET status='in_flight' WHERE id=? AND status='pending' RETURNING` — one winner |
| Reapers | `scheduled()` cron sweep | `reapStale()`: in_flight + claimed_at < now-TTL → pending, reap_count++ |
| Kill switches (3 levels) | wrangler vars | `PIPELINE_ENABLED` (global) / `AI_SCORING_ENABLED` (per-integration) / `DRY_RUN` (no routing writes) |
| LLM trust tiers (ai-output) | `scoring.ts` | AI output = Tier 1 → zod schema parse w/ retry = Tier 2 → bounds-checked before write. Validation fail → deterministic fallback, `scored_by` records which path |
| Error categories | `scoring.ts`, `ingest.ts` | LLM errors → fallback (never crash the claim); boundary errors → 4xx + structured body; data errors → failed status w/ error column |
| Telemetry day-one | `telemetry.ts` | `trace_id` minted at ingest (crypto.randomUUID), threaded through queue → scoring → routing; every log line is structured JSON with trace_id + step |
| Config tiers | wrangler.jsonc vars vs code | Tier 1 env: kill switches + TTL. Prompt lives in code (tier 4) — single-prompt system, no registry needed (deferred) |
| Snapshot discipline | signals table | `scored_by` (model vs fallback), score reasoning frozen on row at scoring time |
| Smoke tests | `scripts/smoke.sh` | curl + sqlite assertions against local `wrangler dev`; exit 0 = green |

## Phases

### P0 — Walking skeleton ✅ gate must pass before P1
- **Deliverables:** full scaffold; schema; ingest → D1 → queue → consumer claims → STUB scoring (`{fit:50,intent:50,scored_by:'stub'}`) → policy → routed_actions; cron reaper; minimal dashboard JSON view; telemetry threaded end-to-end; smoke script.
- **Gate (mechanical):** `scripts/smoke.sh` green against `wrangler dev`: (1) POST /signal → 202 + row in signals; (2) duplicate POST → 409, row count unchanged; (3) malformed POST → 400; (4) within 5s signal reaches status=routed + routed_actions row exists + reason non-empty; (5) GET /healthz → 200; (6) every log line for the trace_id parses as JSON.
- **Defers:** real AI call, dashboard styling, README, deploy.

### P1 — Real deterministic scoring + policy
- **Deliverables:** replace stub with real fit scoring (employee_count bands, title keywords, source weight) + intent scoring (page-intent, action type). Policy tiers: hot / warm / archive with reasons.
- **Gate:** smoke extended — high-fit+high-intent fixture routes `hot` w/ reason; low-fit fixture routes `archive`; assertions on score bounds.
- **Defers:** AI path, dashboard, README.

### P2 — Workers AI scoring path (the one LLM call)
- **Deliverables:** `AI_SCORING_ENABLED=true` path: Workers AI structured call, zod validation w/ 1 retry, deterministic fallback on any failure. `scored_by` records `ai:<model>` vs `deterministic-fallback`.
- **Gate:** smoke w/ AI disabled stays green (fallback path); local `--remote` or post-deploy curl proves AI path returns bounded scores; forced-failure test (bad model name) proves fallback engages without losing the signal.
- **Defers:** dashboard, README, deploy.

### P3 — Dashboard + README + deploy
- **Deliverables:** clean dashboard (state-machine view, live counts, trace ids, reaper stats); README as the public-facing audit table; deploy via wrangler; custom domain route.
- **Gate:** deployed URL serves dashboard; one production smoke pass; README renders.
- **Defers (permanent, by design — the saying-no audit trail):** auth (demo is read-only public + unauthenticated ingest is the point), multi-tenancy, real enrichment providers, real CRM writes, Durable Objects (no per-entity coordination need), second app (no second deploy cadence), prompt registry (single prompt), eval suite (no corpus yet — named, not forgotten).

## Iteration log

### P0 gate observation — 2026-06-09 22:04 EDT
Smoke green on first full run (8/8 assertions): healthz 200, valid POST 202 w/ signal_id+trace_id, duplicate 409, malformed 400, unknown source 400, signal routed within 10s via local queue consumer, dashboard 200 w/ reasons rendered. tsc clean. Local D1 + local queues via wrangler dev (port 8899 — 8787 occupied by another local worker).
Retro: (1) wrangler types generates literal types from vars — flag() coercion helper needed. (2) Local queues just work in wrangler dev. (3) Inbox-first made the smoke trivially deterministic — the DB is queryable at every stage.

### P1 gate observation — 2026-06-09 22:07 EDT
Smoke green 15/15 incl. new fixtures: hot fixture (form_fill, VP title, 900 headcount, /pricing, demo_request) → fit 100 / intent 100 → hot/alert_rep w/ component-level reason; junk fixture (anon /blog visit) → archive. Added GET /api/signal?trace_id= JSON inspection endpoint (replaces brittle HTML grep in smoke). scored_by='deterministic'.
Retro: component-array scoring (points + why per component) made the reason field free — the reasoning IS the score computation, no separate explanation step.

### P2 gate observation — 2026-06-09 22:16 EDT
Three-leg gate green: (1) smoke 15/15 with AI_SCORING_ENABLED=false (deterministic). (2) Forced failure via --var AI_MODEL:bogus → aiScore threw, fallback engaged, signal routed hot, scored_by='deterministic-fallback' — signal never died. (3) Real path via --var AI_SCORING_ENABLED:true → llama-3.1-8b scored fit 50 / intent 80, zod-validated, routed warm, scored_by='ai:@cf/meta/llama-3.1-8b-instruct'.
Retro: zod parse + one feedback retry + fallback = the whole ai-output trust-tier pattern in ~40 lines. The scored_by column is doing the snapshot-discipline work — you can always tell which brain scored a row.

### P3 gate observation (local half) — 2026-06-09 22:18 EDT
README written as the public-facing patterns audit (11 patterns w/ why + enforcement columns, defer section as saying-no audit trail, try-it curls). Dashboard: added fire-a-test-signal snippet w/ origin injection, em-dash scrub for external-artifact rule. tsc clean, smoke 15/15 green post-changes. REMAINING (Shane's actions — live ops): wrangler d1 create + paste database_id, queues create ×2, db:remote, deploy, custom domain route, GitHub repo create+push, production smoke, DM send.
