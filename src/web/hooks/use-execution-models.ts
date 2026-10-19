import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export type ExecutionCatalog = { models: Record<string, string>; modelLevels: string[]; reasoningLevels: string[]; complexityRoutes?: Record<string, Array<{ model: string; reasoning: string }>> };
const fallback: ExecutionCatalog = {
  models: { luna: "gpt-6-luna", sol: "gpt-6.1-sol", astra: "gpt-6-astra" },
  modelLevels: ["luna", "sol", "astra"],
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"]
};
let cached = fallback;

/** Loads and caches the configured execution model catalog. */
export function useExecutionModels() {
  const [catalog, setCatalog] = useState(cached);
  useEffect(() => {
    let active = true;
    void api<ExecutionCatalog>("/execution-models").then(value => { cached = value; if (active) setCatalog(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return catalog;
}
