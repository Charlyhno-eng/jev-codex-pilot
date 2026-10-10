import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueSubmitButton } from "../../src/web/components/QueueSubmitButton.js";

function button(overrides: Partial<Parameters<typeof QueueSubmitButton>[0]> = {}) {
  return renderToStaticMarkup(<QueueSubmitButton hasDrafts={false} pendingCount={1} executionBlocked={false} submitting={false} launching={false} {...overrides}/>);
}

describe("To do submission control", () => {
  it("enables running an existing setup ticket with an empty composer", () => {
    const markup = button();
    expect(markup).toContain('type="submit"');
    expect(markup).toContain("Run 1 task");
    expect(markup).not.toContain("disabled");
  });

  it("runs all pending tickets and remains enabled without a draft", () => {
    const markup = button({ pendingCount: 3 });
    expect(markup).toContain("Run 3 tasks");
    expect(markup).not.toContain("disabled");
  });

  it("disables submission only when both the composer and queue are empty", () => {
    expect(button({ pendingCount: 0 })).toContain("disabled");
    const markup = button({ pendingCount: 0, hasDrafts: true });
    expect(markup).toContain("Add &amp; evaluate");
    expect(markup).not.toContain("disabled");
  });

  it("blocks review submissions during execution while allowing them during a review pause", () => {
    expect(button({ executionBlocked: true })).toContain("disabled");
    expect(button({ executionBlocked: true, creationBlocked: true, hasDrafts: true })).toContain("disabled");
    expect(button({ executionBlocked: true, creationBlocked: false, hasDrafts: true })).not.toContain("disabled");
  });

  it.each([{ submitting: true }, { launching: true }])("prevents duplicate submission during a request: %j", state => {
    expect(button(state)).toContain("disabled");
  });
});
