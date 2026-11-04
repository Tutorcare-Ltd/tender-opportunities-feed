const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function retryDelay(value, now, attempt, random = Math.random) {
  const seconds = value && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const date = value ? Date.parse(value) : NaN;
  const requested = Number.isFinite(seconds) ? seconds * 1000
    : Number.isFinite(date) ? Math.max(0, date - now) : 0;
  return Math.max(requested, 1000 * 2 ** attempt) + Math.floor(random() * 500);
}

// Bound the complete transport operation, including response bodies and their
// cancellation. Per-fetch aborts alone cannot guard an unresponsive transport.
export async function requestAll(initialUrl, source, options={}) {
  const budget=options.budgetMs??8*60*1000, controller=new AbortController();
  let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
    controller.abort();
    reject(new Error(source+': request budget exhausted; checkpoint retained'));
  },budget);});
  try{return await Promise.race([requestPages(initialUrl,source,{...options,overallSignal:controller.signal}),deadline]);}
  finally{clearTimeout(timer);controller.abort();}
}

async function requestPages(initialUrl, source, {
  fetchImpl = fetch, wait = sleep, now = Date.now, random = Math.random,
  maxPages = 100, attempts = 4, pageDelayMs = 1000,
  budgetMs = 8 * 60 * 1000, requestTimeoutMs = 30000,
  log = console.warn, overallSignal
} = {}) {
  const origin = new URL(initialUrl).origin;
  const deadline = now() + budgetMs;
  const visited = new Set();
  const releases = [];
  let url = initialUrl;
  async function pause(ms) {
    overallSignal.throwIfAborted();
    if (now() + ms >= deadline) throw new Error(source + ": retry exceeds run budget; checkpoint retained");
    await wait(ms);
  }
  while (url) {
    overallSignal.throwIfAborted();
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
          signal: AbortSignal.any([overallSignal,AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remaining)))]),
          redirect: "error"
        });
      } catch {
        overallSignal.throwIfAborted();
        if (attempt === attempts - 1) throw new Error(source + ": request failed after retries");
        await pause(retryDelay(null, now(), attempt, random));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const header = response.headers.get("retry-after");
        await response.body?.cancel();
        const delay = retryDelay(header, now(), attempt, random);
        const defer = message => Object.assign(new Error(message), {retryNotBefore: new Date(now()+delay).toISOString()});
        if (attempt === attempts - 1) throw defer(source + ": HTTP " + response.status + " after retries");
        if(now()+delay>=deadline) throw defer(source + ": retry exceeds run budget; checkpoint retained");
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
    if (Array.isArray(payload.links)) {
      if (payload.links.some(link => !link || typeof link !== "object" || Array.isArray(link) || typeof link.rel !== "string")) {
        throw new Error(source + ": invalid pagination links");
      }
      const declared = payload.links.filter(link => link.rel === "next");
      if (declared.length > 1 || (declared.length && (typeof declared[0].href !== "string" || !declared[0].href.trim()))) {
        throw new Error(source + ": malformed declared next link");
      }
      if (declared.length) next = declared[0].href;
    }
    else if (payload.links && typeof payload.links === "object") {
      if (Object.hasOwn(payload.links, "next")) {
        if (typeof payload.links.next !== "string" || !payload.links.next.trim()) throw new Error(source + ": malformed declared next link");
        next = payload.links.next;
      }
    }
    else if (payload.links != null) throw new Error(source + ": invalid pagination links");
    if (typeof next !== "string") throw new Error(source + ": invalid next link");
    url = next ? new URL(next, url).href : "";
    if (url) await pause(pageDelayMs);
  }
  return releases;
}
