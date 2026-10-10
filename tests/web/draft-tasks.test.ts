import { describe, expect, it } from "vitest";
import { remainingDraftTasks } from "../../src/web/lib/draft-tasks.js";
import type { DraftTask } from "../../src/web/lib/types.js";

describe("draft preservation during submission", () => {
  it("removes saved drafts and preserves newly added or previously unsent drafts", () => {
    const submitted: DraftTask = { id: "submitted", description: "Save this ticket" };
    const blank: DraftTask = { id: "unsent", description: "" };
    const added: DraftTask = { id: "new", description: "Typed while saving" };
    expect(remainingDraftTasks([submitted, blank, added], [submitted])).toEqual([blank, added]);
  });

  it("keeps changed descriptions, images, and skills while clearing unchanged confirmed drafts", () => {
    const submitted: DraftTask = { id: "submitted", description: "Save this ticket", attachments: [], skills: [] };
    for (const changed of [
      { ...submitted, description: "Edited while saving" },
      { ...submitted, attachments: [{ id: "image", name: "a.png", mimeType: "image/png", base64: "aA==", previewUrl: "data:image/png;base64,aA==" }] },
      { ...submitted, skills: [{ id: "skill", name: "skill", description: "New selection" }] }
    ]) expect(remainingDraftTasks([changed], [submitted])).toEqual([changed]);
    expect(remainingDraftTasks([{ ...submitted, confirmed: true }], [submitted])).toEqual([]);
  });
});
