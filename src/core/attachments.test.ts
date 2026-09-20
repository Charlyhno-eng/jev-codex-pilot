import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentStore } from "./attachments.js";

describe("task image attachments", () => {
  it("stores a supported image locally without putting its data in the task record", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-attachments-"));
    const attachments = new AttachmentStore(root);
    const [image] = attachments.saveForJob("task-1", [{ name: "bug.png", mimeType: "image/png", base64: Buffer.from("png bytes").toString("base64") }]);

    expect(image.name).toBe("bug.png");
    expect(image.mimeType).toBe("image/png");
    expect(image.path).toContain(join("attachments", "task-1"));
    expect(existsSync(image.path)).toBe(true);
    expect(Object.keys(image)).not.toContain("base64");
  });

  it("rejects unsupported image types before creating a ticket attachment", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-attachments-invalid-"));
    const attachments = new AttachmentStore(root);
    expect(() => attachments.saveForJob("task-1", [{ name: "note.txt", mimeType: "text/plain", base64: "dGV4dA==" }])).toThrow("Only PNG, JPEG, GIF, and WebP");
  });
});
