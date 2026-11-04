import { requestAll } from "./transport.js";
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

// Pagination and transport are isolated so tests never contact procurement services.
export async function fetchSourceRecords(source, from, to, buildId, options = {}) {
  const url = new URL(SOURCES[source]);
  const prefix = source === "FTS" ? "updated" : "published";
  url.searchParams.set(prefix + "From", from.toISOString());
  url.searchParams.set(prefix + "To", to.toISOString());
  url.searchParams.set("limit", "100");
  const releases = await requestAll(url.toString(), source, options);
  return releases.map(release => mapRelease(release, source, buildId)).filter(Boolean);
}
