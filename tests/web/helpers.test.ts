import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTree } from "../../src/web/components/ProjectTree.js";
import { api } from "../../src/web/lib/api.js";
import { formatNumber, formatUsd, reasoningLabel, verificationLabel } from "../../src/web/lib/format.js";

afterEach(() => vi.unstubAllGlobals());

describe("web helpers", () => {
  it("groups files into sorted folders without dropping nested files", () => {
    const tree = buildTree([{ path: "z.txt", size: 1 }, { path: "src/b.ts", size: 2 }, { path: "src/a.ts", size: 3 }]);
    expect(tree.map(node => node.name)).toEqual(["src", "z.txt"]);
    expect(tree[0].children.map(node => node.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(tree[0].children[0].file?.size).toBe(3);
  });

  it("keeps status and numeric display labels stable", () => {
    expect(formatNumber()).toBe("—");
    expect(formatNumber(1234)).toContain("1");
    expect(formatUsd(0.123456)).toContain("0.123456");
    expect(reasoningLabel("xhigh")).toBe("Extra high");
    expect(verificationLabel("tests_passed")).toBe("Automated tests passed");
    expect(verificationLabel("unknown")).toBe("No verification detected");
  });

  it("returns API data and surfaces server and fallback errors", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ count: 2 }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Invalid ticket" }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetcher);
    await expect(api<{ count: number }>("/jobs")).resolves.toEqual({ count: 2 });
    expect(fetcher).toHaveBeenCalledWith("/api/jobs", { headers: { "Content-Type": "application/json" } });
    await expect(api("/jobs", { method: "POST" })).rejects.toThrow("Invalid ticket");
    await expect(api("/jobs")).rejects.toThrow("Something went wrong");
  });
});
