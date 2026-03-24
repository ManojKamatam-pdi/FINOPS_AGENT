/**
 * In-memory abort registry.
 * When POST /api/abort is called, the run_id is registered here.
 * The orchestrator and org-agent check this between waves/batches and bail out early.
 * DynamoDB is the persistent record; this map is the live signal.
 */

const abortedRuns = new Set<string>();

export function markAborted(runId: string): void {
  abortedRuns.add(runId);
}

export function isAborted(runId: string): boolean {
  return abortedRuns.has(runId);
}

export function clearAborted(runId: string): void {
  abortedRuns.delete(runId);
}
