import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { refreshState } from "./state.js";
import { fetchSourceRecords } from "./sources.js";

const stateFile = process.env.FEED_STATE_FILE;
if (!stateFile) throw new Error("FEED_STATE_FILE must name the restored durable feed state");
const previous = JSON.parse(await readFile(stateFile, "utf8"));
const to = new Date();
const attemptId = to.toISOString() + "-" + randomUUID();
const next = await refreshState(previous, { to, attemptId, fetchSource: fetchSourceRecords });
async function atomicJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n");
  await rename(temporary, file);
}
await atomicJson(stateFile, next);
await atomicJson("docs/latest.json", { ...next.snapshot, health: next.health, sourceState: next.sourceState });
await atomicJson("docs/health.json", next.health);
console.log(JSON.stringify({ status: next.health.status, attemptId, totalCount: next.snapshot.totalCount, sourceFailures: next.health.sourceFailures }));
// Health must be persisted and delivered before the workflow is marked failed.
