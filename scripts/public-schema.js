import { CPV_CODES, KEYWORDS } from "./config.js";

// Explicit public export boundary, not a blacklist. Values are validated as well
// as keys, so private objects cannot hide inside an allowed scalar/array field.
const string = value => typeof value === "string";
const number = value => typeof value === "number" && Number.isFinite(value);
const boolean = value => typeof value === "boolean";
const nullable = validator => value => value === null || validator(value);
const strings = value => Array.isArray(value) && value.every(string);
const fields = names => Object.fromEntries(names.split(" ").map(name => [name, string]));
const intervalSchema = { from: string, to: string };

function publicObject(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid public feed object");
  const result = {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema, key)) throw new Error("Unknown field in public feed schema");
    if (!schema[key](value[key])) throw new Error("Invalid value in public feed schema");
    result[key] = structuredClone(value[key]);
  }
  return result;
}
const interval = value => { publicObject(value, intervalSchema); return true; };
const sourceSchema = {
  watermark: string, lastAttemptAt: string, lastSuccessfulUpdate: nullable(string),
  ok: boolean, error: nullable(string), interval
};

export function publicSourceState(value) {
  const sourceMap = publicObject(value, {
    FTS: source => { publicObject(source, sourceSchema); return true; },
    "Contracts Finder": source => { publicObject(source, sourceSchema); return true; }
  });
  return sourceMap;
}

export function publicScores(record) {
  const text = ((record.title || "") + " " + (record.description || "")).toLowerCase();
  const codes = (record.cpv || "").split(",").map(code => code.trim());
  const specialist = CPV_CODES.filter(code => !["80000000", "80500000"].includes(code))
    .some(code => codes.some(candidate => candidate.startsWith(code.replace(/0+$/, ""))));
  const location = /online|remote|england|united kingdom|uk-wide|national/.test(text + " " + (record.location || "").toLowerCase()) ? 14 : 8;
  const strategy = KEYWORDS.some(keyword => text.includes(keyword)) ? 18 : specialist ? 14 : 8;
  const experience = /first aid|manual handling|safeguard|mental health|suicide|fire safety|resuscitation/.test(text) ? 18 : 10;
  const value = record.value || 0;
  const commercial = value >= 20000 && value <= 500000 ? 14 : value > 500000 && value <= 2000000 ? 10 : 6;
  return [location, strategy, experience, commercial, 0];
}

const recordSchema = {
  ...fields("id title authority category source noticeId published deadline currency stage description tenderSummary duration url location cpv addedBuild updatedBuild"),
  value: number, demo: boolean, matchedKeywords: strings, matchedCpvCodes: strings,
  // Legacy neutral placeholders are accepted; private values fail closed.
  comments: value => value === "", decision: value => value === "",
  workflowStatus: value => value === "New lead",
  fitRationale: value => value === "Team assessment required after reviewing the full specification.",
  buyerInsight: value => value === "Review the official notice and procurement documents before making a bid decision.",
  researchUrl: value => value === "", procurementUrl: value => value === "",
  // Values are checked, then always replaced with a deterministic public score.
  scores: value => Array.isArray(value) && value.every(number)
};
export function publicRecord(value) {
  if (value?.comments || value?.decision || (value?.workflowStatus && value.workflowStatus !== "New lead")) {
    throw new Error("Remove private staff fields before initializing public feed state");
  }
  const record = publicObject(value, recordSchema);
  if (Object.hasOwn(record, "scores")) record.scores = publicScores(record);
  return record;
}
const snapshotSchema = {
  schemaVersion: value => value === 1,
  ...fields("buildId lastPartialUpdate"),
  lastSuccessfulUpdate: nullable(string), interval,
  sources: strings, retrievedCount: number, totalCount: number,
  sourceFailures: strings,
  records: value => Array.isArray(value)
};
const healthSchema = {
  schemaVersion: value => value === 2,
  ...fields("attemptId attemptedAt"),
  status: value => ["healthy", "degraded", "failed"].includes(value),
  ok: boolean, degraded: boolean, lastSuccessfulUpdate: nullable(string),
  retrievedCount: number, totalCount: number, sourceFailures: strings,
  sourceState: value => { publicSourceState(value); return true; }
};

export function publicState(value) {
  const state = publicObject(value, {
    schemaVersion: version => version === 2,
    sourceState: source => { publicSourceState(source); return true; },
    snapshot: snapshot => { publicObject(snapshot, snapshotSchema); return true; },
    health: health => { publicObject(health, healthSchema); return true; }
  });
  state.snapshot.records = state.snapshot.records.map(publicRecord);
  return state;
}
