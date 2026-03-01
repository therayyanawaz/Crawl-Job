import chalk from "chalk";
import { getProviderById, getModelById } from "../data/providers.js";
import { getProviderApiKey, getSelectedConfig, maskApiKey } from "../utils/config.js";

export async function runShowCommand(profile: string): Promise<void> {
  try {
    const selected = getSelectedConfig(profile);

    if (!selected.providerId || !selected.modelId) {
      console.log(chalk.yellow(`No configuration saved yet for profile "${profile}".`));
      return;
    }

    const provider = getProviderById(selected.providerId);
    const model = getModelById(selected.providerId, selected.modelId);

    if (!provider || !model) {
      console.log(chalk.yellow("Saved configuration references an unknown provider or model."));
      return;
    }

    const apiKeyDisplay =
      provider.authType === "none"
        ? "Not required"
        : maskApiKey(await getProviderApiKey(provider.id, profile));

    console.log(chalk.cyan(`Current saved configuration (profile: ${profile}):`));
    console.log(`Provider : ${provider.label}`);
    console.log(`Model    : ${model.label}`);
    console.log(`Model ID : ${model.id}`);
    console.log(`API Key  : ${apiKeyDisplay}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(`Failed to show configuration: ${message}`));
  }
}
