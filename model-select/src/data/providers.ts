export type AuthType = "api_key" | "oauth" | "none";

export interface ModelDefinition {
  id: string;
  label: string;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  authType: AuthType;
  authEnvVar: string | null;
  authInstructions: string;
  models: ModelDefinition[];
}

export interface ProviderSection {
  title: string;
  providerIds: string[];
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    authType: "api_key",
    authEnvVar: "ANTHROPIC_API_KEY",
    authInstructions: "Get your key at https://console.anthropic.com",
    models: [
      { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6 (Best for complex tasks)" },
      { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5 (Balanced, most popular)" },
      { id: "anthropic/claude-haiku", label: "Claude Haiku (Fast, lightweight)" }
    ]
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    authType: "api_key",
    authEnvVar: "OPENAI_API_KEY",
    authInstructions: "Get your key at https://platform.openai.com/api-keys",
    models: [
      { id: "openai/gpt-5.1-codex", label: "GPT-5.1 Codex" },
      { id: "openai-codex/gpt-5.3-codex", label: "GPT-5.3 Codex (ChatGPT subscription)" }
    ]
  },
  {
    id: "google",
    label: "Google Gemini",
    authType: "api_key",
    authEnvVar: "GEMINI_API_KEY",
    authInstructions: "Get your key at https://aistudio.google.com/app/apikey",
    models: [
      { id: "google/gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
      { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview (Faster)" }
    ]
  },
  {
    id: "zai",
    label: "Z.AI / GLM (Zhipu AI)",
    authType: "api_key",
    authEnvVar: "ZAI_API_KEY",
    authInstructions: "Get your key at https://open.bigmodel.cn",
    models: [
      { id: "zai/glm-5", label: "GLM-5 (Reasoning & Code)" },
      { id: "zai/glm-4.7", label: "GLM-4.7 (Coding & Tool-calling)" },
      { id: "zai/glm-4.6", label: "GLM-4.6" },
      { id: "zai/glm-4.5", label: "GLM-4.5" },
      { id: "zai/glm-4.5-air", label: "GLM-4.5 Air (Lightweight)" }
    ]
  },
  {
    id: "moonshot",
    label: "Moonshot AI (Kimi)",
    authType: "api_key",
    authEnvVar: "MOONSHOT_API_KEY",
    authInstructions: "Get your key at https://platform.moonshot.ai",
    models: [
      { id: "moonshot/kimi-k2.5", label: "Kimi K2.5" },
      { id: "moonshot/kimi-k2-0905-preview", label: "Kimi K2 Preview" },
      { id: "moonshot/kimi-k2-turbo-preview", label: "Kimi K2 Turbo" },
      { id: "moonshot/kimi-k2-thinking", label: "Kimi K2 Thinking" },
      { id: "moonshot/kimi-k2-thinking-turbo", label: "Kimi K2 Thinking Turbo" }
    ]
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    authType: "api_key",
    authEnvVar: "XAI_API_KEY",
    authInstructions: "Get your key at https://console.x.ai",
    models: [
      { id: "xai/grok-3", label: "Grok 3" },
      { id: "xai/grok-3-fast", label: "Grok 3 Fast" }
    ]
  },
  {
    id: "mistral",
    label: "Mistral",
    authType: "api_key",
    authEnvVar: "MISTRAL_API_KEY",
    authInstructions: "Get your key at https://console.mistral.ai",
    models: [
      { id: "mistral/mistral-large-latest", label: "Mistral Large (Latest)" },
      { id: "mistral/mistral-medium", label: "Mistral Medium" }
    ]
  },
  {
    id: "deepseek",
    label: "DeepSeek (via OpenRouter)",
    authType: "api_key",
    authEnvVar: "OPENROUTER_API_KEY",
    authInstructions: "Get your OpenRouter key at https://openrouter.ai/keys",
    models: [
      { id: "openrouter/deepseek/deepseek-r1", label: "DeepSeek R1" },
      { id: "openrouter/deepseek/deepseek-v3", label: "DeepSeek V3" }
    ]
  },
  {
    id: "minimax",
    label: "MiniMax",
    authType: "api_key",
    authEnvVar: "MINIMAX_API_KEY",
    authInstructions: "Get your key at https://api.minimax.io",
    models: [
      { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
      { id: "synthetic/hf:MiniMaxAI/MiniMax-M2.1", label: "MiniMax M2.1 (Hugging Face)" }
    ]
  },
  {
    id: "volcengine",
    label: "Volcano Engine / BytePlus (Doubao)",
    authType: "api_key",
    authEnvVar: "VOLCENGINE_API_KEY",
    authInstructions: "Get your key at https://console.volcengine.com",
    models: [
      { id: "volcengine/doubao-seed-1-8-251228", label: "Doubao Seed 1.8" },
      { id: "volcengine/doubao-seed-code-preview-251028", label: "Doubao Seed Code Preview" },
      { id: "volcengine/kimi-k2-5-260127", label: "Kimi K2.5 (Volcano)" },
      { id: "volcengine/glm-4-7-251222", label: "GLM-4.7 (Volcano)" },
      { id: "volcengine/deepseek-v3-2-251201", label: "DeepSeek V3.2 128K (Volcano)" },
      { id: "byteplus/seed-1-8-251228", label: "BytePlus Seed 1.8" },
      { id: "byteplus/kimi-k2-5-260127", label: "BytePlus Kimi K2.5" },
      { id: "byteplus/glm-4-7-251222", label: "BytePlus GLM-4.7" }
    ]
  },
  {
    id: "groq",
    label: "Groq (Fast Inference)",
    authType: "api_key",
    authEnvVar: "GROQ_API_KEY",
    authInstructions: "Get your key at https://console.groq.com/keys",
    models: [
      { id: "groq/llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)" },
      { id: "groq/gemma2-9b-it", label: "Gemma 2 9B (Groq)" },
      { id: "groq/mixtral-8x7b-32768", label: "Mixtral 8x7B (Groq)" }
    ]
  },
  {
    id: "cerebras",
    label: "Cerebras (Fast Inference)",
    authType: "api_key",
    authEnvVar: "CEREBRAS_API_KEY",
    authInstructions: "Get your key at https://cloud.cerebras.ai",
    models: [
      { id: "cerebras/zai-glm-4.7", label: "GLM-4.7 (Cerebras)" },
      { id: "cerebras/zai-glm-4.6", label: "GLM-4.6 (Cerebras)" },
      { id: "cerebras/llama-3.3-70b", label: "Llama 3.3 70B (Cerebras)" }
    ]
  },
  {
    id: "openrouter",
    label: "OpenRouter (Aggregator)",
    authType: "api_key",
    authEnvVar: "OPENROUTER_API_KEY",
    authInstructions: "Get your key at https://openrouter.ai/keys",
    models: [
      { id: "openrouter/anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5 (via OpenRouter)" },
      { id: "openrouter/google/gemini-3-pro-preview", label: "Gemini 3 Pro (via OpenRouter)" },
      {
        id: "openrouter/meta-llama/llama-3.3-70b-instruct",
        label: "Llama 3.3 70B (via OpenRouter)"
      }
    ]
  },
  {
    id: "kilocode",
    label: "Kilo Gateway",
    authType: "api_key",
    authEnvVar: "KILOCODE_API_KEY",
    authInstructions: "Get your key at https://kilocode.ai",
    models: [
      { id: "kilocode/anthropic/claude-opus-4.6", label: "Claude Opus 4.6 (Kilo)" },
      { id: "kilocode/glm-5-free", label: "GLM-5 Free (Kilo)" },
      { id: "kilocode/minimax-m2.5-free", label: "MiniMax M2.5 Free (Kilo)" },
      { id: "kilocode/gemini-3-pro-preview", label: "Gemini 3 Pro Preview (Kilo)" },
      { id: "kilocode/grok-code-fast-1", label: "Grok Code Fast 1 (Kilo)" },
      { id: "kilocode/kimi-k2.5", label: "Kimi K2.5 (Kilo)" }
    ]
  },
  {
    id: "github_copilot",
    label: "GitHub Copilot",
    authType: "api_key",
    authEnvVar: "GITHUB_TOKEN",
    authInstructions: "Use a GitHub Personal Access Token from https://github.com/settings/tokens",
    models: [
      { id: "github-copilot/gpt-4o", label: "GPT-4o (Copilot)" },
      { id: "github-copilot/claude-sonnet", label: "Claude Sonnet (Copilot)" },
      { id: "github-copilot/o3-mini", label: "o3-mini (Copilot)" }
    ]
  },
  {
    id: "huggingface",
    label: "Hugging Face Inference",
    authType: "api_key",
    authEnvVar: "HF_TOKEN",
    authInstructions: "Get your token at https://huggingface.co/settings/tokens",
    models: [
      { id: "huggingface/deepseek-ai/DeepSeek-R1", label: "DeepSeek R1 (HuggingFace)" },
      {
        id: "huggingface/mistralai/Mistral-7B-Instruct-v0.3",
        label: "Mistral 7B Instruct (HuggingFace)"
      }
    ]
  },
  {
    id: "ollama",
    label: "Ollama (Local, No API Key)",
    authType: "none",
    authEnvVar: null,
    authInstructions: "Install Ollama from https://ollama.ai and run `ollama serve`",
    models: [
      { id: "ollama/llama3.3", label: "Llama 3.3 (Local)" },
      { id: "ollama/llama3.1", label: "Llama 3.1 70B (Local)" },
      { id: "ollama/qwen2.5", label: "Qwen 2.5 72B (Local)" },
      { id: "ollama/mistral", label: "Mistral (Local)" },
      { id: "ollama/deepseek-r1", label: "DeepSeek R1 (Local)" }
    ]
  },
  {
    id: "lmstudio",
    label: "LM Studio (Local, No API Key)",
    authType: "none",
    authEnvVar: null,
    authInstructions: "Download LM Studio from https://lmstudio.ai and start the local server",
    models: [
      { id: "lmstudio/minimax-m2.1", label: "MiniMax M2.1 (LM Studio)" },
      { id: "lmstudio/llama3.3", label: "Llama 3.3 (LM Studio)" },
      { id: "lmstudio/qwen2.5-coder", label: "Qwen 2.5 Coder (LM Studio)" }
    ]
  }
];

export const PROVIDER_SECTIONS: ProviderSection[] = [
  {
    title: "── Cloud Providers ──",
    providerIds: [
      "anthropic",
      "openai",
      "google",
      "zai",
      "moonshot",
      "xai",
      "mistral",
      "deepseek",
      "minimax",
      "volcengine"
    ]
  },
  {
    title: "── Fast Inference ──",
    providerIds: ["groq", "cerebras"]
  },
  {
    title: "── Aggregators & Gateways ──",
    providerIds: ["openrouter", "kilocode", "github_copilot", "huggingface"]
  },
  {
    title: "── Local (No Cost, No API Key) ──",
    providerIds: ["ollama", "lmstudio"]
  }
];

export function getProviderById(providerId: string): ProviderDefinition | undefined {
  return PROVIDERS.find((provider) => provider.id === providerId);
}

export function getModelById(providerId: string, modelId: string): ModelDefinition | undefined {
  return getProviderById(providerId)?.models.find((model) => model.id === modelId);
}
