import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export type CodexCatalog = { models: Record<string, string>; modelLevels: string[]; reasoningLevels: string[]; complexityRoutes?: Record<string, Array<{ model: string; reasoning: string }>> };
const fallback: CodexCatalog = {
  models: { luna: "gpt-6-luna", sol: "gpt-6-sol", astra: "gpt-6-astra" },
  modelLevels: ["luna", "sol", "astra"],
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"]
};
let cached = fallback;

export function useCodexModels() {
  const [catalog, setCatalog] = useState(cached);
  useEffect(() => {
    let active = true;
    void api<CodexCatalog>("/codex-models").then(value => { cached = value; if (active) setCatalog(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return catalog;
}
