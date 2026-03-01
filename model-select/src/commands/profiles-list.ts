import chalk from "chalk";
import { getProviderById } from "../data/providers.js";
import { listProfiles } from "../utils/config.js";

export async function runProfilesListCommand(): Promise<void> {
  try {
    const profiles = listProfiles();

    if (profiles.length === 0) {
      console.log(chalk.yellow("No profiles found."));
      return;
    }

    const rows = profiles.map((profile) => {
      const providerLabel = profile.providerId
        ? (getProviderById(profile.providerId)?.label ?? profile.providerId)
        : "Not set";
      const modelLabel = profile.modelId ?? "Not set";

      return {
        profile: profile.name,
        provider: providerLabel,
        model: modelLabel
      };
    });

    const widths = {
      profile: Math.max("Profile".length, ...rows.map((row) => row.profile.length)),
      provider: Math.max("Selected Provider".length, ...rows.map((row) => row.provider.length)),
      model: Math.max("Selected Model ID".length, ...rows.map((row) => row.model.length))
    };

    const header = [
      "Profile".padEnd(widths.profile),
      "Selected Provider".padEnd(widths.provider),
      "Selected Model ID".padEnd(widths.model)
    ].join(" | ");

    const separator = [
      "-".repeat(widths.profile),
      "-".repeat(widths.provider),
      "-".repeat(widths.model)
    ].join("-+-");

    console.log(header);
    console.log(separator);

    rows.forEach((row) => {
      console.log(
        [row.profile.padEnd(widths.profile), row.provider.padEnd(widths.provider), row.model.padEnd(widths.model)].join(
          " | "
        )
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(chalk.red(`Failed to list profiles: ${message}`));
  }
}
