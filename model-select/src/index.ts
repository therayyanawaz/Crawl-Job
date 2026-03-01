#!/usr/bin/env node

import { createRequire } from "node:module";
import chalk from "chalk";
import { Command } from "commander";
import updateNotifier from "update-notifier";
import { runClearCommand } from "./commands/clear.js";
import { runExportCommand } from "./commands/export.js";
import { runListCommand } from "./commands/list.js";
import { runProfilesDeleteCommand } from "./commands/profiles-delete.js";
import { runProfilesListCommand } from "./commands/profiles-list.js";
import { runShowCommand } from "./commands/show.js";
import { runInteractiveFlow } from "./flow/interactive.js";
import { migrateStoredKeysToEncryptedFormat } from "./utils/config.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

updateNotifier({ pkg, updateCheckInterval: 1000 * 60 * 60 * 24 }).notify();

function resolveProfile(program: Command): string {
  const options = program.opts<{ profile?: string }>();
  return options.profile?.trim() || "default";
}

async function main(): Promise<void> {
  try {
    const program = new Command();

    program
      .name("model-select")
      .description("Configure AI provider credentials and select models")
      .version(pkg.version)
      .option("-p, --profile <name>", "Use a named configuration profile", "default");

    program
      .command("list")
      .description("List all providers and models")
      .action(() => runListCommand());

    program
      .command("show")
      .description("Show currently saved configuration")
      .action(() => runShowCommand(resolveProfile(program)));

    program
      .command("clear")
      .description("Clear saved configuration for the selected profile")
      .action(() => runClearCommand(resolveProfile(program)));

    program
      .command("export")
      .description("Export current config to .env.modelselect")
      .action(() => runExportCommand(resolveProfile(program)));

    const profilesCommand = program
      .command("profiles")
      .description("Manage named configuration profiles");

    profilesCommand
      .command("list")
      .description("List saved profile names and selected models")
      .action(() => runProfilesListCommand());

    profilesCommand
      .command("delete")
      .argument("<name>", "Profile name")
      .description("Delete a saved profile")
      .action((name: string) => runProfilesDeleteCommand(name));

    program.action(() => runInteractiveFlow(resolveProfile(program)));

    const migrated = await migrateStoredKeysToEncryptedFormat();
    if (migrated) {
      console.log(chalk.dim("↻ Migrating stored keys to encrypted format..."));
    }

    await program.parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(`CLI failed: ${message}`));
  }
}

void main();
