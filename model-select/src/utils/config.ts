import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import Conf from "conf";
import { deleteFromKeychain, getFromKeychain, saveToKeychain } from "./keychain.js";

const SALT = "model-select-static-salt-v1";
const MACHINE_KEY = process.env.USER ?? process.env.USERNAME ?? "default-user";
const DERIVED_KEY = scryptSync(MACHINE_KEY, SALT, 32);

interface ProviderCredentialConfig {
  apiKey?: string;
}

interface SelectedConfig {
  providerId: string | null;
  modelId: string | null;
}

interface ProfileConfig {
  providers: Record<string, ProviderCredentialConfig>;
  selected: SelectedConfig;
}

interface ModelSelectStore {
  profiles: Record<string, ProfileConfig>;
  providers?: Record<string, ProviderCredentialConfig>;
  selected?: SelectedConfig;
}

export interface ProfileSummary {
  name: string;
  providerId: string | null;
  modelId: string | null;
}

const DEFAULT_PROFILE = "default";

function createDefaultSelected(): SelectedConfig {
  return {
    providerId: null,
    modelId: null
  };
}

function createDefaultProfileConfig(): ProfileConfig {
  return {
    providers: {},
    selected: createDefaultSelected()
  };
}

function isProfileConfig(value: unknown): value is ProfileConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeProfile = value as Partial<ProfileConfig>;
  return Boolean(maybeProfile.providers && maybeProfile.selected);
}

const configStore = new Conf<ModelSelectStore>({
  projectName: "model-select",
  defaults: {
    profiles: {
      [DEFAULT_PROFILE]: createDefaultProfileConfig()
    }
  }
});

function normalizeProfileName(profile: string): string {
  const trimmed = profile.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_PROFILE;
}

function getProfilesStore(): Record<string, ProfileConfig> {
  const profiles = configStore.get("profiles");
  return profiles ?? {};
}

function ensureProfile(profile: string): ProfileConfig {
  const profileName = normalizeProfileName(profile);
  const profilePath = `profiles.${profileName}`;
  const existing = configStore.get(profilePath) as unknown;

  if (isProfileConfig(existing)) {
    return existing;
  }

  const defaultProfile = createDefaultProfileConfig();
  configStore.set(profilePath, defaultProfile);
  return defaultProfile;
}

function buildKeychainAccount(profile: string, providerId: string): string {
  return `${normalizeProfileName(profile)}:${providerId}`;
}

export function encryptValue(plaintext: string): string {
  try {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", DERIVED_KEY, iv);
    const encrypted = `${cipher.update(plaintext, "utf8", "hex")}${cipher.final("hex")}`;
    return `${iv.toString("hex")}:${encrypted}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown encryption error";
    console.error(chalk.red(`Failed to encrypt key: ${message}`));
    return "";
  }
}

export function decryptValue(encrypted: string): string {
  try {
    const [ivHex, encryptedHex] = encrypted.split(":");
    if (!ivHex || !encryptedHex) {
      throw new Error("Invalid encrypted key format");
    }

    const iv = Buffer.from(ivHex, "hex");
    if (iv.length !== 16) {
      throw new Error("Invalid IV length");
    }

    const decipher = createDecipheriv("aes-256-cbc", DERIVED_KEY, iv);
    return `${decipher.update(encryptedHex, "hex", "utf8")}${decipher.final("utf8")}`;
  } catch {
    console.error(
      chalk.red(
        "⚠ Failed to decrypt key. It may have been stored by a different user or corrupted."
      )
    );
    return "";
  }
}

export function getConfigPath(): string {
  return configStore.path;
}

export async function getProviderApiKey(
  providerId: string,
  profile = DEFAULT_PROFILE
): Promise<string | undefined> {
  try {
    const profileName = normalizeProfileName(profile);
    const keychainKey = await getFromKeychain(buildKeychainAccount(profileName, providerId));
    if (keychainKey) {
      return keychainKey;
    }

    const currentProfile = ensureProfile(profileName);
    const encryptedKey = currentProfile.providers[providerId]?.apiKey;
    if (!encryptedKey) {
      return undefined;
    }

    const decrypted = decryptValue(encryptedKey);
    return decrypted || undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown read error";
    console.error(chalk.red(`Failed to read API key for ${providerId}: ${message}`));
    return undefined;
  }
}

export async function saveProviderApiKey(
  providerId: string,
  apiKey: string,
  profile = DEFAULT_PROFILE
): Promise<void> {
  try {
    const profileName = normalizeProfileName(profile);
    ensureProfile(profileName);

    const normalizedKey = apiKey.trim();
    if (normalizedKey.length === 0) {
      return;
    }

    const keychainSaved = await saveToKeychain(buildKeychainAccount(profileName, providerId), normalizedKey);
    if (keychainSaved) {
      configStore.delete(`profiles.${profileName}.providers.${providerId}.apiKey`);
      return;
    }

    const encrypted = encryptValue(normalizedKey);
    if (!encrypted) {
      return;
    }

    configStore.set(`profiles.${profileName}.providers.${providerId}.apiKey`, encrypted);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown write error";
    console.error(chalk.red(`Failed to save API key for ${providerId}: ${message}`));
  }
}

export async function deleteProviderApiKey(
  providerId: string,
  profile = DEFAULT_PROFILE
): Promise<void> {
  try {
    const profileName = normalizeProfileName(profile);
    await deleteFromKeychain(buildKeychainAccount(profileName, providerId));
    configStore.delete(`profiles.${profileName}.providers.${providerId}.apiKey`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown delete error";
    console.error(chalk.red(`Failed to delete API key for ${providerId}: ${message}`));
  }
}

export function saveSelectedConfig(
  providerId: string,
  modelId: string,
  profile = DEFAULT_PROFILE
): void {
  const profileName = normalizeProfileName(profile);
  ensureProfile(profileName);
  configStore.set(`profiles.${profileName}.selected`, { providerId, modelId });
}

export function getSelectedConfig(profile = DEFAULT_PROFILE): SelectedConfig {
  const profileName = normalizeProfileName(profile);
  const currentProfile = ensureProfile(profileName);
  return currentProfile.selected;
}

export async function clearProfileConfig(profile = DEFAULT_PROFILE): Promise<void> {
  try {
    const profileName = normalizeProfileName(profile);
    const currentProfile = ensureProfile(profileName);
    const providerIds = Object.keys(currentProfile.providers);

    for (const providerId of providerIds) {
      await deleteProviderApiKey(providerId, profileName);
    }

    configStore.set(`profiles.${profileName}`, createDefaultProfileConfig());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown clear error";
    console.error(chalk.red(`Failed to clear profile ${profile}: ${message}`));
  }
}

export async function deleteProfile(profile: string): Promise<boolean> {
  try {
    const profileName = normalizeProfileName(profile);
    const profiles = getProfilesStore();

    if (!profiles[profileName]) {
      return false;
    }

    const providerIds = Object.keys(profiles[profileName].providers);
    for (const providerId of providerIds) {
      await deleteProviderApiKey(providerId, profileName);
    }

    configStore.delete(`profiles.${profileName}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown delete profile error";
    console.error(chalk.red(`Failed to delete profile ${profile}: ${message}`));
    return false;
  }
}

export function listProfiles(): ProfileSummary[] {
  const profiles = getProfilesStore();
  return Object.entries(profiles)
    .map(([name, profile]) => ({
      name,
      providerId: profile.selected.providerId,
      modelId: profile.selected.modelId
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function migrateStoredKeysToEncryptedFormat(): Promise<boolean> {
  try {
    let migratedUnencrypted = false;

    const legacyProviders = configStore.get("providers");
    if (legacyProviders && Object.keys(legacyProviders).length > 0) {
      const defaultProfile = ensureProfile(DEFAULT_PROFILE);

      Object.entries(legacyProviders).forEach(([providerId, credential]) => {
        const rawValue = credential?.apiKey;
        if (!rawValue) {
          return;
        }

        if (rawValue.includes(":")) {
          configStore.set(`profiles.${DEFAULT_PROFILE}.providers.${providerId}.apiKey`, rawValue);
        } else {
          const encrypted = encryptValue(rawValue);
          if (encrypted) {
            configStore.set(`profiles.${DEFAULT_PROFILE}.providers.${providerId}.apiKey`, encrypted);
            migratedUnencrypted = true;
          }
        }
      });

      if (!defaultProfile.selected.providerId && !defaultProfile.selected.modelId) {
        const legacySelected = configStore.get("selected");
        if (legacySelected?.providerId || legacySelected?.modelId) {
          configStore.set(`profiles.${DEFAULT_PROFILE}.selected`, legacySelected);
        }
      }

      configStore.delete("providers");
      configStore.delete("selected");
    }

    const profiles = getProfilesStore();

    Object.entries(profiles).forEach(([profileName, profile]) => {
      Object.entries(profile.providers).forEach(([providerId, credential]) => {
        const rawValue = credential.apiKey;
        if (!rawValue || rawValue.includes(":")) {
          return;
        }

        const encrypted = encryptValue(rawValue);
        if (!encrypted) {
          return;
        }

        configStore.set(`profiles.${profileName}.providers.${providerId}.apiKey`, encrypted);
        migratedUnencrypted = true;
      });
    });

    return migratedUnencrypted;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown migration error";
    console.error(chalk.red(`Failed to migrate stored keys: ${message}`));
    return false;
  }
}

export function maskApiKey(apiKey: string | null | undefined): string {
  if (!apiKey) {
    return "Not configured";
  }

  const normalized = apiKey.trim();
  if (normalized.length <= 4) {
    return `****${normalized}`;
  }

  return `****${normalized.slice(-4)}`;
}

export function exportEnvSnippet(
  modelId: string,
  authEnvVar: string | null,
  apiKey: string | null | undefined
): string {
  const lines = [`MODEL_ID=${modelId}`];

  if (authEnvVar && apiKey) {
    lines.push(`${authEnvVar}=${apiKey}`);
  }

  const outputPath = join(process.cwd(), ".env.modelselect");
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf-8");
  return outputPath;
}
