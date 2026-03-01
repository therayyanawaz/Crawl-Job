import chalk from "chalk";
import clipboardy from "clipboardy";
import inquirer from "inquirer";
import ora from "ora";
import { PROVIDERS, PROVIDER_SECTIONS, type ProviderDefinition } from "../data/providers.js";
import {
  exportEnvSnippet,
  getProviderApiKey,
  maskApiKey,
  saveProviderApiKey,
  saveSelectedConfig
} from "../utils/config.js";
import { validateApiKey } from "../utils/validate.js";
import { printBanner, printConfirmationBox } from "../utils/display.js";

interface SearchChoice {
  name: string;
  value: string;
  disabled?: boolean;
}

type NextAction =
  | "Copy model ID to clipboard"
  | "Export config as .env snippet"
  | "Start over"
  | "Exit";

function findProvider(providerId: string): ProviderDefinition {
  const provider = PROVIDERS.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Provider not found: ${providerId}`);
  }

  return provider;
}

function buildProviderChoices(term: string | undefined): SearchChoice[] {
  const normalizedTerm = term?.trim().toLowerCase();
  const choices: SearchChoice[] = [];

  PROVIDER_SECTIONS.forEach((section) => {
    const providersInSection = section.providerIds
      .map((providerId) => PROVIDERS.find((provider) => provider.id === providerId))
      .filter((provider): provider is ProviderDefinition => provider !== undefined)
      .filter((provider) => {
        if (!normalizedTerm) {
          return true;
        }

        return (
          provider.label.toLowerCase().includes(normalizedTerm) ||
          provider.id.toLowerCase().includes(normalizedTerm)
        );
      });

    if (providersInSection.length > 0) {
      choices.push({
        name: section.title,
        value: `section:${section.title}`,
        disabled: true
      });

      providersInSection.forEach((provider) => {
        choices.push({ name: provider.label, value: provider.id });
      });
    }
  });

  if (choices.length === 0) {
    PROVIDERS.forEach((provider) => {
      choices.push({ name: provider.label, value: provider.id });
    });
  }

  return choices;
}

function buildModelChoices(provider: ProviderDefinition, term: string | undefined): SearchChoice[] {
  const normalizedTerm = term?.trim().toLowerCase();

  const filtered = provider.models.filter((model) => {
    if (!normalizedTerm) {
      return true;
    }

    return model.label.toLowerCase().includes(normalizedTerm) || model.id.toLowerCase().includes(normalizedTerm);
  });

  const source = filtered.length > 0 ? filtered : provider.models;

  return source.map((model) => ({
    name: model.label,
    value: model.id
  }));
}

async function promptAndValidateApiKey(provider: ProviderDefinition): Promise<string | null> {
  while (true) {
    console.log(chalk.dim(provider.authInstructions));

    const apiKeyAnswer = await inquirer.prompt<{ apiKey: string }>([
      {
        type: "password",
        name: "apiKey",
        message: `Enter your ${provider.authEnvVar} API key:`,
        mask: "*",
        validate: (value: string) => {
          if (value.trim().length >= 10) {
            return true;
          }

          return "Key seems too short, please check";
        }
      }
    ]);

    const enteredKey = apiKeyAnswer.apiKey.trim();

    const validationSpinner = ora("Verifying API key with provider...").start();
    const validation = await validateApiKey(provider.id, enteredKey);

    if (validation.valid) {
      validationSpinner.succeed(validation.message);
      return enteredKey;
    }

    validationSpinner.fail(validation.message);

    const retryAnswer = await inquirer.prompt<{ retry: boolean }>([
      {
        type: "confirm",
        name: "retry",
        message: "Try a different key?",
        default: true
      }
    ]);

    if (!retryAnswer.retry) {
      return null;
    }
  }
}

export async function runInteractiveFlow(profile = "default"): Promise<void> {
  try {
    let shouldRestart = true;

    while (shouldRestart) {
      shouldRestart = false;
      printBanner();

      const providerAnswer = await inquirer.prompt<{ providerId: string }>([
        {
          type: "search",
          name: "providerId",
          message: "Select an AI Provider:",
          pageSize: 18,
          source: (term: string | undefined) => buildProviderChoices(term)
        }
      ]);

      const provider = findProvider(providerAnswer.providerId);
      let resolvedApiKey: string | null = null;
      let shouldCheckSavedKey = true;

      if (provider.authType === "api_key") {
        const envKey = provider.authEnvVar ? process.env[provider.authEnvVar] : undefined;

        if (envKey && envKey.trim().length > 0) {
          console.log(chalk.green(`✔ Found ${provider.authEnvVar} in your environment variables.`));

          const envChoice = await inquirer.prompt<{
            use: "Use environment variable" | "Enter a different key";
          }>([
            {
              type: "list",
              name: "use",
              message: "Use this environment variable key or enter a different one?",
              choices: ["Use environment variable", "Enter a different key"]
            }
          ]);

          if (envChoice.use === "Use environment variable") {
            resolvedApiKey = envKey.trim();
            shouldCheckSavedKey = false;

            const saveEnvAnswer = await inquirer.prompt<{ shouldSaveEnvKey: boolean }>([
              {
                type: "confirm",
                name: "shouldSaveEnvKey",
                message: "Save this to config for future sessions?",
                default: false
              }
            ]);

            if (saveEnvAnswer.shouldSaveEnvKey) {
              const saveSpinner = ora("Saving API key...").start();
              await saveProviderApiKey(provider.id, resolvedApiKey, profile);
              saveSpinner.succeed("API key saved.");
            }
          }
        }

        if (shouldCheckSavedKey && !resolvedApiKey) {
          const existingKey = await getProviderApiKey(provider.id, profile);
          let shouldRequestReplacement = true;

          if (existingKey) {
            console.log(chalk.green(`✔ API key already configured for ${provider.label}`));

            const existingKeyAction = await inquirer.prompt<{ keyAction: "Use existing" | "Replace" }>([
              {
                type: "list",
                name: "keyAction",
                message: "Do you want to use the existing key or replace it?",
                choices: ["Use existing", "Replace"]
              }
            ]);

            if (existingKeyAction.keyAction === "Use existing") {
              resolvedApiKey = existingKey;
              shouldRequestReplacement = false;
            }
          }

          if (shouldRequestReplacement) {
            const promptedApiKey = await promptAndValidateApiKey(provider);
            if (!promptedApiKey) {
              console.log(chalk.yellow("Configuration cancelled."));
              return;
            }

            resolvedApiKey = promptedApiKey;

            const saveKeyAnswer = await inquirer.prompt<{ shouldSaveKey: boolean }>([
              {
                type: "confirm",
                name: "shouldSaveKey",
                message: "Save this key for future sessions?",
                default: true
              }
            ]);

            if (saveKeyAnswer.shouldSaveKey) {
              const saveSpinner = ora("Saving API key...").start();
              await saveProviderApiKey(provider.id, resolvedApiKey, profile);
              saveSpinner.succeed("API key saved.");
            }
          }
        }
      } else if (provider.authType === "none") {
        console.log(chalk.yellow("No API key needed. Make sure the local server is running."));
      }

      const modelAnswer = await inquirer.prompt<{ modelId: string }>([
        {
          type: "search",
          name: "modelId",
          message: `Select a model from ${provider.label}:`,
          pageSize: 14,
          source: (term: string | undefined) => buildModelChoices(provider, term)
        }
      ]);

      const model = provider.models.find((item) => item.id === modelAnswer.modelId);
      if (!model) {
        throw new Error(`Model not found for provider ${provider.id}: ${modelAnswer.modelId}`);
      }

      console.log(chalk.dim(`Model ID will be: ${model.id}`));

      const selectionSpinner = ora("Saving selected provider and model...").start();
      saveSelectedConfig(provider.id, model.id, profile);
      selectionSpinner.succeed("Selection saved.");

      const apiKeyDisplay = provider.authType === "none" ? "Not required" : maskApiKey(resolvedApiKey);

      printConfirmationBox({
        providerLabel: provider.label,
        modelLabel: model.label,
        modelId: model.id,
        apiKeyDisplay
      });

      const nextActionAnswer = await inquirer.prompt<{ nextAction: NextAction }>([
        {
          type: "list",
          name: "nextAction",
          message: "What would you like to do next?",
          choices: [
            "Copy model ID to clipboard",
            "Export config as .env snippet",
            "Start over",
            "Exit"
          ]
        }
      ]);

      if (nextActionAnswer.nextAction === "Copy model ID to clipboard") {
        const clipboardSpinner = ora("Copying model ID to clipboard...").start();
        await clipboardy.write(model.id);
        clipboardSpinner.succeed("Model ID copied to clipboard.");
      }

      if (nextActionAnswer.nextAction === "Export config as .env snippet") {
        const exportSpinner = ora("Exporting .env snippet...").start();
        const exportKey = provider.authType === "api_key" ? resolvedApiKey : null;
        const outputPath = exportEnvSnippet(model.id, provider.authEnvVar, exportKey);
        exportSpinner.succeed(`Exported configuration to ${outputPath}`);
      }

      if (nextActionAnswer.nextAction === "Start over") {
        shouldRestart = true;
      }

      if (nextActionAnswer.nextAction === "Exit") {
        console.log(chalk.green("Done! Happy building. 🚀"));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(`Interactive flow failed: ${message}`));
  }
}
