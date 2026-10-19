import type { AccountUsage, ExecutionEvent, ExecutionPhase, ExecutionStatusSnapshot, ExecutionUsage, Job, JobAttachment, ModelKey, Reasoning } from "../types.js";
import type { ModelRoute } from "../model-routing.js";

/** Provider-owned local state passed back unchanged by the ticket engine. */
export interface ExecutionContext {
  projectPath: string;
  stateDirectory?: string;
}

/** Progress reported by an execution adapter independently of its wire protocol. */
export interface ExecutionUpdate {
  phase: ExecutionPhase;
  event?: Omit<ExecutionEvent, "id" | "timestamp">;
  threadId?: string;
  usage?: ExecutionUsage;
  verification?: "build_only" | "tests_passed" | "functional_verified";
}

/** One execution turn, optionally continuing the provider's own conversation. */
export interface ExecutionRequest {
  context: ExecutionContext;
  threadId?: string;
  model: string;
  reasoning: Reasoning;
  prompt: string;
  attachments: JobAttachment[];
  taskDescription: string;
  logTag: string;
}

/** Output observers used without exposing child processes or vendor JSON to the engine. */
export interface ExecutionObserver {
  onStart(info: { pid?: number; command: string }): void;
  onOutput(line: string): void;
  onUpdate(update: ExecutionUpdate): void;
}

/** The outcome of one turn; retry and ticket-completion policy belongs to JEV. */
export interface ExecutionResult {
  success: boolean;
  error?: string;
  implementationBlocked: boolean;
  quotaReached: boolean;
  retryAt?: string;
  requestedRoute?: ModelRoute;
}

/** Account quota availability reported by an execution provider. */
export interface ExecutionRateLimit {
  available: boolean;
  reached: boolean;
  resetsAt?: string;
  unavailableReason?: string;
}

/** Boundary implemented by each coding AI; methods must remain idle until explicitly called. */
export interface ExecutionProvider {
  id: string;
  label: string;
  capabilities: { resume: boolean; images: boolean; compaction: boolean; archive: boolean };
  /** Prepares provider state without executing work in the target project. */
  createContext(projectId: string, projectPath: string, threadIds: string[]): ExecutionContext;
  /** Resolves the configured route without contacting the provider. */
  modelId(model: ModelKey): string;
  /** Resolves an installed model immediately before execution. */
  resolveModel(model: ModelKey): Promise<string>;
  /** Returns the available model IDs for the application's stable routing keys. */
  models(): Promise<Record<string, string>>;
  /** Builds a display-only launch preview. */
  command(job: Job): Promise<string>;
  /** Executes one turn and translates its progress and outcome into common types. */
  run(request: ExecutionRequest, observer: ExecutionObserver): Promise<ExecutionResult>;
  /** Compacts a conversation when the provider advertises this capability. */
  compactThread(threadId: string, context: ExecutionContext): Promise<void>;
  /** Archives a conversation when the provider advertises this capability. */
  archiveThread(threadId: string, context: ExecutionContext): Promise<void>;
  /** Reads optional account-wide token usage, without attributing it to a ticket. */
  readAccountUsage(): Promise<AccountUsage>;
  /** Reads the account's current execution limits. */
  readRateLimit(): Promise<ExecutionRateLimit>;
  /** Reads optional context and quota status after a turn. */
  readStatus(threadId?: string, context?: ExecutionContext): Promise<ExecutionStatusSnapshot>;
  /** Recognizes a reported implementation blocker in saved provider output. */
  implementationBlocked(output: string): boolean;
  /** Verifies process ownership before orphan recovery can send a signal. */
  ownsProcess(arguments_: string[]): boolean;
}
