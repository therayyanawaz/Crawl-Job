import { initDedupStore, closeDedupStore, clearDedupStore } from '../dist/utils/dedupStore.js';
import { existsSync, readdirSync } from 'node:fs';

const tests = [];

export function test(name, fn) {
    tests.push({ name, fn });
}

export async function runTests() {
    let failures = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`PASS: ${name}`);
        } catch (err) {
            failures += 1;
            console.error(`FAIL: ${name}`);
            console.error(err?.stack ?? err);
        }
    }
    if (failures > 0) {
        throw new Error(`${failures} test(s) failed`);
    }
}

export { initDedupStore, closeDedupStore, clearDedupStore };

export async function selfTest() {
    const issues = [];
    if (!existsSync('dist/main.js')) {
        issues.push('dist/main.js missing – run npm run build first');
    }
    const fixturesDir = 'tests/fixtures';
    if (existsSync(fixturesDir)) {
        const entries = readdirSync(fixturesDir);
        if (entries.length === 0) {
            issues.push('tests/fixtures exists but is empty (expect at least one fixture file)');
        }
    }
    const requiredDbVars = ['PGHOST', 'PGPORT', 'PGDATABASE'];
    for (const key of requiredDbVars) {
        if (!process.env[key]) {
            issues.push(`missing DB env var: ${key}`);
        }
    }
    return {
        ok: issues.length === 0,
        issues,
    };
}
