import { existsSync } from 'fs';
import path from 'path';
import { loadLLMConfig } from '../src/utils/modelSelectBridge.js';
import { checkLLMHealth, extractJobsFromHtml } from '../src/services/llmExtractor.js';
import { getDailySpend } from '../src/utils/costGuard.js';

const MINIMAL_JOB_HTML = `
<div class="job-card">
  <h2>Junior Software Engineer</h2>
  <p class="company">TechCorp India</p>
  <p class="location">Bangalore, India</p>
  <p class="experience">0-1 years / Fresher</p>
  <p class="type">Full Time</p>
  <a href="/jobs/junior-swe-123">Apply Now</a>
  <p class="desc">Join our team as a fresher and work on exciting projects.</p>
</div>
`;

function maskKey(key: string | null): string {
  if (!key) {
    return 'not required';
  }

  const visible = key.slice(-4);
  return `****${visible}`;
}

function fail(reason: string): never {
  console.error(`[SmokeTest] ❌ FAILED: ${reason}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const envPath = path.join(process.cwd(), '.env.modelselect');
  if (!existsSync(envPath)) {
    console.error('[SmokeTest] ❌ FAILED: Missing .env.modelselect configuration file.');
    console.info('[SmokeTest] Run `npm run setup` to configure a provider, then rerun this smoke test.');
    process.exit(1);
  }

  const config = loadLLMConfig();
  console.info('[SmokeTest] Resolved LLM configuration:');
  console.info(`  Provider : ${config.provider}`);
  console.info(`  Model ID : ${config.modelId}`);
  console.info(`  Format   : ${config.apiFormat}`);
  console.info(`  API Key  : ${maskKey(config.apiKey)}`);

  const healthy = await checkLLMHealth(config);
  if (!healthy) {
    console.error('[SmokeTest] ❌ FAILED: LLM health check failed. Provider is not reachable.');
    process.exit(1);
  }

  const result = await extractJobsFromHtml(
    MINIMAL_JOB_HTML,
    'https://example.com/jobs',
    'SMOKE_TEST'
  );

  console.info('[SmokeTest] Extraction result:');
  console.log(JSON.stringify(result, null, 2));

  if (!Array.isArray(result)) {
    fail('Result is not an array.');
  }

  if (result.length === 0) {
    fail('Result array is empty.');
  }

  const first = result[0];
  if (!first) {
    fail('First record is missing.');
  }

  if (typeof first.title !== 'string' || first.title.trim().length === 0) {
    fail('First record has empty title.');
  }

  if (first.isFresher !== true) {
    fail('First record isFresher is not true.');
  }

  if (first.experienceNormalized !== 'Fresher' && first.experienceNormalized !== '0-1 years') {
    fail('First record experienceNormalized is neither "Fresher" nor "0-1 years".');
  }

  const spend = getDailySpend(config.provider);
  console.info(
    `[SmokeTest] Daily usage for ${config.provider}: ` +
    `${spend.tokens.toLocaleString()} tokens, $${spend.costUSD.toFixed(4)} estimated.`
  );

  console.info(`[SmokeTest] ✅ PASSED — extracted ${result.length} job(s) from smoke HTML`);
  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[SmokeTest] ❌ FAILED: ${message}`);
  process.exit(1);
});
