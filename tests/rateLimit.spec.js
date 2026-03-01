import { detectRateLimitByStatus, getBackoffDelay } from '../dist/utils/rateLimitHandler.js';
import { getRateLimitConfig } from '../dist/config/rateLimits.js';
import { readFileSync } from 'node:fs';

const testCases = [
    {
        name: 'detectRateLimitByStatus flags 429 responses',
        run: async () => {
            const response = { status: () => 429 };
            if (!detectRateLimitByStatus(response)) {
                throw new Error('expected 429 to be treated as rate limit');
            }
        },
    },
    {
        name: 'detectRateLimitByStatus ignores 200 responses',
        run: async () => {
            const response = { status: () => 200 };
            if (detectRateLimitByStatus(response)) {
                throw new Error('200 responses should not be considered rate limited');
            }
        },
    },
    {
        name: 'getRateLimitConfig provides fallback for unknown domains',
        run: async () => {
            const config = getRateLimitConfig('https://custom.example.com/api');
            if (config.domain !== 'custom.example.com') {
                throw new Error(`expected domain to be cleaned, got ${config.domain}`);
            }
            if (config.maxRequestsPerMinute !== 10) {
                throw new Error('unexpected maxRequestsPerMinute for default config');
            }
        },
    },
    {
        name: 'getBackoffDelay respects multiplier and jitter floor',
        run: async () => {
            const originalRandom = Math.random;
            const originalEnv = process.env.RATE_LIMIT_BACKOFF_MULTIPLIER;
            Math.random = () => 0;
            process.env.RATE_LIMIT_BACKOFF_MULTIPLIER = '1';
            try {
                const delay = getBackoffDelay(1, 'linkedin.com');
                if (delay !== 30000) {
                    throw new Error(`expected backoff delay 30000ms, got ${delay}`);
                }
            } finally {
                Math.random = originalRandom;
                if (originalEnv !== undefined) {
                    process.env.RATE_LIMIT_BACKOFF_MULTIPLIER = originalEnv;
                } else {
                    delete process.env.RATE_LIMIT_BACKOFF_MULTIPLIER;
                }
            }
        },
    },
    {
        name: '429 failedRequestHandler path uses handleViolation as the only backoff sleep authority',
        run: async () => {
            const source = readFileSync('src/main.ts', 'utf-8');
            const branchMatch = source.match(/if\s*\(status\s*===\s*429\)\s*\{([\s\S]*?)\n\s*\}/);
            if (!branchMatch) {
                throw new Error('could not locate 429 failedRequestHandler branch');
            }

            const branchBody = branchMatch[1];
            if (!branchBody.includes('await handleViolation(')) {
                throw new Error('expected 429 path to call handleViolation');
            }
            if (branchBody.includes('await sleep(')) {
                throw new Error('429 path should not have an extra local sleep after handleViolation');
            }
        },
    },
];

export default testCases;
