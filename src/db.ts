// Typed D1 access. The database is the source of truth — every state
// transition happens here, atomically, with status as the state machine.

export type SignalStatus = "pending" | "in_flight" | "routed" | "failed";

export interface SignalRow {
  id: number;
  trace_id: string;
  content_hash: string;
  source: string;
  payload: string;
  status: SignalStatus;
  fit_score: number | null;
  intent_score: number | null;
  reasoning: string | null;
  scored_by: string | null;
  claimed_at: string | null;
  routed_at: string | null;
  reap_count: number;
  error: string | null;
  created_at: string;
}

export async function insertSignal(
  db: D1Database,
  row: { trace_id: string; content_hash: string; source: string; payload: string },
): Promise<{ id: number; duplicate: boolean }> {
  try {
    const result = await db
      .prepare(
        "INSERT INTO signals (trace_id, content_hash, source, payload) VALUES (?, ?, ?, ?) RETURNING id",
      )
      .bind(row.trace_id, row.content_hash, row.source, row.payload)
      .first<{ id: number }>();
    if (!result) throw new Error("insert returned no row");
    return { id: result.id, duplicate: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint failed")) {
      return { id: -1, duplicate: true };
    }
    throw err;
  }
}

// Atomic claim: exactly one consumer wins. D1 serializes writes at a single
// primary, so the WHERE status='pending' guard guarantees one winner per
// claim attempt — no app-level locks needed.
export async function claimSignal(db: D1Database, id: number): Promise<SignalRow | null> {
  return db
    .prepare(
      "UPDATE signals SET status='in_flight', claimed_at=datetime('now') WHERE id=? AND status='pending' RETURNING *",
    )
    .bind(id)
    .first<SignalRow>();
}

export async function completeSignal(
  db: D1Database,
  id: number,
  scores: { fit: number; intent: number; reasoning: string; scoredBy: string },
): Promise<void> {
  await db
    .prepare(
      "UPDATE signals SET status='routed', fit_score=?, intent_score=?, reasoning=?, scored_by=?, routed_at=datetime('now') WHERE id=? AND status='in_flight'",
    )
    .bind(scores.fit, scores.intent, scores.reasoning, scores.scoredBy, id)
    .run();
}

export async function failSignal(db: D1Database, id: number, error: string): Promise<void> {
  await db
    .prepare("UPDATE signals SET status='failed', error=? WHERE id=?")
    .bind(error.slice(0, 500), id)
    .run();
}

export async function insertAction(
  db: D1Database,
  action: {
    signal_id: number;
    trace_id: string;
    tier: string;
    action: string;
    reason: string;
    dry_run: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO routed_actions (signal_id, trace_id, tier, action, reason, dry_run) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      action.signal_id,
      action.trace_id,
      action.tier,
      action.action,
      action.reason,
      action.dry_run ? 1 : 0,
    )
    .run();
}

// Reaper: anything stuck in_flight past TTL goes back to pending.
// One reaper per state machine. Crashed workers can't strand rows.
export async function reapStale(
  db: D1Database,
  ttlMinutes: number,
): Promise<{ id: number; trace_id: string }[]> {
  const result = await db
    .prepare(
      `UPDATE signals SET status='pending', claimed_at=NULL, reap_count=reap_count+1
       WHERE status='in_flight' AND claimed_at < datetime('now', ?)
       RETURNING id, trace_id`,
    )
    .bind(`-${ttlMinutes} minutes`)
    .all<{ id: number; trace_id: string }>();
  return result.results ?? [];
}

export async function getDashboardData(db: D1Database): Promise<{
  counts: Record<string, number>;
  recent: SignalRow[];
  actions: { signal_id: number; tier: string; action: string; reason: string; created_at: string }[];
  reaped: number;
}> {
  const [counts, recent, actions, reaped] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) as n FROM signals GROUP BY status").all<{ status: string; n: number }>(),
    db.prepare("SELECT * FROM signals ORDER BY id DESC LIMIT 25").all<SignalRow>(),
    db
      .prepare(
        "SELECT signal_id, tier, action, reason, created_at FROM routed_actions ORDER BY id DESC LIMIT 25",
      )
      .all<{ signal_id: number; tier: string; action: string; reason: string; created_at: string }>(),
    db.prepare("SELECT COALESCE(SUM(reap_count),0) as n FROM signals").first<{ n: number }>(),
  ]);
  return {
    counts: Object.fromEntries((counts.results ?? []).map((r) => [r.status, r.n])),
    recent: recent.results ?? [],
    actions: actions.results ?? [],
    reaped: reaped?.n ?? 0,
  };
}
