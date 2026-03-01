import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { deleteProfile } from "../utils/config.js";

export async function runProfilesDeleteCommand(name: string): Promise<void> {
  try {
    const profileName = name.trim();
    if (!profileName) {
      console.log(chalk.red("Profile name cannot be empty."));
      return;
    }

    const confirmAnswer = await inquirer.prompt<{ shouldDelete: boolean }>([
      {
        type: "confirm",
        name: "shouldDelete",
        message: `Delete profile "${profileName}"?`,
        default: false
      }
    ]);

    if (!confirmAnswer.shouldDelete) {
      console.log(chalk.yellow("Profile deletion cancelled."));
      return;
    }

    const spinner = ora(`Deleting profile "${profileName}"...`).start();
    const deleted = await deleteProfile(profileName);

    if (!deleted) {
      spinner.fail(`Profile "${profileName}" does not exist.`);
      return;
    }

    spinner.succeed(`Profile "${profileName}" deleted.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(`Failed to delete profile: ${message}`));
  }
}
