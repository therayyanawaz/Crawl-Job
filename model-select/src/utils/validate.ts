import { getProviderById } from "../data/providers.js";

export interface ApiKeyValidationResult {
  valid: boolean;
  message: string;
}

interface ValidationRequestConfig {
  url: (apiKey: string) => string;
  init: (apiKey: string) => RequestInit;
}

const VALIDATION_CONFIG: Record<string, ValidationRequestConfig> = {
  anthropic: {
    url: () => "https://api.anthropic.com/v1/models",
    init: (apiKey: string) => ({
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    })
  },
  openai: {
    url: () => "https://api.openai.com/v1/models",
    init: (apiKey: string) => ({
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })
  },
  google: {
    url: (apiKey: string) => `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`,
    init: () => ({ method: "GET" })
  },
  mistral: {
    url: () => "https://api.mistral.ai/v1/models",
    init: (apiKey: string) => ({
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })
  },
  groq: {
    url: () => "https://api.groq.com/openai/v1/models",
    init: (apiKey: string) => ({
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })
  },
  xai: {
    url: () => "https://api.x.ai/v1/models",
    init: (apiKey: string) => ({
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })
  },
  openrouter: {
    url: () => "https://openrouter.ai/api/v1/models",
    init: (apiKey: string) => ({
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })
  },
  huggingface: {
    url: () => "https://huggingface.co/api/whoami",
    init: (apiKey: string) => ({
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })
  }
};

function getStatusResult(status: number): ApiKeyValidationResult {
  if (status === 200 || status === 201) {
    return { valid: true, message: "✔ Key verified successfully" };
  }

  if (status === 401 || status === 403) {
    return { valid: false, message: "✘ Invalid key — authentication rejected by provider" };
  }

  if (status === 429) {
    return { valid: true, message: "⚠ Rate limited — key appears valid but rate limit hit" };
  }

  return { valid: false, message: `✘ Key validation failed with HTTP ${status}` };
}

export async function validateApiKey(providerId: string, apiKey: string): Promise<ApiKeyValidationResult> {
  const provider = getProviderById(providerId);

  if (provider?.authType === "none") {
    return { valid: true, message: "Key format accepted (validation not available for this provider)" };
  }

  const config = VALIDATION_CONFIG[providerId];
  if (!config) {
    return { valid: true, message: "Key format accepted (validation not available for this provider)" };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, 5000);

  try {
    const requestInit = config.init(apiKey);
    const response = await fetch(config.url(apiKey), {
      ...requestInit,
      signal: abortController.signal
    });

    return getStatusResult(response.status);
  } catch {
    return {
      valid: true,
      message: "⚠ Could not reach provider — check your internet connection. Key accepted anyway."
    };
  } finally {
    clearTimeout(timeout);
  }
}
