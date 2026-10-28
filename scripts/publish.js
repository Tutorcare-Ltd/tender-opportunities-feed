import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function publishSnapshot(snapshot, { url, token, fetchImpl = fetch } = {}) {
  if (!url || !token || new URL(url).protocol !== "https:") throw new Error("Configure the existing HTTPS bridge destination and authorization");
  if (!snapshot.health?.attemptId) throw new Error("Snapshot health is required");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "OAI-Sites-Authorization": "Bearer " + token,
        "Idempotency-Key": snapshot.health.attemptId },
      body: JSON.stringify(snapshot)
    });
  } catch {
    throw new Error("Bridge request failed or timed out; outcome uncertain. Verify receipt before retrying");
  }
  if (!response.ok) throw new Error("Bridge returned HTTP " + response.status);
  const ack = await response.json();
  if (ack.accepted !== true || ack.buildId !== snapshot.buildId ||
      ack.records !== snapshot.totalCount || ack.healthAttemptId !== snapshot.health.attemptId) {
    throw new Error("Bridge acknowledgement does not confirm snapshot AND health; inspect receiver before retrying");
  }
  return { accepted: true, buildId: ack.buildId, records: ack.records, healthAttemptId: ack.healthAttemptId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshot = JSON.parse(await readFile("docs/latest.json", "utf8"));
  console.log(JSON.stringify(await publishSnapshot(snapshot, {
    url: process.env.TENDER_UPDATE_URL, token: process.env.SITES_BYPASS_TOKEN
  })));
}
