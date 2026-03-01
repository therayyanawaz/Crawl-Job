import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkLLMHealth, setOllamaAvailable } from '../services/llmExtractor.js';
import { loadLLMConfig } from './modelSelectBridge.js';

export async function initLLM(): Promise<void> {
    const envFilePath = path.join(process.cwd(), '.env.modelselect');
    const config = loadLLMConfig();

    if (existsSync(envFilePath)) {
        console.info(`[LLMSetup] ✅ Loaded model-select config: ${config.modelId}`);
    } else {
        console.warn('[LLMSetup] ⚠  No .env.modelselect found. Falling back to Ollama env vars.');
        console.warn('[LLMSetup]    Run: node model-select/dist/index.js export');
        console.warn('[LLMSetup]    Or:  npm run setup');
    }

    console.info(`[LLMSetup] Provider : ${config.provider}`);
    console.info(`[LLMSetup] Model    : ${config.modelId}`);
    console.info(`[LLMSetup] Format   : ${config.apiFormat}`);
    console.info(`[LLMSetup] Key      : ${config.apiKey ? `****${config.apiKey.slice(-4)}` : 'not required'}`);

    const healthy = await checkLLMHealth(config);
    setOllamaAvailable(healthy);

    if (!healthy) {
        console.warn('[LLMSetup] ⚠  LLM provider not reachable. Extraction will fall back to selector-based parsing.');
    }
}
