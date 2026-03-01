import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const BUDGET_FILE = path.join(process.cwd(), 'storage', 'cost-guard.json');

const COST_PER_1M_TOKENS: Record<string, number> = {
    anthropic: 10.0,
    openai: 12.0,
    google: 3.5,
    groq: 0.27,
    cerebras: 0.6,
    openrouter: 5.0,
    mistral: 8.0,
    xai: 5.0,
    zai: 3.0,
    moonshot: 3.0,
    ollama: 0,
    lmstudio: 0,
    default: 5.0,
};

interface BudgetState {
    date: string;
    totalTokens: number;
    estimatedCostUSD: number;
    provider: string;
}

function getTodayKey(): string {
    return new Date().toISOString().slice(0, 10);
}

function loadState(provider: string): BudgetState {
    if (existsSync(BUDGET_FILE)) {
        try {
            const state = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as BudgetState;
            if (state.date === getTodayKey() && state.provider === provider) {
                return state;
            }
        } catch {
            // ignore
        }
    }

    return { date: getTodayKey(), totalTokens: 0, estimatedCostUSD: 0, provider };
}

function saveState(state: BudgetState): void {
    const dir = path.dirname(BUDGET_FILE);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    writeFileSync(BUDGET_FILE, JSON.stringify(state, null, 2));
}

export function recordTokenUsage(provider: string, totalTokens: number): void {
    const state = loadState(provider);
    const ratePerToken = (COST_PER_1M_TOKENS[provider] ?? COST_PER_1M_TOKENS.default) / 1_000_000;
    state.totalTokens += totalTokens;
    state.estimatedCostUSD += totalTokens * ratePerToken;
    saveState(state);
}

export function isBudgetExceeded(provider: string): boolean {
    const dailyLimitUSD = Number.parseFloat(process.env.LLM_DAILY_BUDGET_USD ?? '1.00');
    if (dailyLimitUSD <= 0) {
        return false;
    }

    const state = loadState(provider);
    if (state.estimatedCostUSD >= dailyLimitUSD) {
        console.warn(
            `[CostGuard] 🚫 Daily budget exceeded for ${provider}. ` +
            `Spent: $${state.estimatedCostUSD.toFixed(4)} / Limit: $${dailyLimitUSD.toFixed(2)}. ` +
            'LLM extraction paused for today. Set LLM_DAILY_BUDGET_USD in .env to adjust.'
        );
        return true;
    }

    return false;
}

export function getDailySpend(provider: string): { tokens: number; costUSD: number } {
    const state = loadState(provider);
    return { tokens: state.totalTokens, costUSD: state.estimatedCostUSD };
}
