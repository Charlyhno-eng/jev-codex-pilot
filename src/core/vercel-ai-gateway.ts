import { createGateway } from "@ai-sdk/gateway";

export const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
export const VERCEL_AI_GATEWAY_EVALUATOR_ID = "vercel-ai-gateway/typesafe-ai/jev";
export const VERCEL_AI_GATEWAY_DASHBOARD_URL = "https://vercel.com/ai-gateway";
const VERCEL_AI_GATEWAY_CREDITS_URL = "https://ai-gateway.vercel.sh/v1/credits";
const TYPESAFE_JEV_MODEL_ID = "typesafe-ai/jev";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Creates the TypeSafe JEV evaluation model through Vercel AI Gateway. */
export function createVercelJevModel(apiKey: string) {
  if (!apiKey) throw new Error("Configure a Vercel AI Gateway API key before analyzing a task.");
  return createGateway({ apiKey }).evaluationModel(TYPESAFE_JEV_MODEL_ID);
}

/** Retrieves the current Vercel AI Gateway balance without exposing the key to the browser. */
export async function fetchVercelGatewayCredits(apiKey: string, fetcher: Fetcher = fetch): Promise<number> {
  const response = await fetcher(VERCEL_AI_GATEWAY_CREDITS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Vercel AI Gateway credits are temporarily unavailable (${response.status}).`);

  const payload = await response.json() as { balance?: unknown };
  const balance = typeof payload.balance === "number" || typeof payload.balance === "string" ? Number(payload.balance) : Number.NaN;
  if (!Number.isFinite(balance) || balance < 0) throw new Error("Vercel AI Gateway returned an invalid credit balance.");
  return balance;
}
