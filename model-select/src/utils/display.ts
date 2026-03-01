import chalk from "chalk";
import { PROVIDERS } from "../data/providers.js";
import { getConfigPath } from "./config.js";

export interface ConfirmationDisplayConfig {
  providerLabel: string;
  modelLabel: string;
  modelId: string;
  apiKeyDisplay: string;
}

function buildBox(lines: string[]): string {
  const width = Math.max(...lines.map((line) => line.length), 35);
  const top = `┌${"─".repeat(width + 2)}┐`;
  const body = lines.map((line) => `│ ${line.padEnd(width)} │`).join("\n");
  const bottom = `└${"─".repeat(width + 2)}┘`;
  return `${top}\n${body}\n${bottom}`;
}

export function printBanner(): void {
  const banner = [
    "╔══════════════════════════════════════╗",
    "║          ⚡ Model Selector           ║",
    "║  Configure your AI provider & model ║",
    "╚══════════════════════════════════════╝"
  ].join("\n");

  console.log(chalk.cyan(banner));
  console.log(chalk.dim(`Config stored at: ${getConfigPath()}`));
  console.log();
}

export function printConfirmationBox(config: ConfirmationDisplayConfig): void {
  const box = buildBox([
    "✅ Configuration Complete",
    "",
    `Provider : ${config.providerLabel}`,
    `Model    : ${config.modelLabel}`,
    `Model ID : ${config.modelId}`,
    `API Key  : ${config.apiKeyDisplay}`
  ]);

  console.log(chalk.green(box));
}

export function printProviderTable(): void {
  const headers = {
    providerId: "Provider ID",
    providerLabel: "Provider",
    modelId: "Model ID",
    modelLabel: "Model"
  };

  const rows = PROVIDERS.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      providerLabel: provider.label,
      modelId: model.id,
      modelLabel: model.label
    }))
  );

  const widths = {
    providerId: Math.max(headers.providerId.length, ...rows.map((row) => row.providerId.length)),
    providerLabel: Math.max(headers.providerLabel.length, ...rows.map((row) => row.providerLabel.length)),
    modelId: Math.max(headers.modelId.length, ...rows.map((row) => row.modelId.length)),
    modelLabel: Math.max(headers.modelLabel.length, ...rows.map((row) => row.modelLabel.length))
  };

  const separator = [
    "-".repeat(widths.providerId),
    "-".repeat(widths.providerLabel),
    "-".repeat(widths.modelId),
    "-".repeat(widths.modelLabel)
  ].join("-+-");

  const formatRow = (row: typeof rows[number] | typeof headers): string => {
    return [
      row.providerId.padEnd(widths.providerId),
      row.providerLabel.padEnd(widths.providerLabel),
      row.modelId.padEnd(widths.modelId),
      row.modelLabel.padEnd(widths.modelLabel)
    ].join(" | ");
  };

  console.log(formatRow(headers));
  console.log(separator);

  rows.forEach((row) => {
    console.log(formatRow(row));
  });
}
