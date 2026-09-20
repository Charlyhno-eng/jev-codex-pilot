import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type AppConfig = {
  jevProvider: string;
  aiGatewayApiKey: string;
  telegramBotToken: string;
  telegramAllowedChatId: string;
  telegramEnabled: boolean;
};

const defaults = (): AppConfig => ({ jevProvider: "vercel-ai-gateway", aiGatewayApiKey: "", telegramBotToken: "", telegramAllowedChatId: "", telegramEnabled: false });

function tomlString(value: string): string { return JSON.stringify(value); }
function valueFor(content: string, section: string, key: string): string | undefined {
  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`(?:^|\\n)\\s*\\[${escapedSection}\\][\\s\\S]*?(?=\\n\\s*\\[|$)`));
  return match?.[0].match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.*?)\\s*(?:#.*)?$`, "m"))?.[1];
}
function quoted(value: string | undefined): string {
  if (!value) return "";
  try { const parsed: unknown = JSON.parse(value); return typeof parsed === "string" ? parsed : ""; } catch { return ""; }
}
function boolean(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export class AppConfigStore {
  readonly file: string;
  constructor(file = resolve(process.cwd(), "config/config.toml")) { this.file = file; }
  read(): AppConfig {
    if (!existsSync(this.file)) return defaults();
    const content = readFileSync(this.file, "utf8");
    const provider = quoted(valueFor(content, "jev", "provider"));
    return {
      jevProvider: provider || "vercel-ai-gateway",
      aiGatewayApiKey: quoted(valueFor(content, "vercel_ai_gateway", "api_key")),
      telegramBotToken: quoted(valueFor(content, "telegram", "bot_token")),
      telegramAllowedChatId: quoted(valueFor(content, "telegram", "allowed_chat_id")),
      telegramEnabled: boolean(valueFor(content, "telegram", "enabled")) ?? false
    };
  }
  write(change: Partial<AppConfig>): AppConfig {
    const next = { ...this.read(), ...change };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `# Local-only JEV Codex Pilot settings. Do not commit this file.\n\n[jev]\n# Provider adapter selected by the application. Add a new adapter in src/core/jev-provider.ts when this changes.\nprovider = ${tomlString(next.jevProvider)}\n\n[vercel_ai_gateway]\n# API key used by JEV through Vercel AI Gateway.\napi_key = ${tomlString(next.aiGatewayApiKey)}\n\n[telegram]\n# Optional local Telegram integration. The bot only accepts this one private chat.\nenabled = ${next.telegramEnabled}\nbot_token = ${tomlString(next.telegramBotToken)}\nallowed_chat_id = ${tomlString(next.telegramAllowedChatId)}\n`, "utf8");
    return next;
  }
}

export function maskedApiKey(apiKey: string): string {
  if (!apiKey) return "";
  return "••••••••";
}
