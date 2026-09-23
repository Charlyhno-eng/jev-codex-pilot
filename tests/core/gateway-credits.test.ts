import { describe, expect, it } from "vitest";
import { fetchVercelGatewayCredits } from "../../src/core/vercel-ai-gateway.js";

describe("Vercel AI Gateway credits", () => {
  it("returns the balance received from the private credits endpoint", async () => {
    const balance = await fetchVercelGatewayCredits("secret", async (_url, init) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer secret" });
      return new Response(JSON.stringify({ balance: "4.25" }), { status: 200 });
    });
    expect(balance).toBe(4.25);
  });

  it("rejects unavailable or malformed balances", async () => {
    await expect(fetchVercelGatewayCredits("secret", async () => new Response("", { status: 503 }))).rejects.toThrow("temporarily unavailable (503)");
    await expect(fetchVercelGatewayCredits("secret", async () => new Response(JSON.stringify({ balance: "nope" })))).rejects.toThrow("invalid credit balance");
  });
});
