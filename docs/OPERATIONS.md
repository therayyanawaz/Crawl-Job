# Operations Runbook

This guide covers day-to-day operation of `crawl-job` in local and server environments.

## 1. Common Runtime Commands

### Start

```bash
npm start
```

### Start (verbose)

```bash
npm run start:verbose
```

### Build and run compiled output

```bash
npm run build
npm run start:prod
```

### Type-check

```bash
npm run typecheck
```

### Validate required environment variables

```bash
npm run env:check
```

## 2. Database Operations

### Run migration

```bash
npm run db:migrate
```

### Connectivity check

```bash
npm run db:migrate:check
```

## 3. Maintenance Lifecycle

Maintenance CLI entrypoint: `src/maintenance.ts`.

### Archive old dataset shards

```bash
npm run archive
npm run archive -- --days 14
npm run archive:preview
```

### Upload pending archives

```bash
npm run upload
```

Requires:

- `CLOUD_UPLOAD_ENABLED=true`
- `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
- optional `S3_ENDPOINT` for non-AWS targets

### Cleanup old archives

```bash
npm run cleanup
npm run cleanup:preview
```

### Full maintenance cycle

```bash
npm run maintenance
npm run maintenance:dry
```

### Storage and archive inventory

```bash
npm run archive:status
```

## 4. Export Data

```bash
npm run export
```

Output: `jobs_export.csv`.

## 5. Test Execution

```bash
npm test
npm run test:verbose
npm run test:fast
npm run test:watch
```

Notes:

- tests run against `dist/` artifacts
- `npm test` includes build step automatically

## 6. Runtime Artifacts to Monitor

- `log.txt`
- `storage/metrics-snapshot.json`
- `storage/health-report.json`
- `storage/rate-limit-report.json`
- `storage/dedup-store.json`

## 7. Health and Alerting

Health report severity values:

- `healthy`
- `degraded`
- `critical`

Alert channels supported by built-in dispatcher:

- Slack webhook (`ALERT_SLACK_WEBHOOK`)
- generic webhook (`ALERT_WEBHOOK_URL`)
- email (`ALERT_EMAIL`, requires local mail tooling)

Cooldown control: `ALERT_COOLDOWN_MIN`.

## 8. Proxy Operations

Startup flow:

1. parse manual proxies from `PROXY_URLS`
2. validate manual proxies
3. top up with free proxy sources if under `PROXY_MIN_COUNT`
4. fail fast if still below minimum

During headless run:

- periodic revalidation and replenishment via interval timer

## 9. Production Deployment Assets

### Server Bootstrap

- `deploy/setup.sh` - one-time setup script for Linux server + systemd
- `scripts/setup-server.sh` - broader setup path including PostgreSQL and Playwright deps
- `docs/FIRST_RUN.md` - exact first-run checklist for local/server setup

### Deployment Updates

- `deploy/deploy.sh` - pull/build/restart flow for service user

### Service Unit

- `deploy/crawl-job.service` - systemd unit template
- `deploy/env.production` - production env template

## 10. Recovery and Troubleshooting Playbook

### Process starts but zero jobs are stored

- inspect `storage/health-report.json`
- inspect `storage/metrics-snapshot.json`
- verify `SERPER_API_KEY`
- check if seed URLs are blocked in your network/proxy region

### Frequent `429`/`403` events

- reduce `HEADLESS_MAX_CONCURRENCY`
- increase delays via `BASE_DELAY_MS` / `RANDOM_DELAY_RANGE_MS`
- verify proxy quality and region
- evaluate paid proxy mode

### DB insert failures

- run `npm run db:migrate:check`
- verify DB credentials and network policy
- inspect logs for `saveJobToDb` errors

### High memory pressure

- lower concurrency
- reduce enabled headless sites
- increase host memory limits

### Archive upload not progressing

- verify `CLOUD_UPLOAD_ENABLED=true`
- verify S3 credentials and endpoint
- inspect per-archive manifest files for `uploadedAt`

## 11. Safe Change Management

Before changing extraction logic or rate policies:

1. run `npm run typecheck`
2. run `npm test`
3. run `npm run archive:preview` and `npm run cleanup:preview` if changing maintenance code
4. validate with `npm run start:verbose` in a short controlled run
