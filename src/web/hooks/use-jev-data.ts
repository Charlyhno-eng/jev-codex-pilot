import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { Billing } from "../lib/types.js";
/** Polls the current AI Gateway credit balance. */
export function useBilling() {
  const [billing, setBilling] = useState<Billing>();
  const [error, setError] = useState("");
  useEffect(() => { const load = () => void api<Billing>("/billing").then(value => { setBilling(value); setError(""); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); load(); const timer = window.setInterval(load, 15_000); return () => clearInterval(timer); }, []);
  return { billing, error };
}
