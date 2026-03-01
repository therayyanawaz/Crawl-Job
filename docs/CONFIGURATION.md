# Configuration Reference

This is the full runtime environment reference for `crawl-job`.

## Parsing Rules

Two boolean parsing modes exist in `src/config/envSchema.ts`:

- strict-true booleans: only the exact string `"true"` becomes `true`; everything else is `false`.
- unless-false booleans: any value except exact `"false"` becomes `true`.

Use `.env.example` as a ready-to-copy template.

## Database

| Variable | Type | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | string | unset | Full connection string. If set, it takes precedence over individual `PG*` values. |
| `PGHOST` | string | `localhost` | DB host when `DATABASE_URL` is not used. |
| `PGPORT` | integer | `5432` | DB port. |
| `PGUSER` | string | unset | DB user. |
| `PGPASSWORD` | string | unset | DB password. |
| `PGDATABASE` | string | `crawl_job` | DB name. |
| `PGSSL` | boolean (strict-true) | `false` | Enable TLS for DB connection. |
| `PG_POOL_MAX` | number | `10` | Max pooled DB connections. |

## Proxy and Headless Control

| Variable | Type | Default | Notes |
|---|---|---|---|
| `PROXY_URLS` | string | `""` | Comma-separated proxy URLs. |
| `PROXY_MIN_COUNT` | number | `5` | Required validated proxies before run continues. |
| `PROXY_REFRESH_INTERVAL_MINUTES` | number | `15` | Pool revalidation interval. |
| `MIN_JOBS_BEFORE_HEADLESS` | number | `15` | If stored jobs below this threshold, headless activates (unless paid mode already active). |
| `HEADLESS_MAX_CONCURRENCY` | number | `5` | Upper cap for headless crawler concurrency. |
| `ENABLE_DOMAIN_RATE_LIMITING` | boolean (unless-false) | `true` | Enable domain queue gate and dynamic delays. |
| `ENABLE_INDEED` | boolean (strict-true) | `false` | Enable Indeed headless routes and seeds. |
| `ENABLE_LINKEDIN` | boolean (strict-true) | `false` | Enable LinkedIn headless routes and seeds. |
| `LINKEDIN_COOKIE` | string | unset | Optional cookie for LinkedIn access behavior. |
| `SEARCH_QUERIES` | JSON string | unset | JSON array of query objects (`keywords`, optional `location`, optional `maxResults`). |

## Rate and Backoff Tuning

| Variable | Type | Default | Notes |
|---|---|---|---|
| `BASE_DELAY_MS` | number or null | `null` | Global override for domain base delay. |
| `RANDOM_DELAY_RANGE_MS` | number or null | `null` | Global override for delay jitter range. |
| `OFF_HOURS_START` | number | `22` | IST off-hours start. |
| `OFF_HOURS_END` | number | `6` | IST off-hours end. |
| `RATE_LIMIT_BACKOFF_MULTIPLIER` | number | unset | Global override for exponential backoff multiplier. |
| `MAX_BACKOFF_ATTEMPTS` | number | `5` | Cap for per-domain backoff attempt count. |

## Dedup and Retention

| Variable | Type | Default | Notes |
|---|---|---|---|
| `DEDUP_ENABLED` | boolean (unless-false) | `true` | Toggle app-level dedup logic. |
| `DEDUP_LOG_SKIPPED` | boolean (unless-false) | `true` | Toggle duplicate skip logging. |
| `DEDUP_RETENTION_DAYS` | number | `30` | Retention for dedup fingerprints. |
| `ARCHIVE_AFTER_DAYS` | number | `7` | Age threshold to archive dataset shards. |
| `DELETE_AFTER_DAYS` | number | `90` | Age threshold to cleanup local archives. |
| `HEALTH_CHECK_INTERVAL_MS` | number | `300000` | Health check timer interval. |

## Source API

| Variable | Type | Default | Notes |
|---|---|---|---|
| `SERPER_API_KEY` | string | baked-in fallback present | Set your own key for production use. |

## Storage and Cloud Upload

| Variable | Type | Default | Notes |
|---|---|---|---|
| `CLOUD_UPLOAD_ENABLED` | boolean (strict-true) | `false` | Enable archive upload flow. |
| `CRAWLEE_STORAGE_DIR` | string | `<cwd>/storage` | Crawlee storage root. |
| `S3_BUCKET` | string | `""` | S3-compatible bucket/container name. |
| `S3_REGION` | string | `ap-south-1` | Region for SigV4 signing. |
| `S3_ACCESS_KEY` | string | `""` | Access key for upload target. |
| `S3_SECRET_KEY` | string | `""` | Secret key for upload target. |
| `S3_ENDPOINT` | string | `""` | Optional endpoint for non-AWS targets (R2/MinIO/Spaces/etc.). |

## Ollama

| Variable | Type | Default | Notes |
|---|---|---|---|
| `OLLAMA_BASE_URL` | string | `http://localhost:11434` | Base URL of local/remote Ollama. |
| `OLLAMA_MODEL` | string | `qwen2.5:32b-instruct-q8_0` | Model used for extraction. |
| `OLLAMA_TIMEOUT_MS` | number | `120000` | Request timeout for LLM calls. |
| `OLLAMA_TEMPERATURE` | number | `0` | Model temperature. |
| `OLLAMA_MAX_TOKENS` | number | `4096` | Max generated tokens. |

## Alerts

| Variable | Type | Default | Notes |
|---|---|---|---|
| `ALERT_SLACK_WEBHOOK` | string | `""` | Slack incoming webhook URL. |
| `ALERT_WEBHOOK_URL` | string | `""` | Generic webhook endpoint. |
| `ALERT_EMAIL` | string | `""` | Email recipient (requires local MTA tooling). |
| `ALERT_COOLDOWN_MIN` | number | `15` | Cooldown per channel+severity pair. |
| `ENABLE_ALERTS` | boolean (unless-false) | `true` | Master alert toggle. |

## Health Thresholds

| Variable | Type | Default | Notes |
|---|---|---|---|
| `HEALTH_FAILURE_RATE_WARN_PCT` | number | `70` | Warning threshold for success rate percentage. |
| `HEALTH_FAILURE_RATE_CRIT_PCT` | number | `40` | Critical threshold for success rate percentage. |
| `HEALTH_NO_PROGRESS_WARN_MIN` | number | `20` | Warning threshold for minutes without extracted jobs. |
| `HEALTH_NO_PROGRESS_CRIT_MIN` | number | `45` | Critical threshold for minutes without extracted jobs. |
| `HEALTH_MEMORY_WARN_MB` | number | `2500` | Warning memory RSS threshold. |
| `HEALTH_MEMORY_CRIT_MB` | number | `3500` | Critical memory RSS threshold. |
| `HEALTH_RATE_LIMIT_WARN_COUNT` | number | `10` | Warning count for rate-limit hits. |
| `HEALTH_RATE_LIMIT_CRIT_COUNT` | number | `30` | Critical count for rate-limit hits. |
| `HEALTH_PROXY_FAIL_WARN_COUNT` | number | `5` | Warning count for proxy failures. |
| `HEALTH_PROXY_FAIL_CRIT_COUNT` | number | `20` | Critical count for proxy failures. |
| `HEALTH_ZERO_JOBS_AFTER_MIN` | number | `10` | Warning if zero extracted jobs after this many minutes. |

## Logging and Metrics

| Variable | Type | Default | Notes |
|---|---|---|---|
| `CRAWLEE_LOG_LEVEL` | string | `""` | Crawlee log level (effective default behavior resolves to `INFO`). |
| `METRICS_FLUSH_INTERVAL_MS` | number | `120000` | Metrics snapshot flush interval. |

## Recommended Minimal `.env` for Local Runs

```bash
DATABASE_URL=postgresql://postgres:password@localhost:5432/crawl_job
SERPER_API_KEY=your_real_key
PROXY_URLS=
ENABLE_DOMAIN_RATE_LIMITING=true
```

If you are not using PostgreSQL immediately, the crawler can still run with local dataset storage, but DB-backed querying and persistence benefits are lost.
