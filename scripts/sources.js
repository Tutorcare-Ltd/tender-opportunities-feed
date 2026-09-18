import { CPV_CODES, KEYWORDS, SOURCES } from "./config.js";

const compact = value => String(value || "").replace(/\s+/g, " ").trim();
const asArray = value => Array.isArray(value) ? value : value ? [value] : [];
const isoDate = value => value ? new Date(value).toISOString().slice(0, 10) : "";

function classifications(tender) {
  const candidates = [tender?.classification, ...asArray(tender?.additionalClassifications), ...asArray(tender?.items).flatMap(item => [item.classification, ...asArray(item.additionalClassifications)])].filter(Boolean);
  return [...new Set(candidates.map(item => compact(item.id)).filter(Boolean))];
}

function relevance(release) {
  const tender = release.tender || {};
  const codes = classifications(tender);
  const searchable = compact([tender.title, tender.description, ...asArray(tender.items).map(item => item.description), ...codes].join(" ")).toLowerCase();
  const cpvMatches = CPV_CODES.filter(code => {
    const trimmed = code.replace(/0+$/, "");
    const prefix = trimmed.length < 2 ? code.slice(0, 2) : trimmed;
    return codes.some(candidate => candidate.startsWith(prefix));
  });
  const keywordMatches = KEYWORDS.filter(keyword => searchable.includes(keyword));
  const specialistCpvMatches = cpvMatches.filter(code => !["80000000", "80500000"].includes(code));
  return { relevant: specialistCpvMatches.length > 0 || keywordMatches.length > 0, cpvMatches, keywordMatches, codes };
}

function noticeUrl(release, source) {
  const documents = [...asArray(release.tender?.documents), ...asArray(release.awards).flatMap(award => asArray(award.documents)), ...asArray(release.contracts).flatMap(contract => asArray(contract.documents))];
  const page = documents.find(document => /^https:\/\//.test(document.url || ""));
  if (page) return page.url;
  if (source === "FTS" && release.id) return `https://www.find-tender.service.gov.uk/Notice/${release.id}`;
  return "https://www.contractsfinder.service.gov.uk/Search";
}

function category(text) {
  const value = text.toLowerCase();
  if (value.includes("first aid") || value.includes("resuscitation")) return "First aid";
  if (value.includes("safeguard")) return "Safeguarding";
  if (value.includes("mental health") || value.includes("suicide")) return "Mental health";
  if (value.includes("manual handling")) return "Manual handling";
  if (value.includes("fire safety")) return "Fire safety";
  return "Learning & development";
}

function deliveryLocation(tender) {
  const addresses = asArray(tender?.items).flatMap(item => asArray(item.deliveryAddresses));
  return compact([...new Set(addresses.flatMap(address => [address.region, address.locality, address.postalCode]).filter(Boolean))].join(", ")) || "United Kingdom / to confirm";
}

function assessmentScores(tender, match) {
  const text = `${tender.title || ""} ${tender.description || ""}`.toLowerCase();
  const location = /online|remote|england|united kingdom|uk-wide|national/.test(`${text} ${deliveryLocation(tender).toLowerCase()}`) ? 14 : 8;
  const strategy = match.keywordMatches.length ? 18 : match.cpvMatches.some(code => !["80000000", "80500000"].includes(code)) ? 14 : 8;
  const experience = /first aid|manual handling|safeguard|mental health|suicide|fire safety|resuscitation/.test(text) ? 18 : 10;
  const value = Number(tender.value?.amount || 0);
  const commercial = value >= 20000 && value <= 500000 ? 14 : value > 500000 && value <= 2000000 ? 10 : 6;
  return [location, strategy, experience, commercial, 0];
}

function mapRelease(release, source, buildId) {
  const tender = release.tender || {};
  const match = relevance(release);
  if (!match.relevant || !tender.title) return null;
  const tags = asArray(release.tag);
  const isAward = tags.includes("award") && !tags.includes("tender");
  if (isAward) return null;
  const isPlanned = tender.status === "planned" || asArray(release.tag).includes("planning");
  const deadline = isoDate(tender.tenderPeriod?.endDate || (isPlanned ? tender.contractPeriod?.startDate : ""));
  if (!deadline) return null;
  const now = new Date();
  const contractEnd = tender.contractPeriod?.endDate ? new Date(tender.contractPeriod.endDate) : null;
  if (isAward && contractEnd && contractEnd < now) return null;
  const stage = isAward ? "Award" : isPlanned ? "Pipeline" : new Date(`${deadline}T23:59:59Z`) < now ? "Recently closed" : "Open";
  return {
    id: `${source === "FTS" ? "fts" : "cf"}-${release.id || release.ocid}`,
    title: compact(tender.title),
    authority: compact(release.buyer?.name || asArray(release.parties).find(party => asArray(party.roles).includes("buyer"))?.name || "To confirm"),
    category: category(`${tender.title} ${tender.description || ""}`),
    source,
    noticeId: compact(release.id || release.ocid),
    published: isoDate(release.date),
    deadline,
    value: Number(tender.value?.amount || 0),
    currency: tender.value?.currency || "GBP",
    stage,
    scores: assessmentScores(tender, match),
    description: compact(tender.description),
    tenderSummary: compact(tender.description),
    fitRationale: "Team assessment required after reviewing the full specification.",
    buyerInsight: "Review the official notice and procurement documents before making a bid decision.",
    decision: "",
    workflowStatus: "New lead",
    comments: "",
    duration: tender.contractPeriod ? `${isoDate(tender.contractPeriod.startDate) || "To confirm"} to ${isoDate(tender.contractPeriod.endDate) || "To confirm"}` : "To confirm on source portal",
    url: noticeUrl(release, source),
    researchUrl: "",
    procurementUrl: "",
    location: deliveryLocation(tender),
    cpv: match.codes.join(", "),
    matchedKeywords: match.keywordMatches,
    matchedCpvCodes: match.cpvMatches,
    addedBuild: buildId,
    demo: false
  };
}

function nextLink(payload) {
  if (typeof payload.links?.next === "string") return payload.links.next;
  if (Array.isArray(payload.links)) return payload.links.find(link => link.rel === "next")?.href || "";
  return "";
}

async function requestAll(initialUrl, source) {
  const releases = [];
  let url = initialUrl;
  let page = 0;
  while (url && page < 100) {
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Tutorcare-Tender-Updater/1.0" } });
      if (response.status !== 429 && response.status < 500) break;
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 15000) : 1000 * (2 ** attempt);
      console.warn(`${source}: HTTP ${response.status}; retrying in ${waitMs}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}`);
    const payload = await response.json();
    releases.push(...asArray(payload.releases));
    url = nextLink(payload);
    page += 1;
    if (url) await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.log(`${source}: retrieved ${releases.length} releases`);
  return releases;
}

export async function fetchTenderRecords(from, to) {
  const buildId = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
  const fts = new URL(SOURCES.FTS);
  fts.searchParams.set("updatedFrom", from.toISOString());
  fts.searchParams.set("updatedTo", to.toISOString());
  fts.searchParams.set("limit", "100");
  const cf = new URL(SOURCES["Contracts Finder"]);
  cf.searchParams.set("publishedFrom", from.toISOString());
  cf.searchParams.set("publishedTo", to.toISOString());
  cf.searchParams.set("limit", "100");
  const results = await Promise.allSettled([
    requestAll(fts.toString(), "FTS"),
    requestAll(cf.toString(), "Contracts Finder")
  ]);
  const [ftsResult, cfResult] = results;
  const ftsReleases = ftsResult.status === "fulfilled" ? ftsResult.value : [];
  const cfReleases = cfResult.status === "fulfilled" ? cfResult.value : [];
  const failures = results
    .map((result, index) => result.status === "rejected" ? `${index === 0 ? "FTS" : "Contracts Finder"}: ${result.reason?.message || result.reason}` : "")
    .filter(Boolean);
  for (const failure of failures) console.warn(`Source unavailable: ${failure}`);
  if (!ftsReleases.length && !cfReleases.length) throw new Error(`All sources failed: ${failures.join("; ")}`);
  return {
    buildId,
    records: [...ftsReleases.map(release => mapRelease(release, "FTS", buildId)), ...cfReleases.map(release => mapRelease(release, "Contracts Finder", buildId))].filter(Boolean),
    sourceFailures: failures
  };
}
