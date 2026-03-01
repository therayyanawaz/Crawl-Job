import { z } from 'zod';
import * as path from 'path';

const boolStrictTrue = z.preprocess((v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
    return v;
}, z.boolean());

const boolUnlessFalse = z.preprocess((v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'string') return v.trim().toLowerCase() !== 'false';
    return v;
}, z.boolean());

const numFromEnv = z.preprocess((v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'string') return Number(v);
    return v;
}, z.number().finite());

const numOrNullFromTruthy = z.preprocess((v) => {
    if (v === undefined) return null;
    if (typeof v === 'string') return v ? Number(v) : null;
    return v;
}, z.number().finite().nullable());

const searchQueriesJson = z
    .string()
    .optional()
    .superRefine((val, ctx) => {
        if (!val) return;
        try {
            const parsed = JSON.parse(val);
            if (!Array.isArray(parsed)) {
                ctx.addIssue({ code: 'custom', message: 'Expected a JSON array' });
            }
        } catch {
            ctx.addIssue({ code: 'custom', message: 'Invalid JSON (expected a JSON array)' });
        }
    });

export const envSchema = z.object({
    DATABASE_URL: z.string().optional(),
    PGHOST: z.string().default('localhost'),
    PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
    PGUSER: z.string().optional(),
    PGPASSWORD: z.string().optional(),
    PGDATABASE: z.string().default('crawl_job'),
    PGSSL: boolStrictTrue.default(false),
    PG_POOL_MAX: numFromEnv.default(10),

    PROXY_URLS: z.string().default(''),
    PROXY_MIN_COUNT: numFromEnv.default(5),
    PROXY_REFRESH_INTERVAL_MINUTES: numFromEnv.default(15),

    MIN_JOBS_BEFORE_HEADLESS: numFromEnv.default(15),
    HEADLESS_MAX_CONCURRENCY: numFromEnv.default(5),
    ENABLE_DOMAIN_RATE_LIMITING: boolUnlessFalse.default(true),
    ENABLE_INDEED: boolStrictTrue.default(false),
    ENABLE_LINKEDIN: boolStrictTrue.default(false),
    LINKEDIN_COOKIE: z.string().optional(),
    SEARCH_QUERIES: searchQueriesJson,

    BASE_DELAY_MS: numOrNullFromTruthy.default(null),
    RANDOM_DELAY_RANGE_MS: numOrNullFromTruthy.default(null),
    OFF_HOURS_START: numFromEnv.default(22),
    OFF_HOURS_END: numFromEnv.default(6),
    RATE_LIMIT_BACKOFF_MULTIPLIER: numFromEnv.optional(),
    MAX_BACKOFF_ATTEMPTS: numFromEnv.default(5),

    DEDUP_ENABLED: boolUnlessFalse.default(true),
    DEDUP_LOG_SKIPPED: boolUnlessFalse.default(true),
    DEDUP_RETENTION_DAYS: numFromEnv.default(30),
    ARCHIVE_AFTER_DAYS: numFromEnv.default(7),
    DELETE_AFTER_DAYS: numFromEnv.default(90),
    HEALTH_CHECK_INTERVAL_MS: numFromEnv.default(5 * 60_000),

    SERPER_API_KEY: z.string().default('03a6a5832aa7008001fd5dbaff3de09eea0d4ac2'),

    CLOUD_UPLOAD_ENABLED: boolStrictTrue.default(false),
    CRAWLEE_STORAGE_DIR: z.string().default(path.join(process.cwd(), 'storage')),
    S3_BUCKET: z.string().default(''),
    S3_REGION: z.string().default('ap-south-1'),
    S3_ACCESS_KEY: z.string().default(''),
    S3_SECRET_KEY: z.string().default(''),
    S3_ENDPOINT: z.string().default(''),

    OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
    OLLAMA_MODEL: z.string().default('qwen2.5:32b-instruct-q8_0'),
    OLLAMA_TIMEOUT_MS: numFromEnv.default(120000),
    OLLAMA_TEMPERATURE: numFromEnv.default(0),
    OLLAMA_MAX_TOKENS: numFromEnv.default(4096),

    ALERT_SLACK_WEBHOOK: z.string().default(''),
    ALERT_WEBHOOK_URL: z.string().default(''),
    ALERT_EMAIL: z.string().default(''),
    ALERT_COOLDOWN_MIN: numFromEnv.default(15),
    ENABLE_ALERTS: boolUnlessFalse.default(true),

    HEALTH_FAILURE_RATE_WARN_PCT: numFromEnv.default(70),
    HEALTH_FAILURE_RATE_CRIT_PCT: numFromEnv.default(40),
    HEALTH_NO_PROGRESS_WARN_MIN: numFromEnv.default(20),
    HEALTH_NO_PROGRESS_CRIT_MIN: numFromEnv.default(45),
    HEALTH_MEMORY_WARN_MB: numFromEnv.default(2500),
    HEALTH_MEMORY_CRIT_MB: numFromEnv.default(3500),
    HEALTH_RATE_LIMIT_WARN_COUNT: numFromEnv.default(10),
    HEALTH_RATE_LIMIT_CRIT_COUNT: numFromEnv.default(30),
    HEALTH_PROXY_FAIL_WARN_COUNT: numFromEnv.default(5),
    HEALTH_PROXY_FAIL_CRIT_COUNT: numFromEnv.default(20),
    HEALTH_ZERO_JOBS_AFTER_MIN: numFromEnv.default(10),

    CRAWLEE_LOG_LEVEL: z.string().default(''),
    METRICS_FLUSH_INTERVAL_MS: numFromEnv.default(120_000),
}).passthrough();

export type Env = z.infer<typeof envSchema>;
