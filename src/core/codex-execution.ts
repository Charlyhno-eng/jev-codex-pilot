/** --approve-for-me includes workspace-write and conflicts with --sandbox.
 * Exec-level permissions must precede the resume subcommand. */
export function codexExecPrefix(resume = false): string[] {
  return ["exec", "--approve-for-me", "--color", "never", ...(resume ? ["resume"] : [])];
}

/** Read the final response, rather than treating quoted errors or reasoning as a failure. */
export function implementationBlocked(output: string): boolean {
  let message: string | undefined;
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "item.completed" && event.item?.type === "agent_message") message = String(event.item.text ?? "");
    } catch { /* Older history can contain plain text. */ }
  }
  return /JEV_IMPLEMENTATION_BLOCKED|patch rejected|writing is blocked|impossible d['’]implémenter|could not implement|unable to implement|(?:cannot|can['’]t) (?:implement|modify|edit|write)|je ne peux pas (?:l['’])?(?:implémenter|modifier|écrire)|(?:workspace|environment|file system|filesystem)\s+(?:is|remains)(?:\s+still)?\s+read.only|(?:espace de travail|environnement)\s+(?:est|reste)(?:\s+toujours)?\s+en lecture seule/i.test(message ?? output);
}
