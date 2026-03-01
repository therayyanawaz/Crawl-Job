import { existsSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class SkipError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'SkipError';
    }
}

const distGuard = join(process.cwd(), 'dist', 'main.js');
if (!existsSync(distGuard)) {
    console.error('⚠ dist/ not found. Run: npm run build first, or use npm test');
    process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const specsDir = dirname(__filename);
const specFiles = readdirSync(specsDir)
    .filter((file) => file.endsWith('.spec.js'))
    .sort();
const verbose = process.argv.includes('--verbose');
if (verbose) {
    console.log(`[runner] scanning: ${specsDir}`);
}
let passed = 0;
let failed = 0;
let skipped = 0;
let totalDuration = 0;

for (const file of specFiles) {
    const suite = file.replace(/\.spec\.js$/, '');
    const specPath = join(specsDir, file);
    const module = await import(pathToFileURL(specPath).href);
    const testCases = Array.isArray(module?.default) ? module.default : [];

    for (const testCase of testCases) {
        const name = testCase.name ?? 'unnamed test';
        const label = `[${suite}] ${name}`;
        const start = performance.now();
        try {
            await testCase.run();
            const durationMs = Math.max(0, Math.round(performance.now() - start));
            totalDuration += durationMs;
            passed += 1;
            console.log(`✓ ${label} (${durationMs}ms)`);
        } catch (err) {
            const durationMs = Math.max(0, Math.round(performance.now() - start));
            totalDuration += durationMs;
            if (err instanceof SkipError) {
                skipped += 1;
                const reason = err.message ? `: ${err.message}` : '';
                console.log(`↷ ${label} — skipped${reason} (${durationMs}ms)`);
                continue;
            }

            failed += 1;
            const message = err?.message ?? String(err);
            console.log(`✗ ${label} — ${message}`);
            if (verbose && err?.stack) {
                console.log(err.stack);
            }
        }
    }
}

console.log('');
console.log(`Results: ${passed} passed | ${failed} failed | ${skipped} skipped — ${totalDuration}ms total`);
process.exit(failed > 0 ? 1 : 0);
