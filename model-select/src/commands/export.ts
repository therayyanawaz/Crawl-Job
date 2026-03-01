import { appendFileSync, existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { getProviderById } from "../data/providers.js";
import { exportEnvSnippet, getProviderApiKey, getSelectedConfig } from "../utils/config.js";

function isEnvFileIgnored(gitignoreContent: string): boolean {
  const ignoredEntries = gitignoreContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return ignoredEntries.includes(".env.modelselect");
}

export async function runExportCommand(profile: string): Promise<void> {
  try {
    const selected = getSelectedConfig(profile);

    if (!selected.providerId || !selected.modelId) {
      console.log(chalk.yellow(`No saved configuration found for profile "${profile}". Run model-select first.`));
      return;
    }

    const provider = getProviderById(selected.providerId);
    if (!provider) {
      console.log(chalk.red("Saved provider could not be found in the current provider catalog."));
      return;
    }

    const apiKey = provider.authType === "api_key" ? await getProviderApiKey(provider.id, profile) : null;

    if (provider.authType === "api_key" && !apiKey) {
      console.log(chalk.red(`No saved API key found for ${provider.label} in profile "${profile}".`));
      return;
    }

    const spinner = ora("Exporting configuration to .env.modelselect...").start();
    const outputPath = exportEnvSnippet(selected.modelId, provider.authEnvVar, apiKey);
    spinner.succeed(`Exported configuration to ${outputPath}`);

    const gitignorePath = `${process.cwd()}/.gitignore`;

    if (!existsSync(gitignorePath)) {
      console.log(chalk.yellow("⚠ No .gitignore found. Consider creating one to avoid committing API keys."));
      return;
    }

    const gitignoreContent = readFileSync(gitignorePath, "utf-8");

    if (!isEnvFileIgnored(gitignoreContent)) {
      console.log(
        chalk.yellow("⚠ WARNING: .env.modelselect contains API keys and is NOT in your .gitignore!")
      );
      console.log(chalk.yellow(" Run: echo '.env.modelselect' >> .gitignore"));

      const addIgnoreAnswer = await inquirer.prompt<{ shouldAdd: boolean }>([
        {
          type: "confirm",
          name: "shouldAdd",
          message: "Add .env.modelselect to .gitignore automatically?",
          default: true
        }
      ]);

      if (addIgnoreAnswer.shouldAdd) {
        appendFileSync(gitignorePath, "\n.env.modelselect\n", "utf-8");
        console.log(chalk.green("✔ Added .env.modelselect to .gitignore"));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(`Failed to export configuration: ${message}`));
  }
}
