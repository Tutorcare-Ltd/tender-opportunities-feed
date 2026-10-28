import test from "node:test";
import assert from "node:assert/strict";
import { requestAll, retryDelay } from "../scripts/transport.js";
import { refreshState, validateState } from "../scripts/state.js";
import { publishSnapshot } from "../scripts/publish.js";
import { fetchSourceRecords } from "../scripts/sources.js";

// Every network dependency is replaced. These tests never ingest or publish.
const initialUrl = "https://example.test/feed";
const json = payload => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
function transport(sequence, extras = {}) {
  let clock = Date.parse("2026-10-28T08:17:00Z");
  const waits = [], calls = [];
  return {
    waits, calls,
    options: {
      fetchImpl: async (url, options) => { calls.push({ url, options }); const value = sequence.shift(); if (value instanceof Error) throw value; if (!value) throw new Error("Unexpected request"); return value; },
      wait: async ms => { waits.push(ms); clock += ms; },
      now: () => clock, random: () => 0, log: () => {}, ...extras
    }
  };
}
const seed = () => ({
  schemaVersion: 2,
  sourceState: {
    FTS: { watermark: "2026-10-23T08:17:00Z" },
    "Contracts Finder": { watermark: "2026-10-26T08:17:00Z" }
  },
  snapshot: { schemaVersion: 1, buildId: "old", totalCount: 2, lastSuccessfulUpdate: "2026-10-23T08:17:00Z",
    records: [{ id: "fts-old", source: "FTS", title: "Keep FTS" }, { id: "cf-old", source: "Contracts Finder", title: "Keep CF" }] }
});
const to = new Date("2026-10-28T08:17:00Z");

test("Retry-After seconds and HTTP dates are honoured without 15s truncation", () => {
  assert.equal(retryDelay("120", to.getTime(), 0, () => 0), 120000);
  assert.equal(retryDelay("Wed, 28 Oct 2026 08:19:00 GMT", to.getTime(), 0, () => 0), 120000);
  assert.equal(retryDelay("invalid", to.getTime(), 2, () => 0), 4000);
});
test("429 waits fully, then succeeds with a valid empty page", async () => {
  const t = transport([new Response("", { status: 429, headers: { "Retry-After": "120" } }), json({ releases: [] })]);
  assert.deepEqual(await requestAll(initialUrl, "FTS", t.options), []);
  assert.deepEqual(t.waits, [120000]);
});
test("long Retry-After defers rather than retrying early", async () => {
  const t = transport([new Response("", { status: 429, headers: { "Retry-After": "900" } })]);
  await assert.rejects(requestAll(initialUrl, "FTS", t.options), /exceeds run budget/);
  assert.equal(t.calls.length, 1);
  assert.equal(t.waits.length, 0);
});
test("network failures retry; exhausted attempts do not sleep again", async () => {
  const t = transport([new Error("network"), json({ releases: [] })]);
  await requestAll(initialUrl, "FTS", t.options);
  assert.deepEqual(t.waits, [1000]);
  const failed = transport(Array.from({ length: 4 }, () => new Response("", { status: 503 })));
  await assert.rejects(requestAll(initialUrl, "FTS", failed.options), /after retries/);
  assert.deepEqual(failed.waits, [1000, 2000, 4000]);
});
test("all pages are read and paced; relative next links work", async () => {
  const t = transport([json({ releases: [{ id: 1 }], links: { next: "?page=2" } }), json({ releases: [{ id: 2 }], links: [] })]);
  assert.equal((await requestAll(initialUrl, "FTS", t.options)).length, 2);
  assert.deepEqual(t.waits, [1000]);
  assert.equal(t.calls[1].url, initialUrl + "?page=2");
  assert.equal(t.calls[0].options.redirect, "error");
});
test("page cap, loops and foreign origins reject partial data", async () => {
  for (const [next, options, message] of [
    ["?page=2", { maxPages: 1 }, /pagination limit/],
    [initialUrl, {}, /repeated/],
    ["https://other.test/feed", {}, /unexpected pagination origin/]
  ]) {
    const t = transport([json({ releases: [{ id: 1 }], links: { next } })], options);
    await assert.rejects(requestAll(initialUrl, "FTS", t.options), message);
    assert.equal(t.calls.length, 1);
  }
});
test("malformed and failed later pages never become a completed source", async () => {
  const t = transport([json({ releases: [{ id: 1 }], links: { next: "?page=2" } }), json({ wrong: [] })]);
  await assert.rejects(requestAll(initialUrl, "FTS", t.options), /invalid releases/);
  const failed = transport([json({ releases: [{ id: 1 }], links: { next: "?page=2" } }), new Response("", { status: 400 })]);
  await assert.rejects(requestAll(initialUrl, "FTS", failed.options), /HTTP 400/);
});
test("partial refresh preserves failed source data and watermark", async () => {
  const previous = seed(), observed = [];
  const next = await refreshState(previous, { to, attemptId: "run1", fetchSource: async (source, from) => {
    observed.push([source, from.toISOString()]);
    if (source === "FTS") throw new Error("HTTP 429");
    return [{ id: "cf-new", source, addedBuild: "run1" }];
  } });
  assert.equal(next.health.status, "degraded");
  assert.equal(next.sourceState.FTS.watermark, previous.sourceState.FTS.watermark);
  assert.equal(next.sourceState["Contracts Finder"].watermark, to.toISOString());
  assert.equal(next.snapshot.totalCount, 3);
  assert.equal(next.snapshot.lastSuccessfulUpdate, previous.snapshot.lastSuccessfulUpdate);
  assert.deepEqual(observed, [["FTS", "2026-10-22T08:17:00.000Z"], ["Contracts Finder", "2026-10-25T08:17:00.000Z"]]);
  assert.deepEqual(previous, seed(), "input state must not be mutated");
});
test("reloaded JSON resumes persisted source-specific checkpoints", async () => {
  const first = await refreshState(seed(), { to, attemptId: "run1", fetchSource: async source => {
    if (source === "FTS") throw new Error("rate limited"); return [];
  } });
  const observed = {};
  await refreshState(JSON.parse(JSON.stringify(first)), { to: new Date("2026-10-29T08:17:00Z"), attemptId: "run2",
    fetchSource: async (source, from) => { observed[source] = from.toISOString(); return []; } });
  assert.equal(observed.FTS, "2026-10-22T08:17:00.000Z");
  assert.equal(observed["Contracts Finder"], "2026-10-27T08:17:00.000Z");
});
test("all-source failure preserves exact snapshot but advances health attempt", async () => {
  const previous = seed();
  const next = await refreshState(previous, { to, attemptId: "failed-run", fetchSource: async () => { throw new Error("HTTP 429"); } });
  assert.deepEqual(next.snapshot, previous.snapshot);
  assert.equal(next.health.status, "failed");
  assert.equal(next.health.attemptId, "failed-run");
  assert.equal(next.health.sourceFailures.length, 2);
});
test("successful empty sources advance checkpoints and retain opportunities", async () => {
  const next = await refreshState(seed(), { to, attemptId: "empty-run", fetchSource: async () => [] });
  assert.equal(next.health.status, "healthy");
  assert.equal(next.snapshot.totalCount, 2);
  assert.equal(next.snapshot.retrievedCount, 0);
  assert.equal(next.snapshot.lastSuccessfulUpdate, to.toISOString());
});
test("same notice updates without duplication and retains its original addedBuild", async () => {
  const previous = seed(); previous.snapshot.records[0].addedBuild = "original";
  const next = await refreshState(previous, { to, attemptId: "run", fetchSource: async source =>
    source === "FTS" ? [{ id: "fts-old", source, title: "Updated", addedBuild: "run" }] : [] });
  assert.equal(next.snapshot.totalCount, 2);
  assert.equal(next.snapshot.records.find(r => r.id === "fts-old").addedBuild, "original");
});
test("missing state, duplicate IDs and private workflow values fail closed", () => {
  assert.throws(() => validateState({}), /validated/);
  const duplicate = seed(); duplicate.snapshot.records[1].id = "fts-old";
  assert.throws(() => validateState(duplicate), /duplicate/);
  const privateState = seed(); privateState.snapshot.records[0].comments = "Private";
  assert.throws(() => validateState(privateState), /private staff fields/);
});
test("source normalization uses independent interval and rejects malformed dates", async () => {
  const t = transport([json({ releases: [{ id: "1", tag: ["tender"], date: "invalid",
    tender: { title: "First aid training", tenderPeriod: { endDate: "2026-11-30" } } }] })]);
  await assert.rejects(fetchSourceRecords("FTS", new Date("2026-10-01Z"), to, "run", t.options), /Invalid time/);
  assert.equal(new URL(t.calls[0].url).searchParams.get("updatedTo"), to.toISOString());
});
test("publication requires exact snapshot and health acknowledgement", async () => {
  const snapshot = { buildId: "build", totalCount: 2, health: { attemptId: "attempt" } };
  let sent;
  const args = { url: "https://bridge.test/update", token: "test-only",
    fetchImpl: async (_url, options) => { sent = options; return json({ accepted: true, buildId: "build", records: 2, healthAttemptId: "attempt" }); } };
  assert.equal((await publishSnapshot(snapshot, args)).accepted, true);
  assert.equal(sent.headers["Idempotency-Key"], "attempt");
  assert.deepEqual(JSON.parse(sent.body), snapshot);
  await assert.rejects(publishSnapshot(snapshot, { ...args, fetchImpl: async () => json({ accepted: true, buildId: "build", records: 2 }) }), /snapshot AND health/);
  let calls = 0;
  await assert.rejects(publishSnapshot(snapshot, { ...args, fetchImpl: async () => { calls++; throw new Error("timeout"); } }), /outcome uncertain/);
  assert.equal(calls, 1, "do not blindly repeat a POST with uncertain outcome");
});
