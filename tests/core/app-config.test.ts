import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConfigStore, maskedApiKey } from "../../src/core/app-config.js";

describe("local app configuration", () => {
  it("persists the Gateway key without a configurable JEV input rate", () => {
    const store = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "jev-config-")), "config.toml"));
    store.write({ aiGatewayApiKey: "vck_example_1234" });
    expect(store.read()).toEqual({ jevProvider: "vercel-ai-gateway", aiGatewayApiKey: "vck_example_1234" });
    expect(readFileSync(store.file, "utf8")).not.toContain("input_usd_per_million_tokens");
    store.write({ jevProvider: "future-provider" });
    expect(store.read().jevProvider).toBe("future-provider");
    expect(maskedApiKey("vck_example_1234")).toBe("••••••••");
  });

  it("creates private default settings in a missing directory", () => {
    const store = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "jev-config-")), "config.toml"));
    expect(store.read()).toEqual({ jevProvider: "vercel-ai-gateway", aiGatewayApiKey: "" });
    expect(maskedApiKey("")).toBe("");
    expect(readFileSync(store.file, "utf8")).toContain('api_key = ""');
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    const nested = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "jev-config-")), "config", "config.toml"));
    expect(nested.read()).toEqual(store.read());
  });

  it("ignores obsolete sections and removes them when settings are saved", () => {
    const store = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "jev-config-")), "config.toml"));
    writeFileSync(store.file, '[jev]\nprovider = "custom-provider"\n[vercel_ai_gateway]\napi_key = "test-key"\n[obsolete_integration]\nenabled = true\ncredential = "obsolete-key"\n');
    const original = readFileSync(store.file, "utf8");
    new AppConfigStore(store.file);
    expect(readFileSync(store.file, "utf8")).toBe(original);
    expect(store.read()).toEqual({ jevProvider: "custom-provider", aiGatewayApiKey: "test-key" });
    store.write({ aiGatewayApiKey: "replacement-key" });
    expect(store.read()).toEqual({ jevProvider: "custom-provider", aiGatewayApiKey: "replacement-key" });
    expect(readFileSync(store.file, "utf8")).not.toMatch(/obsolete|test-key/);
  });
});
