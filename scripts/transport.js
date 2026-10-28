const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function retryDelay(value, now, attempt, random = Math.random) {
  const seconds = value && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const date = value ? Date.parse(value) : NaN;
  const requested = Number.isFinite(seconds) ? seconds * 1000
    : Number.isFinite(date) ? Math.max(0, date - now) : 0;
  return Math.max(requested, 1000 * 2 ** attempt) + Math.floor(random() * 500);
}

export async function requestAll(initialUrl, source, {
  fetchImpl = fetch, wait = sleep, now = Date.now, random = Math.random,
  maxPages = 100, attempts = 4, pageDelayMs = 1000,
  budgetMs = 8 * 60 * 1000, requestTimeoutMs = 30000,
  log = console.warn
} = {}) {
  const origin = new URL(initialUrl).origin;
  const deadline = now() + budgetMs;
  const visited = new Set();
  const releases = [];
  let url = initialUrl;
  async function pause(ms) {
    if (now() + ms >= deadline) throw new Error(source + ": retry exceeds run budget; checkpoint retained");
    await wait(ms);
  }
  while (url) {
    if (visited.size >= maxPages) throw new Error(source + ": pagination limit reached before completion");
    if (visited.has(url)) throw new Error(source + ": repeated pagination URL");
    const target = new URL(url);
    if (target.origin !== origin || target.username || target.password) throw new Error(source + ": unexpected pagination origin");
    visited.add(url);
    let payload;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error(source + ": request budget exhausted");
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { accept: "application/json", "user-agent": "Tutorcare-Tender-Updater/1.1" },
          signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remaining))),
          redirect: "error"
        });
      } catch {
        if (attempt === attempts - 1) throw new Error(source + ": request failed after retries");
        await pause(retryDelay(null, now(), attempt, random));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const header = response.headers.get("retry-after");
        await response.body?.cancel();
        if (attempt === attempts - 1) throw new Error(source + ": HTTP " + response.status + " after retries");
        const delay = retryDelay(header, now(), attempt, random);
        log(source + ": HTTP " + response.status + "; Retry-After=" + JSON.stringify(header) + "; waiting " + delay + "ms");
        await pause(delay);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(source + ": HTTP " + response.status);
      }
      payload = await response.json();
      if (!payload || !Array.isArray(payload.releases)) throw new Error(source + ": invalid releases payload");
      break;
    }
    if (!payload) throw new Error(source + ": no complete response");
    releases.push(...payload.releases);
    let next = "";
    if (Array.isArray(payload.links)) next = payload.links.find(link => link.rel === "next")?.href ?? "";
    else if (payload.links && typeof payload.links === "object") next = payload.links.next ?? "";
    else if (payload.links != null) throw new Error(source + ": invalid pagination links");
    if (typeof next !== "string") throw new Error(source + ": invalid next link");
    url = next ? new URL(next, url).href : "";
    if (url) await pause(pageDelayMs);
  }
  return releases;
}
