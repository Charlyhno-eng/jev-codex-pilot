import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskComposer } from "../../src/web/components/TaskComposer.js";

function composer(pendingCount: number, executionBlocked = false) {
  return renderToStaticMarkup(<TaskComposer pendingCount={pendingCount} executionBlocked={executionBlocked} launching={false} externalError="" onCreate={async () => {}} onRun={async () => {}}/>);
}

describe("isolated ticket composer", () => {
  it("preserves execution of saved tickets with an empty local draft", () => {
    const markup = composer(1);
    const action = markup.match(/<button type="submit"[^>]*>/)?.[0];
    expect(action).toBeDefined();
    expect(action).not.toContain("disabled");
    expect(markup).toContain("Run 1 task");
    expect(markup).toContain('aria-label="Ticket 1 description"');
    expect(markup).toContain("Add image");
    expect(markup).toContain("Add skill");
  });

  it("preserves empty-queue and active-execution guards", () => {
    for (const markup of [composer(0), composer(1, true)]) {
      expect(markup.match(/<button type="submit"[^>]*>/)?.[0]).toContain("disabled");
    }
  });
});
