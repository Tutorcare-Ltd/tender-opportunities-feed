# Tutorcare Tender Opportunities Feed

Public, machine-readable procurement data used by Tutorcare's Tender Opportunities dashboard.

The scheduled workflow reads the official Find a Tender and Contracts Finder OCDS feeds, applies Tutorcare's published CPV and keyword criteria, validates and deduplicates matching notices, and publishes the latest successful snapshot.

This repository contains public procurement information only. It must never contain staff comments, bid decisions, internal scores, customer information, credentials, or private dashboard source code.

## Published endpoints

- `latest.json` — latest successful dashboard data
- `health.json` — refresh status and record counts

The workflow runs at 08:17 Europe/London on weekdays and can also be started manually from the Actions tab. Its first run backfills 60 days; subsequent runs overlap the previous successful interval by 24 hours.
