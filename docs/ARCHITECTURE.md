# Architecture Guide

This document describes the current implemented architecture in `crawl-job`.

## 1. Runtime Topology

Main entrypoint: `src/main.ts`

Major runtime subsystems initialized during startup:

- environment parsing (`src/config/env.ts`, `src/config/envSchema.ts`)
- file logging + optional JSON structured logging (`src/utils/fileLogger.ts`)
- metrics (`src/utils/metrics.ts`)
- per-domain queue and rate gate (`src/utils/domainQueue.ts`)
- dedup store (`src/utils/dedupStore.ts`)
- DB pool (`src/utils/db.ts`)
- health evaluator (`src/utils/healthCheck.ts`)
- alert dispatcher (`src/utils/alerts.ts`)

## 2. Data Ingestion Layers

### 2.1 Pre-Orchestrator Layer

- `fetchHimalayasRss()` is executed before orchestrator logic.
- results are pushed through dedup + DB save path (not the Playwright router).

### 2.2 Orchestrator Layer (`src/orchestrator.ts`)

Orchestrator receives search queries and runs source groups:

- Serper API
- Jobicy RSS
- Indeed RSS
- Internshala HTTP
- Naukri HTTP/API fallback

Each raw record is:

1. timestamped (`scrapedAt`)
2. validated by Zod
3. deduplicated via fingerprint store
4. written to Crawlee dataset
5. asynchronously inserted into PostgreSQL

Orchestrator returns a result object including `headlessNeeded`.

### 2.3 Headless Layer (Playwright)

Activated conditionally from `src/main.ts`.

Crawler: `PlaywrightCrawler` configured with:

- proxy configuration from validated pool
- session pool and fingerprinting enabled
- domain-aware delays and gate checks
- pre/post navigation hooks
- failed request handler with backoff behavior

Routing is delegated to `src/routes.ts`.

## 3. Router and Extractor Model

`src/routes.ts` maps labels to handlers.

Patterns:

- `*_HUB` handlers discover/enqueue detail URLs
- `*_DETAIL` handlers extract normalized fields

Headless sites:

- Cutshort
- Foundit
- Shine
- TimesJobs
- Wellfound
- optional Indeed
- optional LinkedIn

### Ollama Path

For selected detail handlers, route logic calls `ollamaExtractAndSave()` first:

- HTML -> markdown preprocessing
- call Ollama `/api/chat` in JSON mode
- fresher filtering
- normalization + save

On any failure, route falls back to selector extraction.

## 4. Persistence Model

## 4.1 Crawlee Dataset

- primary local dataset output in `storage/datasets/default`
- used for export and archive lifecycle

## 4.2 PostgreSQL

- table: `jobs`
- migration: `src/db/migrate.ts`
- inserts use `ON CONFLICT (fingerprint) DO NOTHING`

## 4.3 Dedup Store

- persistent JSON file: `storage/dedup-store.json`
- two-level matching:
  - URL hash
  - content hash (with description hash tie-break)
- periodic flush and retention pruning

## 5. Rate Limiting and Backoff

### Domain Policies

Defined in `src/config/rateLimits.ts`:

- per-domain request/min caps
- per-domain min delay + jitter
- per-domain concurrency cap
- risk tier metadata

### Request Gate

`src/utils/domainQueue.ts` applies sliding-window request tracking per domain.

### Violation Handling

`src/utils/rateLimitHandler.ts`:

- detect status blocks (`429`, `403`, `503`)
- detect soft block pages via content patterns
- exponential backoff with jitter
- per-domain attempt tracking

## 6. Observability

### Metrics

`src/utils/metrics.ts` tracks:

- request counts
- success/failure ratios
- jobs extracted/deduped
- rate-limit and proxy failures
- RPM and response-time window
- memory and uptime

Flushed to `storage/metrics-snapshot.json`.

### Health

`src/utils/healthCheck.ts` evaluates severity:

- `healthy`
- `degraded`
- `critical`

Writes `storage/health-report.json`.

### Alerts

`src/utils/alerts.ts` supports:

- Slack webhook
- generic webhook
- local mail command

Includes per-channel/per-severity cooldown control.

## 7. Proxy Lifecycle

1. fetch raw free proxies (`src/utils/freeProxyFetcher.ts`)
2. validate/manual + free proxies (`src/utils/proxyValidator.ts`)
3. detect paid-proxy mode (`src/utils/proxyUtils.ts`)
4. periodic pool revalidation during headless run

Manual proxy URLs from env are supported and validated first.

## 8. Storage Lifecycle Operations

`src/maintenance.ts` drives three utilities:

- archive (`src/utils/archive.ts`)
- upload (`src/utils/cloudUpload.ts`)
- cleanup (`src/utils/cleanup.ts`)

Flow:

1. dataset shards older than threshold -> `tar.gz` archives + manifest
2. optional S3-compatible upload with SigV4 implementation
3. cleanup old local archives with upload safety guard

## 9. Testing Architecture

Current test stack uses a custom JS runner, not Jest/Vitest:

- runner: `tests/run.mjs`
- specs: `tests/*.spec.js`
- targets: compiled `dist/*`

This means build artifacts must exist before running tests (`npm test` handles this).

## 10. Key Design Characteristics

- resilient multi-source collection over single-source dependency
- configurable degradation when blocked by anti-bot systems
- deterministic persistence pipeline with dedup at application + DB levels
- operational-first implementation with explicit health and maintenance tools
