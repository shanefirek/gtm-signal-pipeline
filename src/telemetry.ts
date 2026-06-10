// Structured logging with trace threading.
// One log shape. Every step logs through here — telemetry is a wrapper, not a sprinkle.

type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  traceId: string,
  step: string,
  data: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      trace_id: traceId,
      step,
      ...data,
    }),
  );
}

export async function withTrace<T>(
  traceId: string,
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    log("info", traceId, step, { ms: Date.now() - start });
    return result;
  } catch (err) {
    log("error", traceId, step, {
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
