const SERVICE_NAME = "model-select-cli";

interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let keytarModulePromise: Promise<KeytarLike | null> | null = null;

async function loadKeytar(): Promise<KeytarLike | null> {
  if (!keytarModulePromise) {
    keytarModulePromise = import("keytar")
      .then((mod) => {
        const maybeKeytar = (mod.default ?? mod) as Partial<KeytarLike>;
        if (
          typeof maybeKeytar.setPassword === "function" &&
          typeof maybeKeytar.getPassword === "function" &&
          typeof maybeKeytar.deletePassword === "function"
        ) {
          return maybeKeytar as KeytarLike;
        }

        return null;
      })
      .catch(() => null);
  }

  return keytarModulePromise;
}

export async function saveToKeychain(provider: string, key: string): Promise<boolean> {
  try {
    const keytar = await loadKeytar();
    if (!keytar) {
      return false;
    }

    await keytar.setPassword(SERVICE_NAME, provider, key);
    return true;
  } catch {
    return false;
  }
}

export async function getFromKeychain(provider: string): Promise<string | null> {
  try {
    const keytar = await loadKeytar();
    if (!keytar) {
      return null;
    }

    const value = await keytar.getPassword(SERVICE_NAME, provider);
    return value ?? null;
  } catch {
    return null;
  }
}

export async function deleteFromKeychain(provider: string): Promise<void> {
  try {
    const keytar = await loadKeytar();
    if (!keytar) {
      return;
    }

    await keytar.deletePassword(SERVICE_NAME, provider);
  } catch {
    // Silent fallback by design.
  }
}
