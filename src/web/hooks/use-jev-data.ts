import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { Billing, JevUsage } from "../lib/types.js";
export function useBilling() {
  const [billing, setBilling] = useState<Billing>();
  const [error, setError] = useState("");
  useEffect(() => { const load = () => void api<Billing>("/billing").then(value => { setBilling(value); setError(""); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); load(); const timer = window.setInterval(load, 15_000); return () => clearInterval(timer); }, []);
  return { billing, error };
}

export function useJevUsage() {
  const [usage, setUsage] = useState<JevUsage>({ analyses: 0, inputTokens: 0, estimatedCostUsd: 0 });
  useEffect(() => { const load = () => void api<JevUsage>("/usage").then(setUsage).catch(() => undefined); load(); const timer = window.setInterval(load, 1_500); return () => clearInterval(timer); }, []);
  return usage;
}
