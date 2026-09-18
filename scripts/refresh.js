import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { INITIAL_LOOKBACK_DAYS, OVERLAP_HOURS } from "./config.js";
import { fetchTenderRecords } from "./sources.js";

const outputDirectory = new URL("../docs/", import.meta.url);
const latestFile = new URL("latest.json", outputDirectory);
const healthFile = new URL("health.json", outputDirectory);

async function readPrevious() {
  try { return JSON.parse(await readFile(latestFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function merge(previous = [], incoming = []) {
  const map = new Map(previous.map(record => [record.id, record]));
  for (const record of incoming) {
    const old = map.get(record.id);
    map.set(record.id, old ? { ...old, ...record, addedBuild: old.addedBuild || record.addedBuild, updatedBuild: record.addedBuild } : record);
  }
  return [...map.values()]
    .filter(record => record.matchedKeywords?.length || record.matchedCpvCodes?.some(code => !["80000000", "80500000"].includes(code)))
    .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
}

async function atomicJson(file, value) {
  const temporary = new URL(`${file.pathname}.tmp`, "file://");
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

await mkdir(outputDirectory, { recursive: true });
const previous = await readPrevious();
const to = new Date();
const from = previous?.lastSuccessfulUpdate
  ? new Date(new Date(previous.lastSuccessfulUpdate).getTime() - OVERLAP_HOURS * 3600000)
  : new Date(to.getTime() - INITIAL_LOOKBACK_DAYS * 86400000);

try {
  const { buildId, records: incoming, sourceFailures } = await fetchTenderRecords(from, to);
  const records = merge(previous?.records, incoming);
  const snapshot = {
    schemaVersion: 1,
    buildId,
    lastSuccessfulUpdate: new Date().toISOString(),
    interval: { from: from.toISOString(), to: to.toISOString() },
    sources: ["FTS", "Contracts Finder"],
    retrievedCount: incoming.length,
    totalCount: records.length,
    sourceFailures,
    records
  };
  await atomicJson(latestFile, snapshot);
  await atomicJson(healthFile, { ok: true, degraded: sourceFailures.length > 0, lastSuccessfulUpdate: snapshot.lastSuccessfulUpdate, retrievedCount: incoming.length, totalCount: records.length, sourceFailures });
  console.log(`Refresh complete: ${incoming.length} relevant releases, ${records.length} total records`);
} catch (error) {
  await atomicJson(healthFile, { ok: false, failedAt: new Date().toISOString(), lastSuccessfulUpdate: previous?.lastSuccessfulUpdate || null, message: String(error.message || error) });
  throw error;
}
