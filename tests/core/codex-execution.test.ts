import { describe, expect, it } from "vitest";
import { implementationBlocked } from "../../src/core/codex-execution.js";

const response = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });

describe("implementation outcome", () => {
  it("recognizes the reported French read-only refusal", () => {
    expect(implementationBlocked(response("Je ne peux pas l’implémenter dans ce tour : l’espace de travail est toujours en lecture seule. Aucun fichier n’a été modifié."))).toBe(true);
  });

  it("uses the last response when a blocker was resolved during the turn", () => {
    const output = [response("Unable to implement the task."), response("The workspace is no longer read-only. Implemented the requested change in index.html.")].join("\n");
    expect(implementationBlocked(output)).toBe(false);
  });

  it("ignores blocked wording in tool output and reasoning after a successful response", () => {
    const output = [response("Implemented the requested change."), JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "fixture: writing is blocked" } })].join("\n");
    expect(implementationBlocked(output)).toBe(false);
  });
});
