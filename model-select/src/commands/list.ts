import chalk from "chalk";
import { printProviderTable } from "../utils/display.js";

export async function runListCommand(): Promise<void> {
  try {
    printProviderTable();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(`Failed to list providers: ${message}`));
  }
}
