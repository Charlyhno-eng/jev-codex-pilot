import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConfigStore, maskedApiKey } from "./app-config.js";

describe("local app configuration", () => {
  it("persists the Gateway key without a configurable JEV input rate", () => {
    const store = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "jev-config-")), "config.toml"));
    store.write({ aiGatewayApiKey: "vck_example_1234" });
    expect(store.read()).toEqual({ jevProvider: "vercel-ai-gateway", aiGatewayApiKey: "vck_example_1234", telegramBotToken: "", telegramAllowedChatId: "", telegramEnabled: false });
    expect(readFileSync(store.file, "utf8")).not.toContain("input_usd_per_million_tokens");
    store.write({ jevProvider: "future-provider" });
    expect(store.read().jevProvider).toBe("future-provider");
    expect(maskedApiKey("vck_example_1234")).toBe("••••••••");
  });

  it("keeps Telegram private settings in the same local TOML file", () => {
    const store = new AppConfigStore(join(mkdtempSync(join(tmpdir(), "jev-config-")), "config.toml"));
    store.write({ telegramBotToken: "123:telegram-example", telegramAllowedChatId: "-100123", telegramEnabled: true });
    expect(store.read()).toMatchObject({ telegramBotToken: "123:telegram-example", telegramAllowedChatId: "-100123", telegramEnabled: true });
    expect(readFileSync(store.file, "utf8")).toContain("[telegram]");
  });
});
