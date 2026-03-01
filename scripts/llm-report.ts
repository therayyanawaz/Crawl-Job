import { existsSync, readdirSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { getDailySpend } from '../src/utils/costGuard.js';
import { getCacheStats } from '../src/utils/llmCache.js';
import { loadLLMConfig } from '../src/utils/modelSelectBridge.js';

const BOX_WIDTH = 54;
const INNER_WIDTH = BOX_WIDTH - 4;

function center(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }

  const pad = width - value.length;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return `${' '.repeat(left)}${value}${' '.repeat(right)}`;
}

function boxLine(content = ''): string {
  const text = content.length > INNER_WIDTH ? content.slice(0, INNER_WIDTH) : content;
  return `║ ${text.padEnd(INNER_WIDTH, ' ')} ║`;
}

function formatMoney(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatMask(apiKey: string | null): string {
  if (!apiKey) {
    return 'not required';
  }
  return `****${apiKey.slice(-4)}`;
}

function printReport(): void {
  const envPath = path.join(process.cwd(), '.env.modelselect');
  const hasModelSelectConfig = existsSync(envPath);
  const config = loadLLMConfig();

  const cacheDir = path.join(process.cwd(), 'storage', 'llm-cache');
  const cacheFiles = existsSync(cacheDir)
    ? readdirSync(cacheDir).filter((f) => f.endsWith('.json')).length
    : 0;
  const cacheStats = getCacheStats();

  const dailyLimitUSD = Number.parseFloat(process.env.LLM_DAILY_BUDGET_USD ?? '1.00');
  const spend = getDailySpend(config.provider);
  const budgetLeft = Math.max(dailyLimitUSD - spend.costUSD, 0);
  const budgetPercent = dailyLimitUSD > 0
    ? (spend.costUSD / dailyLimitUSD) * 100
    : 0;

  const providerValue = hasModelSelectConfig
    ? config.provider
    : 'No provider configured — run npm run setup';
  const modelValue = hasModelSelectConfig ? config.modelId : 'N/A';
  const keyValue = hasModelSelectConfig ? formatMask(config.apiKey) : 'N/A';
  const fallbackValue = hasModelSelectConfig
    ? (config.fallback?.modelId ?? 'None configured')
    : 'None configured';

  const today = new Date().toISOString().slice(0, 10);

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log(boxLine(center('Crawl-Job LLM Daily Report', INNER_WIDTH)));
  console.log(boxLine(center(`${today}  (today's date)`, INNER_WIDTH)));
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(boxLine(`Provider     : ${providerValue}`));
  console.log(boxLine(`Model        : ${modelValue}`));
  console.log(boxLine(`API Key      : ${keyValue}`));
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(boxLine('COST & USAGE'));
  console.log(boxLine(`Tokens used  : ${spend.tokens.toLocaleString()}`));
  console.log(boxLine(`Est. cost    : ${formatMoney(spend.costUSD)} / $${dailyLimitUSD.toFixed(2)} daily limit`));
  console.log(boxLine(`Budget left  : ${formatMoney(budgetLeft)} (${Math.max(0, 100 - budgetPercent).toFixed(1)}%)`));
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(boxLine('CACHE'));
  console.log(boxLine(`Cached pages : ${cacheStats.entries.toLocaleString()} entries  (${cacheStats.sizeKB.toLocaleString()} KB)`));
  console.log(boxLine(`Cache files  : ${cacheFiles.toLocaleString()} files`));
  console.log(boxLine('Cache dir    : storage/llm-cache/'));
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(boxLine('FALLBACK'));
  console.log(boxLine(`Fallback set : ${fallbackValue}`));
  console.log('╚══════════════════════════════════════════════════════╝');

  if (!hasModelSelectConfig) {
    console.log('[LLMReport] No provider configured — run npm run setup');
  }

  if (dailyLimitUSD > 0 && spend.costUSD >= dailyLimitUSD) {
    console.log(chalk.red('🚫 Budget exceeded. LLM extraction is currently paused.'));
  } else if (dailyLimitUSD > 0 && budgetPercent >= 80) {
    console.log(chalk.yellow('⚠  Warning: 80%+ of daily budget consumed. Consider increasing LLM_DAILY_BUDGET_USD.'));
  }
}

try {
  printReport();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[LLMReport] Failed to render report: ${message}`);
  process.exit(1);
}
