import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface LLMProviderConfig {
    provider: string;
    modelId: string;
    modelName: string;
    apiKey: string | null;
    baseUrl: string;
    apiFormat: 'openai' | 'anthropic' | 'ollama' | 'gemini';
    authHeader: string | null;
    extraHeaders: Record<string, string>;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
}

type ProviderConfigShape = Omit<
    LLMProviderConfig,
    'provider' | 'modelId' | 'modelName' | 'apiKey' | 'timeoutMs' | 'temperature' | 'maxTokens'
>;

const PROVIDER_MAP: Record<string, ProviderConfigShape> = {
    anthropic: {
        baseUrl: 'https://api.anthropic.com',
        apiFormat: 'anthropic',
        authHeader: 'x-api-key',
        extraHeaders: { 'anthropic-version': '2023-06-01' },
    },
    openai: {
        baseUrl: 'https://api.openai.com',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    'openai-codex': {
        baseUrl: 'https://api.openai.com',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    google: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiFormat: 'gemini',
        authHeader: null,
        extraHeaders: {},
    },
    zai: {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    moonshot: {
        baseUrl: 'https://api.moonshot.ai/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    'kimi-coding': {
        baseUrl: 'https://api.moonshot.ai/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    xai: {
        baseUrl: 'https://api.x.ai/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    mistral: {
        baseUrl: 'https://api.mistral.ai/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    deepseek: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    minimax: {
        baseUrl: 'https://api.minimax.io/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    groq: {
        baseUrl: 'https://api.groq.com/openai/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    cerebras: {
        baseUrl: 'https://api.cerebras.ai/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    openrouter: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {
            'HTTP-Referer': 'https://github.com/therayyanawaz/Crawl-Job',
            'X-Title': 'Crawl-Job',
        },
    },
    kilocode: {
        baseUrl: 'https://api.kilocode.ai/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    'github-copilot': {
        baseUrl: 'https://api.githubcopilot.com',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: { 'Copilot-Integration-Id': 'vscode-chat' },
    },
    huggingface: {
        baseUrl: 'https://api-inference.huggingface.co/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    ollama: {
        baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
        apiFormat: 'ollama',
        authHeader: null,
        extraHeaders: {},
    },
    lmstudio: {
        baseUrl: 'http://localhost:1234/v1',
        apiFormat: 'openai',
        authHeader: null,
        extraHeaders: {},
    },
    volcengine: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    byteplus: {
        baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
    synthetic: {
        baseUrl: 'https://api-inference.huggingface.co/v1',
        apiFormat: 'openai',
        authHeader: 'Authorization',
        extraHeaders: {},
    },
};

export function loadLLMConfig(): LLMProviderConfig {
    const envFilePath = path.join(process.cwd(), '.env.modelselect');

    if (existsSync(envFilePath)) {
        const raw = readFileSync(envFilePath, 'utf8');
        const parsed = parseEnvFile(raw);

        const fullModelId = parsed.MODEL_ID;
        if (fullModelId) {
            return buildConfig(fullModelId, parsed);
        }
    }

    const ollamaModel = process.env.OLLAMA_MODEL ?? 'qwen2.5:32b-instruct-q8_0';
    return buildConfig(`ollama/${ollamaModel}`, {});
}

function parseEnvFile(content: string): Record<string, string> {
    const result: Record<string, string> = {};

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) {
            continue;
        }

        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        result[key] = value;
    }

    return result;
}

function buildConfig(fullModelId: string, envVars: Record<string, string>): LLMProviderConfig {
    const parts = fullModelId.split('/');
    const provider = parts[0] ?? 'ollama';
    const modelName = parts.slice(1).join('/') || 'llama3.3';

    const providerDef = PROVIDER_MAP[provider];
    if (!providerDef) {
        console.warn(`[ModelSelectBridge] Unknown provider "${provider}" — falling back to Ollama`);
        return buildConfig(`ollama/${modelName || 'llama3.3'}`, envVars);
    }

    const providerEnvVar = getEnvVarName(provider);
    const requiresApiKey = providerDef.authHeader !== null || providerDef.apiFormat === 'gemini';

    let apiKey: string | null = null;
    if (requiresApiKey) {
        const keyFromEnvFile = Object.entries(envVars)
            .filter(([k]) => k !== 'MODEL_ID')
            .map(([, v]) => v)
            .find((v) => Boolean(v && v.length > 0)) ?? null;

        apiKey = keyFromEnvFile ?? process.env[providerEnvVar] ?? null;
    }

    let baseUrl = providerDef.baseUrl;
    if (provider === 'ollama') {
        baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    }

    return {
        provider,
        modelId: fullModelId,
        modelName,
        apiKey,
        baseUrl,
        apiFormat: providerDef.apiFormat,
        authHeader: providerDef.authHeader,
        extraHeaders: providerDef.extraHeaders,
        timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? process.env.OLLAMA_TIMEOUT_MS ?? 120000),
        temperature: Number(process.env.LLM_TEMPERATURE ?? process.env.OLLAMA_TEMPERATURE ?? 0),
        maxTokens: Number(process.env.LLM_MAX_TOKENS ?? process.env.OLLAMA_MAX_TOKENS ?? 4096),
    };
}

function getEnvVarName(provider: string): string {
    const map: Record<string, string> = {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        'openai-codex': 'OPENAI_API_KEY',
        google: 'GEMINI_API_KEY',
        zai: 'ZAI_API_KEY',
        moonshot: 'MOONSHOT_API_KEY',
        'kimi-coding': 'MOONSHOT_API_KEY',
        xai: 'XAI_API_KEY',
        mistral: 'MISTRAL_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        minimax: 'MINIMAX_API_KEY',
        groq: 'GROQ_API_KEY',
        cerebras: 'CEREBRAS_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        kilocode: 'KILOCODE_API_KEY',
        'github-copilot': 'GITHUB_TOKEN',
        huggingface: 'HF_TOKEN',
        volcengine: 'VOLCENGINE_API_KEY',
        byteplus: 'BYTEPLUS_API_KEY',
        synthetic: 'HF_TOKEN',
    };

    return map[provider] ?? `${provider.toUpperCase()}_API_KEY`;
}
