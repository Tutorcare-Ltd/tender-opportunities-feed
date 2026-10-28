import { OVERLAP_HOURS } from "./config.js";
export const SOURCE_NAMES = ["FTS", "Contracts Finder"];

export function validateState(state) {
  if (state?.schemaVersion !== 2 || !Array.isArray(state.snapshot?.records) ||
      typeof state.snapshot.buildId !== "string" || !state.snapshot.buildId ||
      state.snapshot.totalCount !== state.snapshot.records.length) {
    throw new Error("A validated schemaVersion 2 feed-state/state.json is required; do not use the committed September seed");
  }
  const ids = new Set();
  for (const row of state.snapshot.records) {
    if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id) || !SOURCE_NAMES.includes(row.source)) throw new Error("Invalid or duplicate record in durable feed state");
    ids.add(row.id);
    // Public feed state must never be initialized from staff workflow data.
    if (row.comments || row.decision || (row.workflowStatus && row.workflowStatus !== "New lead")) throw new Error("Remove private staff fields before initializing public feed state");
  }
  for (const source of SOURCE_NAMES) {
    if (!Number.isFinite(Date.parse(state.sourceState?.[source]?.watermark))) throw new Error("Missing verified watermark for " + source);
  }
  return state;
}

export async function refreshState(previous, { to = new Date(), attemptId, fetchSource } = {}) {
  validateState(previous);
  if (!attemptId || typeof fetchSource !== "function" || !Number.isFinite(to.getTime())) throw new Error("Refresh requires an attempt ID, valid end time and source reader");
  const sourceState = structuredClone(previous.sourceState);
  const results = await Promise.all(SOURCE_NAMES.map(async source => {
    const cursor = new Date(sourceState[source].watermark);
    const from = new Date(cursor.getTime() - OVERLAP_HOURS * 3600000);
    try {
      if (cursor > to) throw new Error("Checkpoint is in the future");
      const records = await fetchSource(source, from, to, attemptId);
      if (!Array.isArray(records) || records.some(row => !row?.id || row.source !== source)) throw new Error("Invalid normalized source records");
      return { source, ok: true, records, from: from.toISOString(), to: to.toISOString() };
    } catch (error) {
      return { source, ok: false, error: String(error.message || error), from: from.toISOString(), to: to.toISOString() };
    }
  }));
  const map = new Map(previous.snapshot.records.map(row => [row.id, row]));
  let retrievedCount = 0;
  for (const result of results) {
    const { source, ok, error, from } = result;
    sourceState[source] = { ...sourceState[source], lastAttemptAt: to.toISOString(), ok, error: error || null, interval: { from, to: to.toISOString() } };
    if (!ok) continue;
    sourceState[source].watermark = to.toISOString();
    sourceState[source].lastSuccessfulUpdate = to.toISOString();
    retrievedCount += result.records.length;
    for (const row of result.records) {
      const old = map.get(row.id);
      map.set(row.id, old ? { ...old, ...row, addedBuild: old.addedBuild || row.addedBuild, updatedBuild: attemptId } : row);
    }
  }
  const successful = results.filter(result => result.ok).length;
  const failures = results.filter(result => !result.ok).map(result => result.source + ": " + result.error);
  const records = [...map.values()].sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
  const health = {
    schemaVersion: 2, attemptId, attemptedAt: to.toISOString(),
    ok: successful === SOURCE_NAMES.length,
    status: successful === 0 ? "failed" : successful === SOURCE_NAMES.length ? "healthy" : "degraded",
    degraded: successful !== SOURCE_NAMES.length,
    lastSuccessfulUpdate: successful === SOURCE_NAMES.length ? to.toISOString() : previous.snapshot.lastSuccessfulUpdate ?? null,
    retrievedCount, totalCount: records.length, sourceFailures: failures, sourceState
  };
  const snapshot = successful === 0 ? structuredClone(previous.snapshot) : {
    ...previous.snapshot, buildId: attemptId, records, totalCount: records.length, retrievedCount,
    lastSuccessfulUpdate: health.lastSuccessfulUpdate,
    lastPartialUpdate: to.toISOString(),
    sourceFailures: failures,
    interval: { from: new Date(Math.min(...results.map(r => Date.parse(r.from)))).toISOString(), to: to.toISOString() }
  };
  // Even total failure carries new health while preserving the last-good snapshot.
  return validateState({ schemaVersion: 2, sourceState, snapshot, health });
}
