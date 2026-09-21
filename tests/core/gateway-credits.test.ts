import { describe, expect, it } from "vitest";
import { fetchGatewayCredits } from "../../src/core/gateway-credits.js";

describe("Vercel AI Gateway credits", () => {
  it("returns the balance received from the private credits endpoint", async () => {
    const balance = await fetchGatewayCredits("secret", async (_url, init) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer secret" });
      return new Response(JSON.stringify({ balance: "4.25" }), { status: 200 });
    });
    expect(balance).toBe(4.25);
  });

  it("rejects unavailable or malformed balances", async () => {
    await expect(fetchGatewayCredits("secret", async () => new Response("", { status: 503 }))).rejects.toThrow("temporarily unavailable (503)");
    await expect(fetchGatewayCredits("secret", async () => new Response(JSON.stringify({ balance: "nope" })))).rejects.toThrow("invalid credit balance");
  });
});
