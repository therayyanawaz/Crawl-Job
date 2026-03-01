import { spawnSync } from 'node:child_process';

const subprocessCode = `
import { env } from './dist/config/env.js';
process.stdout.write(JSON.stringify(env) + '\\n');
`;

function spawnWithOverrides(overrides) {
    const envVars = { ...process.env, PATH: process.env.PATH };
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
            delete envVars[key];
            continue;
        }
        envVars[key] = value;
    }

    return spawnSync(
        process.execPath,
        ['--input-type=module', '-'],
        {
            input: subprocessCode,
            env: envVars,
            cwd: process.cwd(),
            encoding: 'utf-8',
            timeout: 10000,
        }
    );
}

const tests = [
    {
        name: 'parses valid env correctly',
        run: async () => {
            const result = spawnWithOverrides({
                PGHOST: 'db.example.net',
                PGPORT: '6543',
                PGDATABASE: 'crawl_job_test',
                ENABLE_INDEED: 'true',
                ENABLE_ALERTS: 'false',
                MIN_JOBS_BEFORE_HEADLESS: '25',
            });

            if (result.status !== 0) {
                throw new Error(`Subprocess failed (exit ${result.status}):\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`);
            }

            const parsed = JSON.parse(result.stdout.trim());
            if (parsed.PGHOST !== 'db.example.net') {
                throw new Error(`PGHOST mismatch: ${parsed.PGHOST}`);
            }
            if (parsed.PGPORT !== 6543) {
                throw new Error(`PGPORT mismatch: ${parsed.PGPORT}`);
            }
            if (parsed.PGDATABASE !== 'crawl_job_test') {
                throw new Error(`PGDATABASE mismatch: ${parsed.PGDATABASE}`);
            }
            if (parsed.ENABLE_INDEED !== true) {
                throw new Error(`ENABLE_INDEED expected true, got ${parsed.ENABLE_INDEED}`);
            }
            if (parsed.ENABLE_ALERTS !== false) {
                throw new Error(`ENABLE_ALERTS expected false, got ${parsed.ENABLE_ALERTS}`);
            }
            if (parsed.MIN_JOBS_BEFORE_HEADLESS !== 25) {
                throw new Error(`MIN_JOBS_BEFORE_HEADLESS expected 25, got ${parsed.MIN_JOBS_BEFORE_HEADLESS}`);
            }
        },
    },
    {
        name: 'uses default values for optional vars',
        run: async () => {
            const result = spawnWithOverrides({
                PGHOST: undefined,
                PGPORT: undefined,
                PGDATABASE: undefined,
                ENABLE_ALERTS: undefined,
                MIN_JOBS_BEFORE_HEADLESS: undefined,
            });

            if (result.status !== 0) {
                throw new Error(`Subprocess failed (exit ${result.status}):\nSTDERR: ${result.stderr}\nSTDOUT: ${result.stdout}`);
            }

            const parsed = JSON.parse(result.stdout.trim());
            if (parsed.PGHOST !== 'localhost') {
                throw new Error(`expected default PGHOST localhost, got ${parsed.PGHOST}`);
            }
            if (parsed.PGPORT !== 5432) {
                throw new Error(`expected default PGPORT 5432, got ${parsed.PGPORT}`);
            }
            if (parsed.PGDATABASE !== 'crawl_job') {
                throw new Error(`expected default PGDATABASE crawl_job, got ${parsed.PGDATABASE}`);
            }
            if (parsed.ENABLE_ALERTS !== true) {
                throw new Error(`expected default ENABLE_ALERTS true, got ${parsed.ENABLE_ALERTS}`);
            }
            if (parsed.MIN_JOBS_BEFORE_HEADLESS !== 15) {
                throw new Error(`expected default MIN_JOBS_BEFORE_HEADLESS 15, got ${parsed.MIN_JOBS_BEFORE_HEADLESS}`);
            }
            if (parsed.HEALTH_CHECK_INTERVAL_MS !== 300000) {
                throw new Error(`expected default HEALTH_CHECK_INTERVAL_MS 300000, got ${parsed.HEALTH_CHECK_INTERVAL_MS}`);
            }
        },
    },
    {
        name: 'throws descriptive error on missing required var',
        run: async () => {
            const result = spawnWithOverrides({
                PGPORT: 'not-a-number',
            });

            if (result.status === 0) {
                throw new Error('expected env import to fail with invalid PGPORT');
            }

            const stderr = result.stderr || '';
            if (!stderr.includes('Invalid environment variables')) {
                throw new Error('error output missing descriptive header');
            }
            if (!stderr.includes('PGPORT')) {
                throw new Error('error message missing PGPORT reference');
            }
        },
    },
];

export default tests;
