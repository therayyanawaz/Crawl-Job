import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { clearProfileConfig } from "../utils/config.js";

export async function runClearCommand(profile: string): Promise<void> {
  try {
    const { shouldClear } = await inquirer.prompt<{ shouldClear: boolean }>([
      {
        type: "confirm",
        name: "shouldClear",
        message: `This will clear saved configuration for profile "${profile}". Continue?`,
        default: false
      }
    ]);

    if (!shouldClear) {
      console.log(chalk.yellow("Clear operation cancelled."));
      return;
    }

    const spinner = ora(`Clearing saved configuration for profile "${profile}"...`).start();
    await clearProfileConfig(profile);
    spinner.succeed(`Saved configuration for profile "${profile}" has been cleared.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(`Failed to clear configuration: ${message}`));
  }
}
