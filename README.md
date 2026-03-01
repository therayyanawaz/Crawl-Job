# 🚀 Job Crawler

<div align="center">

![Tests](https://img.shields.io/badge/tests-39%20passed-brightgreen?style=flat-square&logo=jest)
![TypeCheck](https://img.shields.io/badge/typecheck-passing-3178c6?style=flat-square&logo=typescript)
![CI](https://img.shields.io/badge/CI-GitHub%20Actions-black?style=flat-square&logo=githubactions)
![Version](https://img.shields.io/badge/version-v1.1.0-7c3aed?style=flat-square)
![Node](https://img.shields.io/badge/node-v20.19.0-417e38?style=flat-square&logo=nodedotjs)
![License](https://img.shields.io/badge/license-MIT-f59e0b?style=flat-square)

</div>

Reliable TypeScript crawler for fresher and early-career jobs using **API + RSS + HTTP + Playwright** with deduplication, PostgreSQL persistence, health checks, and alerting.

## 🆕 What's New — v1.1.0

> The crawler went from moderate optimization maturity to **production-grade correctness, throughput, and observability** in one release — across 14 targeted fixes, 3 new utility modules, and 9 new test suites.

### 🛡️ P0 — Correctness Fixes

| # | Fix | Module | Impact |
|---|-----|--------|--------|
| 1 | 🔁 Idempotent route interception | `src/utils/requestInterception.ts` | No handler accumulation per navigation |
| 2 | 🔒 Domain concurrency release in `finally` | `src/main.ts` | Zero concurrency slot leaks on any outcome |
| 3 | ⏱️ Request latency wired correctly | `src/utils/requestTiming.ts` | Real p95 latency — no more `NaN` |
| 4 | 🚦 Single 429 backoff authority | `src/utils/rateLimitHandler.ts` | Removed duplicate sleep under rate pressure |
| 5 | 💾 Bounded persistence queue + drain | `src/utils/persistenceQueue.ts` | `PERSIST_CONCURRENCY=15`, drained on shutdown |

### 🚀 P1 — Throughput Improvements

| # | Fix | Module | Impact |
|---|-----|--------|--------|
| 6 | 🧠 O(1) fingerprint dedup via `Set` | `src/sources/dedupFingerprint.ts` | Scales linearly — no O(n²) scan |
| 7 | ⚙️ Parallel persistence batch runner | `src/utils/jobBatchRunner.ts` | Concurrent saves, bounded by queue |
| 8 | 🧭 Headless launch threshold guard | `src/utils/headlessDecision.ts` | Skip browser when API tier already delivers |

### 🔧 P2 — Ops, CI & Security

| # | Fix | Module | Impact |
|---|-----|--------|--------|
| 9  | 📊 Real pipeline metrics wired | `src/utils/metrics.ts` | Extracted / deduped / stored counters live |
| 10 | 🔐 Secrets externalized | `.env.example` + `validate-env.mjs` | No hardcoded credentials anywhere |
| 11 | 🖥️ Node version unified to v20 | `.nvmrc` + deploy scripts | Zero environment drift |
| 12 | 🤖 CI workflow | `.github/workflows/ci.yml` | Lint + typecheck + tests on every PR |
| 13 | 📈 Deterministic benchmark profiles | `testdata/benchmark/` | KPI regression tracking per commit |
| 14 | 🩺 Node16 ESM import compliance | `src/sources/*.ts` | `tsc --noEmit` clean under `moduleResolution:node16` |

## ✨ Why this setup works

Most scrapers depend too heavily on one source.
This project uses a tiered strategy so collection continues even when one source underperforms.

- 🧠 Starts with low-cost, stable sources first
- 🛡️ Escalates to headless crawling only when needed
- 🔁 Deduplicates continuously across runs
- 📦 Persists clean records into PostgreSQL
- 📊 Monitors itself with metrics + health reporting

## 🏗️ Crawl architecture

```text
Tier 0 (pre-source)
  Himalayas RSS (runs before orchestrator)
        |
        v
Orchestrator tiers
  - Serper API
  - Jobicy RSS
  - Indeed RSS
  - Internshala HTTP
  - Naukri API/HTTP
        |
        v
Headless tier (Playwright, conditional unless paid proxy)
  - Cutshort
  - Foundit
  - Shine
  - TimesJobs
  - Wellfound
  - Optional: Indeed, LinkedIn
```

### 🎯 Headless activation logic

- ✅ Always run if paid/residential proxy is detected
- ⚡ Otherwise run only if jobs are below `MIN_JOBS_BEFORE_HEADLESS` (default `15`)

## 🌐 Source matrix

| Source | Mode | Default | Notes |
| --- | --- | --- | --- |
| Himalayas | RSS | Enabled | Pre-source run before orchestrator |
| Serper | API | Enabled | Requires `SERPER_API_KEY` |
| Jobicy | RSS | Enabled | Low-cost supplement |
| Indeed | RSS | Enabled | Lightweight feed ingestion |
| Internshala | HTTP + Cheerio | Enabled | Internship-oriented source |
| Naukri | JSON API + HTML fallback | Enabled | API first, HTML fallback |
| Cutshort | Playwright | Enabled in headless tier | Runs when headless is active |
| Foundit | Playwright | Enabled in headless tier | Runs when headless is active |
| Shine | Playwright | Enabled in headless tier | Runs when headless is active |
| TimesJobs | Playwright | Enabled in headless tier | Runs when headless is active |
| Wellfound | Playwright | Enabled in headless tier | Runs when headless is active |
| Indeed (headless) | Playwright | Disabled | Enable with `ENABLE_INDEED=true` |
| LinkedIn (headless) | Playwright | Disabled | Enable with `ENABLE_LINKEDIN=true` + `LINKEDIN_COOKIE` |

## 🧰 Tech stack

- Node.js 20+
- TypeScript
- Crawlee 3 + Playwright
- PostgreSQL (`pg`)
- Zod for env/schema validation

## ⚡ Quick start

### 1) Install dependencies

```bash
npm install
npx playwright install --with-deps chromium
```

### 2) Configure environment

```bash
cp .env.example .env
```

Minimum recommended values:

```bash
# Database (either DATABASE_URL or PG* variables)
DATABASE_URL=postgresql://postgres:password@localhost:5432/attack

# Required API key
SERPER_API_KEY=your_real_key

# Optional proxies (comma-separated)
PROXY_URLS=http://user:pass@host:port
```

### 3) Prepare PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER crawler WITH PASSWORD 'change_me';
CREATE DATABASE attack OWNER crawler;
GRANT ALL PRIVILEGES ON DATABASE attack TO crawler;
SQL
```

Then apply migrations:

```bash
npm run db:migrate
```

### 4) Run crawler

```bash
npm start
```

Verbose mode:

```bash
npm run start:verbose
```

## 📌 Command reference

### Runtime and build

- `npm run dev` - watch mode for `src/main.ts`
- `npm start` - run crawler with `tsx`
- `npm run start:verbose` - run crawler with verbose logs
- `npm run build` - compile TypeScript to `dist/`
- `npm run start:prod` - run compiled `dist/main.js`
- `npm run typecheck` - strict type check without emitting files

### Database

- `npm run db:migrate` - create/alter `jobs` table and indexes
- `npm run db:migrate:check` - test DB connectivity only

### Data export and maintenance

- `npm run export` - export Crawlee dataset to `jobs_export.csv`
- `npm run archive` - archive old dataset shards
- `npm run archive:preview` - dry-run archive
- `npm run archive:status` - storage usage + archive inventory
- `npm run upload` - upload pending archives to S3-compatible storage
- `npm run cleanup` - delete old archives based on retention
- `npm run cleanup:preview` - dry-run cleanup
- `npm run maintenance` - archive -> upload -> cleanup
- `npm run maintenance:dry` - dry-run full maintenance cycle

### Tests

- `npm test` - build + run all specs
- `npm run test:verbose` - include stack traces
- `npm run test:fast` - skip build, run specs directly from `dist/`
- `npm run test:watch` - rerun tests on file changes

## 🗂️ Output artifacts

| Path | Purpose |
| --- | --- |
| `log.txt` | Run log (truncated at startup, rotates when large) |
| `storage/dedup-store.json` | Persistent dedup fingerprints |
| `storage/metrics-snapshot.json` | Periodic metrics snapshot |
| `storage/health-report.json` | Health status report |
| `storage/datasets/` | Crawlee dataset storage |
| `jobs_export.csv` | CSV export from dataset |

## 🧬 Database model (high-level)

The migration creates a `jobs` table with ingestion + dedup fields:

- Identity: `url`, `title`, `company`, `platform`, `platform_job_id`, `apply_url`
- Content: `description`, `location`, `salary`, `job_type`, `experience`, `seniority`, `posted_date`
- Crawl metadata: `source`, `source_tier`, `scraped_at`
- Dedup key: `fingerprint` (`UNIQUE`)

Indexes include source/platform/date lookups and a GIN FTS index over title + company.

## 🔧 Key environment variables

See `.env.example` for the full list. Start with:

- `DATABASE_URL` or `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`
- `SERPER_API_KEY`
- `PROXY_URLS`, `PROXY_MIN_COUNT`, `PROXY_REFRESH_INTERVAL_MINUTES`
- `MIN_JOBS_BEFORE_HEADLESS`, `HEADLESS_MAX_CONCURRENCY`
- `ENABLE_INDEED`, `ENABLE_LINKEDIN`, `LINKEDIN_COOKIE`
- `ENABLE_DOMAIN_RATE_LIMITING`
- `DEDUP_RETENTION_DAYS`, `ARCHIVE_AFTER_DAYS`, `DELETE_AFTER_DAYS`
- `ENABLE_ALERTS`, `ALERT_SLACK_WEBHOOK`, `ALERT_WEBHOOK_URL`, `ALERT_EMAIL`

## 📈 Monitoring and alerts

The crawler tracks:

- request success/failure
- requests per minute
- response-time average
- rate-limit hits and proxy failures
- memory usage and no-progress windows

Health levels:

- `healthy` ✅
- `degraded` ⚠️
- `critical` 🚨

When alerts are enabled, notifications are sent using cooldown control via `ALERT_COOLDOWN_MIN`.

### 📊 Benchmark KPIs — v1.1.0 (small profile)

| Metric | Value |
|--------|-------|
| 🏃 Jobs / min | `60` |
| 🔁 Dedup hit ratio | `25%` |
| ⏱️ p95 request latency | `142 ms` |
| 🌐 Proxy pass rate | `96.7%` |
| 🚦 429 rate | `4.4%` |

```bash
# Run benchmark locally — emits storage/benchmarks/kpi-small.json
npm run benchmark:small

# Medium and large profiles (no network, deterministic)
npm run benchmark:medium
npm run benchmark:large
```

## 🧩 Extend the crawler

### Add a new HTTP/API source

1. Add `src/sources/<name>.ts` returning `SourceResult`
2. Wire it into `src/orchestrator.ts`
3. Ensure required fields exist: `url`, `title`, `company`, `description`
4. Run `npm test` + local crawl

### Add a new headless source

1. Add selectors in `src/config/<site>.ts`
2. Add extractor in `src/extractors/<site>.ts`
3. Register handlers in `src/routes.ts`
4. Seed URLs in `src/main.ts`

## 🚢 Deployment assets

- `scripts/setup-server.sh` - full-machine bootstrap helper
- `deploy/setup.sh` - one-time service setup helper
- `deploy/deploy.sh` - update/rebuild/restart flow
- `deploy/job-crawler.service` - systemd unit template
- `deploy/env.production` - environment template

> Before running deployment scripts, review usernames, paths, service names, and environment values.

## 🛠️ Troubleshooting

- DB check fails -> verify `DATABASE_URL` / PG vars, then run `npm run db:migrate:check`
- Very low job count -> verify `SERPER_API_KEY`, inspect `storage/health-report.json`
- Frequent 403/429 -> reduce concurrency, increase delays, use better proxies
- LinkedIn returns 0 -> set `ENABLE_LINKEDIN=true` and valid `LINKEDIN_COOKIE`
- Playwright fails -> reinstall with `npx playwright install --with-deps chromium`

## 🤝 Responsible usage

- Respect target site terms and robots policies where applicable
- Keep request rates conservative
- Avoid aggressive parallelism on protected domains
- Never use personal accounts for automated scraping on risky platforms

## 📄 License

Package metadata declares `ISC` license.
