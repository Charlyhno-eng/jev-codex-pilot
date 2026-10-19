import { spawn } from "node:child_process";
import { MODEL_LEVELS, REASONING_LEVELS } from "../../model-routing.js";
import { ticketJevUsageEnv } from "../../jev-usage.js";
import { buildExecutionPrompt } from "../../prompt.js";
import type { ExecutionObserver, ExecutionProvider, ExecutionRequest, ExecutionResult } from "../types.js";
import { activeCodexModelId, availableCodexModels, selectCodexModelId, configuredCodexModelId } from "./catalog.js";
import { codexExecPrefix, implementationBlocked, retryTimeReported, sessionLimitReported } from "./outcome.js";
import { describeCodexEvent, type CodexJsonEvent } from "./events.js";
import { projectCodexEnv, projectCodexHome, projectCodexStateArgs } from "./home.js";
import { codexHookArgs } from "./hooks.js";
import { archiveThread, compactThread, readAccountUsage, readExecutionRateLimit } from "./lifecycle.js";
import { readCodexStatusSnapshot } from "./status.js";

function runCodex(request: ExecutionRequest, observer: ExecutionObserver): Promise<ExecutionResult> {
  return new Promise(resolve => {
    const home = request.context.stateDirectory!;
    const args = [
      ...codexExecPrefix(Boolean(request.threadId)), "--json", "--skip-git-repo-check", "--model", request.model,
      "-c", `model_reasoning_effort="${request.reasoning}"`, ...projectCodexStateArgs(home), ...codexHookArgs(),
      ...request.attachments.flatMap(image => ["--image", image.path]),
      "--", ...(request.threadId ? [request.threadId] : []), request.prompt
    ];
    const images = new Set(request.attachments.map(image => image.path));
    const visible = args.filter((arg, index) => !(/^(features\.hooks|hooks\.)/.test(arg) || (arg === "-c" && /^(features\.hooks|hooks\.)/.test(args[index + 1] ?? ""))));
    const command = `codex ${visible.map(arg => arg === request.prompt ? "<task prompt>" : images.has(arg) ? "<attached image>" : arg).join(" ")}`;
    const child = spawn("codex", args, {
      cwd: request.context.projectPath, shell: false,
      env: { ...projectCodexEnv(home), ...ticketJevUsageEnv(), JEV_HOOK_TASK: request.taskDescription.slice(0, 2_000) }
    });
    observer.onStart({ pid: child.pid, command });
    child.stdin.end();
    let buffer = "";
    let output = "";
    let blocked = false;
    let turnFailed = false;
    let settled = false;
    let requestedRoute: ExecutionResult["requestedRoute"];
    const record = (line: string) => {
      if (!line.trim()) return;
      output = `${output}${line}\n`.slice(-250_000);
      observer.onOutput(line);
      if (/^Reading additional input from stdin\.\.\.$/i.test(line.trim())) return;
      let parsed: CodexJsonEvent;
      try {
        const value: unknown = JSON.parse(line);
        parsed = value && typeof value === "object" && !Array.isArray(value) ? value as CodexJsonEvent : { type: "raw", message: line };
      } catch { parsed = { type: "raw", message: line }; }
      const nativeItem = parsed.item && typeof parsed.item === "object" && !Array.isArray(parsed.item) ? parsed.item : {};
      parsed.item = nativeItem;
      if ((parsed.type === "raw" || nativeItem.type === "error") && implementationBlocked(line)) blocked = true;
      if (parsed.type === "turn.failed" || parsed.type === "error") turnFailed = true;
      if (parsed.type === "item.completed" && nativeItem.type === "agent_message") {
        blocked = implementationBlocked(line);
        const match = String(nativeItem.text ?? "").match(/(?:^|\n)JEV_ROUTE=([\w-]+):([\w-]+)\s*$/);
        requestedRoute = match && MODEL_LEVELS.includes(match[1]) && REASONING_LEVELS.includes(match[2])
          ? { model: match[1], reasoning: match[2] } : undefined;
      }
      const description = describeCodexEvent(parsed);
      const update = { phase: description.phase, event: description.item, threadId: description.threadId };
      const usage = parsed.type === "turn.completed" && parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage)
        ? parsed.usage as Record<string, unknown> : undefined;
      const normalizedUsage = usage ? Object.fromEntries(["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"].filter(key => typeof usage[key] === "number" && Number.isFinite(usage[key]) && Number(usage[key]) >= 0).map(key => [key, usage[key]])) : undefined;
      let verification: "build_only" | "tests_passed" | "functional_verified" | undefined;
      if (parsed.type === "item.completed" && nativeItem.type === "command_execution" && nativeItem.exit_code === 0) {
        const command = String(nativeItem.command ?? "");
        if (/playwright|cypress|webdriver|browser/i.test(command)) verification = "functional_verified";
        else if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/i.test(command)) verification = "tests_passed";
        else if (/\b(build|tsc)\b/i.test(command)) verification = "build_only";
      }
      observer.onUpdate({ ...update, usage: normalizedUsage, verification });
    };
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (buffer) record(buffer);
      resolve({
        success: code === 0 && !error && !blocked && !turnFailed,
        error: error ?? (blocked ? "Codex reported that it could not implement the task" : turnFailed ? "Codex reported a failed turn" : code !== 0 ? `Codex exited with code ${code}` : undefined),
        implementationBlocked: blocked, quotaReached: sessionLimitReported(output), retryAt: retryTimeReported(output), requestedRoute
      });
    };
    child.stdout.on("data", chunk => {
      const value = chunk.toString(); process.stdout.write(`[codex:${request.logTag}] ${value}`);
      buffer += value;
      const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; lines.forEach(record);
    });
    child.stderr.on("data", chunk => { const value = chunk.toString(); process.stderr.write(`[codex:${request.logTag}] ${value}`); record(value.trim()); });
    child.on("error", error => finish(null, `Could not start Codex: ${error.message}`));
    child.stdin.on("error", error => finish(null, error.message));
    child.on("close", code => finish(code));
  });
}

/** Creates the Codex CLI adapter without launching a process or touching a target project. */
export function createCodexProvider(): ExecutionProvider {
  return {
    id: "codex", label: "Codex",
    capabilities: { resume: true, images: true, compaction: true, archive: true },
    createContext: (projectId, projectPath, threadIds) => ({ projectPath, stateDirectory: projectCodexHome(projectId, threadIds) }),
    modelId: configuredCodexModelId,
    resolveModel: activeCodexModelId,
    async models() {
      const available = await availableCodexModels();
      return Object.fromEntries(MODEL_LEVELS.map(tier => [tier, selectCodexModelId(tier, available)]));
    },
    async command(job) {
      const model = await activeCodexModelId(job.analysis!.model);
      const prompt = buildExecutionPrompt(job.tasks, job.analysis!, job.attachments, job.skills);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      return `codex ${codexExecPrefix().join(" ")} --json --skip-git-repo-check --model ${quote(model)} -c ${quote(`model_reasoning_effort="${job.analysis!.reasoning}"`)} ${job.attachments?.map(image => `--image ${quote(image.path)} `).join("") ?? ""}-- ${quote(prompt)}`;
    },
    run: runCodex,
    compactThread: (threadId, context) => compactThread(threadId, context.stateDirectory!),
    archiveThread: (threadId, context) => archiveThread(threadId, context.stateDirectory!),
    readAccountUsage,
    readRateLimit: readExecutionRateLimit,
    readStatus: (threadId, context) => readCodexStatusSnapshot(threadId, context?.stateDirectory),
    implementationBlocked,
    ownsProcess: arguments_ => arguments_.some(argument => /(?:^|\/)codex$/.test(argument))
  };
}
