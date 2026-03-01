import { describe, it, expect } from "vitest";
import { PROVIDERS } from "./providers.js";

describe("PROVIDERS catalog integrity", () => {
  it("has at least 15 providers", () => expect(PROVIDERS.length).toBeGreaterThanOrEqual(15));

  it("every provider has required fields", () => {
    for (const p of PROVIDERS) {
      expect(p.id, `${p.id} missing id`).toBeTruthy();
      expect(p.label, `${p.id} missing label`).toBeTruthy();
      expect(p.authType, `${p.id} missing authType`).toMatch(/^(api_key|oauth|none)$/);
      expect(p.models.length, `${p.id} has no models`).toBeGreaterThan(0);
    }
  });

  it("all provider IDs are unique", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all model IDs are globally unique", () => {
    const ids = PROVIDERS.flatMap((p) => p.models.map((m) => m.id));
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, `Duplicate model IDs: ${dupes.join(", ")}`).toHaveLength(0);
  });

  it("api_key providers always have authEnvVar", () => {
    PROVIDERS.filter((p) => p.authType === "api_key").forEach((p) =>
      expect(p.authEnvVar, `${p.id} missing authEnvVar`).toBeTruthy()
    );
  });

  it("none providers have null authEnvVar", () => {
    PROVIDERS.filter((p) => p.authType === "none").forEach((p) => expect(p.authEnvVar).toBeNull());
  });

  it("all model IDs contain a slash (provider/model format)", () => {
    PROVIDERS.flatMap((p) => p.models).forEach((m) =>
      expect(m.id, `Model ${m.id} missing slash`).toContain("/")
    );
  });
});
