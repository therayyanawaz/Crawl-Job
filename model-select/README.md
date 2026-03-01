# model-select

![CI](https://github.com/your-org/model-select/actions/workflows/ci.yml/badge.svg)
![Node 18+](https://img.shields.io/badge/node-18%2B-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Security-focused interactive CLI for configuring AI provider credentials, selecting models, and managing named profiles.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Provider and Model Catalog](#provider-and-model-catalog)
- [Security](#security)
- [Configuration Storage Paths](#configuration-storage-paths)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)

## Features

- AES-256-CBC encryption for API keys in persistent config storage.
- Automatic migration of legacy unencrypted keys to encrypted format.
- Optional OS-native keychain storage via `keytar` with encrypted-config fallback.
- Live API key verification with provider endpoints and timeout/rate-limit handling.
- Environment variable key auto-detection with explicit user choice and persistence.
- Export safety checks that warn if `.env.modelselect` is not in `.gitignore`.
- Build pipeline moved from `tsc` emit to `tsup` (ESM + declarations + sourcemaps).
- Unit test suite with `vitest` for provider integrity, encryption behavior, and validation logic.
- Update notifier integration to surface new CLI releases.
- Named profile support (`--profile`) including profile listing and profile deletion.
- GitHub Actions CI for typecheck, build, test, and secret-file guard.

## Installation

```bash
npm install
npm run build
npm link
```

After linking, run:

```bash
model-select
```

## Usage

### Interactive flow (default profile)

```bash
model-select
```

### Interactive flow with named profile

```bash
model-select --profile work
```

### List all providers and models

```bash
model-select list
```

### Show saved configuration for a profile

```bash
model-select show --profile work
```

### Export current profile config to `.env.modelselect`

```bash
model-select export --profile work
```

### Clear saved configuration for a profile

```bash
model-select clear --profile work
```

### List saved profiles

```bash
model-select profiles list
```

### Delete a profile

```bash
model-select profiles delete work
```

## Provider and Model Catalog

| Provider ID | Provider | Auth Env Var | Instructions URL | Models |
|---|---|---|---|---|
| `anthropic` | Anthropic (Claude) | `ANTHROPIC_API_KEY` | https://console.anthropic.com | `anthropic/claude-opus-4-6` (Claude Opus 4.6 (Best for complex tasks))<br>`anthropic/claude-sonnet-4-5` (Claude Sonnet 4.5 (Balanced, most popular))<br>`anthropic/claude-haiku` (Claude Haiku (Fast, lightweight)) |
| `openai` | OpenAI (GPT) | `OPENAI_API_KEY` | https://platform.openai.com/api-keys | `openai/gpt-5.1-codex` (GPT-5.1 Codex)<br>`openai-codex/gpt-5.3-codex` (GPT-5.3 Codex (ChatGPT subscription)) |
| `google` | Google Gemini | `GEMINI_API_KEY` | https://aistudio.google.com/app/apikey | `google/gemini-3-pro-preview` (Gemini 3 Pro Preview)<br>`google/gemini-3-flash-preview` (Gemini 3 Flash Preview (Faster)) |
| `zai` | Z.AI / GLM (Zhipu AI) | `ZAI_API_KEY` | https://open.bigmodel.cn | `zai/glm-5` (GLM-5 (Reasoning & Code))<br>`zai/glm-4.7` (GLM-4.7 (Coding & Tool-calling))<br>`zai/glm-4.6` (GLM-4.6)<br>`zai/glm-4.5` (GLM-4.5)<br>`zai/glm-4.5-air` (GLM-4.5 Air (Lightweight)) |
| `moonshot` | Moonshot AI (Kimi) | `MOONSHOT_API_KEY` | https://platform.moonshot.ai | `moonshot/kimi-k2.5` (Kimi K2.5)<br>`moonshot/kimi-k2-0905-preview` (Kimi K2 Preview)<br>`moonshot/kimi-k2-turbo-preview` (Kimi K2 Turbo)<br>`moonshot/kimi-k2-thinking` (Kimi K2 Thinking)<br>`moonshot/kimi-k2-thinking-turbo` (Kimi K2 Thinking Turbo) |
| `xai` | xAI (Grok) | `XAI_API_KEY` | https://console.x.ai | `xai/grok-3` (Grok 3)<br>`xai/grok-3-fast` (Grok 3 Fast) |
| `mistral` | Mistral | `MISTRAL_API_KEY` | https://console.mistral.ai | `mistral/mistral-large-latest` (Mistral Large (Latest))<br>`mistral/mistral-medium` (Mistral Medium) |
| `deepseek` | DeepSeek (via OpenRouter) | `OPENROUTER_API_KEY` | https://openrouter.ai/keys | `openrouter/deepseek/deepseek-r1` (DeepSeek R1)<br>`openrouter/deepseek/deepseek-v3` (DeepSeek V3) |
| `minimax` | MiniMax | `MINIMAX_API_KEY` | https://api.minimax.io | `minimax/minimax-m2.5` (MiniMax M2.5)<br>`synthetic/hf:MiniMaxAI/MiniMax-M2.1` (MiniMax M2.1 (Hugging Face)) |
| `volcengine` | Volcano Engine / BytePlus (Doubao) | `VOLCENGINE_API_KEY` | https://console.volcengine.com | `volcengine/doubao-seed-1-8-251228` (Doubao Seed 1.8)<br>`volcengine/doubao-seed-code-preview-251028` (Doubao Seed Code Preview)<br>`volcengine/kimi-k2-5-260127` (Kimi K2.5 (Volcano))<br>`volcengine/glm-4-7-251222` (GLM-4.7 (Volcano))<br>`volcengine/deepseek-v3-2-251201` (DeepSeek V3.2 128K (Volcano))<br>`byteplus/seed-1-8-251228` (BytePlus Seed 1.8)<br>`byteplus/kimi-k2-5-260127` (BytePlus Kimi K2.5)<br>`byteplus/glm-4-7-251222` (BytePlus GLM-4.7) |
| `groq` | Groq (Fast Inference) | `GROQ_API_KEY` | https://console.groq.com/keys | `groq/llama-3.3-70b-versatile` (Llama 3.3 70B (Groq))<br>`groq/gemma2-9b-it` (Gemma 2 9B (Groq))<br>`groq/mixtral-8x7b-32768` (Mixtral 8x7B (Groq)) |
| `cerebras` | Cerebras (Fast Inference) | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai | `cerebras/zai-glm-4.7` (GLM-4.7 (Cerebras))<br>`cerebras/zai-glm-4.6` (GLM-4.6 (Cerebras))<br>`cerebras/llama-3.3-70b` (Llama 3.3 70B (Cerebras)) |
| `openrouter` | OpenRouter (Aggregator) | `OPENROUTER_API_KEY` | https://openrouter.ai/keys | `openrouter/anthropic/claude-sonnet-4-5` (Claude Sonnet 4.5 (via OpenRouter))<br>`openrouter/google/gemini-3-pro-preview` (Gemini 3 Pro (via OpenRouter))<br>`openrouter/meta-llama/llama-3.3-70b-instruct` (Llama 3.3 70B (via OpenRouter)) |
| `kilocode` | Kilo Gateway | `KILOCODE_API_KEY` | https://kilocode.ai | `kilocode/anthropic/claude-opus-4.6` (Claude Opus 4.6 (Kilo))<br>`kilocode/glm-5-free` (GLM-5 Free (Kilo))<br>`kilocode/minimax-m2.5-free` (MiniMax M2.5 Free (Kilo))<br>`kilocode/gemini-3-pro-preview` (Gemini 3 Pro Preview (Kilo))<br>`kilocode/grok-code-fast-1` (Grok Code Fast 1 (Kilo))<br>`kilocode/kimi-k2.5` (Kimi K2.5 (Kilo)) |
| `github_copilot` | GitHub Copilot | `GITHUB_TOKEN` | https://github.com/settings/tokens | `github-copilot/gpt-4o` (GPT-4o (Copilot))<br>`github-copilot/claude-sonnet` (Claude Sonnet (Copilot))<br>`github-copilot/o3-mini` (o3-mini (Copilot)) |
| `huggingface` | Hugging Face Inference | `HF_TOKEN` | https://huggingface.co/settings/tokens | `huggingface/deepseek-ai/DeepSeek-R1` (DeepSeek R1 (HuggingFace))<br>`huggingface/mistralai/Mistral-7B-Instruct-v0.3` (Mistral 7B Instruct (HuggingFace)) |
| `ollama` | Ollama (Local, No API Key) | `null` | https://ollama.ai | `ollama/llama3.3` (Llama 3.3 (Local))<br>`ollama/llama3.1` (Llama 3.1 70B (Local))<br>`ollama/qwen2.5` (Qwen 2.5 72B (Local))<br>`ollama/mistral` (Mistral (Local))<br>`ollama/deepseek-r1` (DeepSeek R1 (Local)) |
| `lmstudio` | LM Studio (Local, No API Key) | `null` | https://lmstudio.ai | `lmstudio/minimax-m2.1` (MiniMax M2.1 (LM Studio))<br>`lmstudio/llama3.3` (Llama 3.3 (LM Studio))<br>`lmstudio/qwen2.5-coder` (Qwen 2.5 Coder (LM Studio)) |

## Security

- API keys stored in config are encrypted with AES-256-CBC using a machine-derived key.
- If `keytar` is available, keys are stored in the OS keychain (`model-select-cli`) and encrypted-file fallback is not required.
- Legacy plaintext keys are auto-migrated to encrypted format on startup.
- Exported `.env.modelselect` files trigger a warning if not ignored by `.gitignore`, with optional auto-fix.

## Configuration Storage Paths

`conf` stores settings in OS-specific app config directories. Typical paths are:

- macOS: `~/Library/Preferences/model-select-nodejs/config.json`
- Linux: `~/.config/model-select-nodejs/config.json`
- Windows: `%APPDATA%\model-select-nodejs\Config\config.json`

To see the exact path on your system, run interactive mode and check the banner output.

## Contributing

To add a new provider, edit `src/data/providers.ts` and add one `ProviderDefinition` entry with all required fields.

Example:

```ts
{
  id: "exampleai",
  label: "Example AI",
  authType: "api_key",
  authEnvVar: "EXAMPLE_API_KEY",
  authInstructions: "Get your key at https://example.com/keys",
  models: [
    { id: "exampleai/model-pro", label: "Model Pro" },
    { id: "exampleai/model-fast", label: "Model Fast" }
  ]
}
```

Then place the provider ID into the appropriate group in `PROVIDER_SECTIONS`, run `npm run build`, and run `npm test`.

## Troubleshooting

### "Failed to decrypt key" warning

This means a stored encrypted key cannot be decrypted on the current machine/user context, or the value is corrupted. Re-enter the key and save it again.

### Keytar native binding issues

If `keytar` cannot load native bindings, the CLI silently falls back to AES-encrypted `conf` storage. You can continue using the tool normally.

### Ollama not reachable

Install and run Ollama locally:

```bash
ollama serve
```

Then re-run `model-select`.

### LM Studio server not running

Start LM Studio and enable its local API server, then retry model selection.
