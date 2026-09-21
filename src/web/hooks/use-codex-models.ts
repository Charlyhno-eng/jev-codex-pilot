import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export type CodexCatalog = { models: Record<string, string>; modelLevels: string[]; reasoningLevels: string[] };
const fallback: CodexCatalog = {
  models: { luna: "Luna", terra: "Terra", sol: "Sol" },
  modelLevels: ["luna", "terra", "sol"],
  reasoningLevels: ["low", "medium", "high", "xhigh"]
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
