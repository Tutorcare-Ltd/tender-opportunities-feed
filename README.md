# Tutorcare Tender Opportunities Feed

Public, machine-readable procurement data used by Tutorcare's Tender Opportunities dashboard.

The scheduled workflow reads the official Find a Tender and Contracts Finder OCDS feeds, applies Tutorcare's published CPV and keyword criteria, validates and deduplicates matching notices, and publishes the latest successful snapshot.

This repository contains public procurement information only. It must never contain staff comments, bid decisions, internal scores, customer information, credentials, or private dashboard source code.

## Prepared v2 repair - rollout prerequisites

Do not merge or activate this repair until the state migration and companion Site changes below are ready. No production data, secret or setting is included in this branch. Unit tests use mocks only.

The workflow remains scheduled for 08:17 Europe/London on weekdays. The repaired job only runs on main with repository variable TENDER_FEED_V2_READY set to true. Merging before activation will skip scheduled refreshes; coordinate rollout rather than leaving this gate off indefinitely.

### Durable public state

An independently initialized branch named feed-state must contain state.json:

```json
{
  "schemaVersion": 2,
  "sourceState": {
    "FTS": { "watermark": "<verified last complete FTS interval end>" },
    "Contracts Finder": { "watermark": "<verified last complete CF interval end>" }
  },
  "snapshot": {
    "schemaVersion": 1,
    "buildId": "<existing verified build>",
    "lastSuccessfulUpdate": "<last time BOTH sources were complete, or null>",
    "totalCount": 0,
    "records": []
  }
}
```

The example is a shape, NOT a production seed. Export and reconcile the last-known-good public procurement records from the actual receiver/feed path before initialization. Retain all existing opportunities. Never seed from the committed September docs/latest.json or overwrite staff workflow data. The repository is public: do not export staff comments, bid decisions, manually assigned scores or other private fields into this branch. Preserve those separately within the private Site. Automated public relevance scores may remain in feed records.

If a source's last complete interval cannot be verified, do not use the partial refresh time as its watermark. Agree a conservative backfill boundary and a controlled recovery plan after preserving the records. The new code will stop on incomplete pagination rather than pretend a capped backfill is complete; a large backlog may require separately approved bounded date windows.

Each run restores the branch, queries each source from its own watermark minus 24 hours, then advances only successfully completed sources to the fixed query end. Empty successful results advance the checkpoint without deleting records. Failed sources retain their records and checkpoints. A total failure keeps the previous snapshot unchanged and writes fresh health.

State is committed and pushed BEFORE publication. A rejected push stops publication; there is no force push. A failed bridge publication leaves the complete state durable, so the next run can republish it without losing prior records. The existing tender-refresh concurrency group serializes this workflow; Git push also rejects external concurrent state changes.

### Companion Site contract

The existing secret names TENDER_UPDATE_URL and SITES_BYPASS_TOKEN are unchanged. Do not print or extract their values.

The POST remains a snapshot at the existing destination, with added health and sourceState fields. The Idempotency-Key header is health.attemptId. The Site must:

1. Persist health independently of snapshot replacement, including when a failed run sends the SAME old snapshot buildId with a NEW health attempt ID.
2. Merge public notice fields without overwriting staff comments, decisions, manual scores or workflow status. Do not remove opportunities merely because they are absent from an incoming partial snapshot.
3. Enforce idempotent attempts and prevent older attempts/snapshots overwriting newer state. The feed-generated snapshot buildId is now an opaque ISO-timestamp-plus-UUID string; do not parse it as a numeric minute stamp. Use explicit timestamps/checkpoints for ordering.
4. Return JSON only after durable acceptance: accepted=true, buildId matching the snapshot, records matching snapshot.totalCount, and healthAttemptId matching health.attemptId. Here records means the incoming snapshot count, not the dashboard's merged row count.
5. Expose the accepted build and health via a supported authenticated read so rollout can verify them end to end. An acknowledgement alone is not proof that the dashboard reads the same store.

The publisher deliberately does not blindly repeat an uncertain POST. A timeout or mismatched acknowledgement requires receipt inspection before a retry.

lastSuccessfulUpdate now means complete success across both sources; it may remain old or null during partial refreshes. lastPartialUpdate records successful data contribution, and health.attemptedAt records the latest attempt. health.status is healthy, degraded or failed. Per-source sourceState contains watermark, lastAttemptAt, lastSuccessfulUpdate, ok, error and interval. Display staleness relative to expected weekday runs; do not equate a recent attempt with fresh source data.

### Health and failure reporting

docs/latest.json contains the retained snapshot plus fresh health; docs/health.json contains health alone. Both are retained as diagnostic artifacts, not deployed to GitHub Pages by this workflow. The combined payload goes to the private bridge even when every upstream source failed. Only after publishing health does the job fail for degraded/failed upstream status.

Failures before a health payload can be safely constructed (invalid/missing durable state, validation failure, killed runner) remain GitHub failures. The dashboard must independently detect staleness; do not assume every infrastructure failure can publish health.

### Validation and rollout

- Run npm run check and npm test. Tests replace all HTTP calls and do not ingest or publish.
- Prepare the companion Site changes and verify the contract using fixtures in a nonproduction test environment.
- Preserve/export current public feed state and private staff workflow data separately; initialize feed-state from verified public data.
- Confirm repository policy permits the refresh job's narrowly scoped contents:write permission to push feed-state. No permissions are changed by preparing this branch.
- After explicit approval, coordinate merge and TENDER_FEED_V2_READY activation, run one controlled refresh, and read back build ID, health attempt ID, source checkpoints, counts and unchanged staff decisions through the dashboard's actual data path.
- Do not delete state during rollback. Pause/disable v2 and restore code only through an approved rollback; reverting to the original workflow reintroduces the September-state defect.

The PR test workflow only runs syntax checks and mocked tests. It has read-only repository permissions and no production secrets.
