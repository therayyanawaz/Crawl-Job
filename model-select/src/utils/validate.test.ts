import { describe, it, expect, vi } from "vitest";
import { validateApiKey } from "./validate.js";

describe("validateApiKey", () => {
  it("returns valid:true for unknown providers without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await validateApiKey("unknownprovider", "anykey");

    expect(result.valid).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns valid:true for none-auth providers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await validateApiKey("ollama", "");

    expect(result.valid).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
