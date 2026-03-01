import { describe, it, expect } from "vitest";
import { decryptValue, encryptValue } from "./config.js";

describe("encrypt/decrypt", () => {
  it("roundtrip preserves original value", () => {
    const original = "sk-test-api-key-12345678";
    expect(decryptValue(encryptValue(original))).toBe(original);
  });

  it("encrypted value is not plaintext", () => {
    const original = "super-secret-key";
    expect(encryptValue(original)).not.toContain(original);
  });

  it("two encryptions of same value produce different ciphertexts (random IV)", () => {
    const value = "same-key";
    expect(encryptValue(value)).not.toBe(encryptValue(value));
  });

  it("encrypted output contains IV separator colon", () => {
    expect(encryptValue("test")).toContain(":");
  });
});
