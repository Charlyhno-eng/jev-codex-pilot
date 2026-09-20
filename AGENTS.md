# JEV Codex Pilot

## Project boundaries

- The API server lives in `src/api`, the JEV engine in `src/core`, and the web interface in `src/web`.
- JEV only analyses target projects. It must never change target-project files or run their tests.
- Running Codex is explicitly opt-in through `POST /api/jobs/:id/run` or the Run button.
- Local development persistence is stored under `.jev/`; preserve existing projects, jobs, and history.
- Never expose API keys or other secrets in source code, logs, documentation, or UI output.

## Current product behavior

- Projects are selected or created locally and retain separate queues, task histories, and Codex threads.
- A project context is stored in its `AGENTS.md`. The UI can create it when absent and display or edit it in a large modal.
- JEV evaluates every task independently and recommends a Codex model, reasoning level, complexity score, context files, and likely files to modify.
- Codex models are limited to GPT-5.6 Luna, Terra, and Sol. Reasoning is limited to Low, Medium, High, and Extra High.
- Consecutive compatible tasks may share one Codex execution only when they use the same model and their reasoning levels differ by at most one step. Their JEV analyses and task histories remain independent.
- Codex execution streams live JSONL events, command activity, verification status, model and reasoning evidence, and token usage to the UI.
- Task token totals come from Codex `turn.completed` events. Account-wide Codex usage is captured as a best-effort app-server snapshot and must be labelled as account-wide.
- Successful work triggers automatic thread compaction after every third successful task. A compaction failure never changes a successful task into a failure.
- Failed tasks remain visible and can be moved manually. After a later task succeeds in the same batch, an earlier failed task is retried once automatically.
- Vercel AI Gateway configuration is stored in `config/config.toml`; the billing UI must distinguish an estimate from an explicitly configured balance.

## JEV Codex Pilot delivery log

This section is maintained by Codex. Append one concise English bullet for each completed feature or change.

- Added project workspaces, persistent task history, independent JEV task analysis, and per-project Codex thread reuse.
- Added project-context creation, viewing, and editing through `AGENTS.md`, plus a delivery-log convention for future Codex work.
- Added JEV model, reasoning, complexity, token-cost, verification, and live execution evidence in the web interface.
- Added Vercel AI Gateway settings and live/estimated credit presentation without exposing the API key.
- Added automatic Codex thread compaction after three successful tasks and visually distinct compaction events.
- Added task archiving, recovery controls, clearer project navigation, a completion sound, and protected batch launching.
- Added Codex task-token checkpoints, best-effort account-wide usage snapshots, and transparent unavailable-state handling.
- Added compatible-task prompt grouping for adjacent jobs that share a model and differ by no more than one reasoning level.
- Made compatible-task grouping direction-independent and added idle-only, project-scoped Codex `/compact` and reversible `/clear` controls with a persistent compaction counter.
- Extended grouping to the next compatible project ticket across submission batches, required English AGENTS.md and README.md updates from every Codex ticket, and added reversible project removal from the web workspace.
- Added reversible Success-to-Pending task recovery, pending-ticket editing with fresh JEV analysis and visual references, plus a read-only Git change-review workspace.
- Updated the Codex launch label to count exactly the currently pending tasks in the project queue.
- Made project change review prominent with a dedicated “Review changes” action and strengthened the “Create Workspace” control.
- Simplified the project header, added a dedicated Git-review card, and enabled previous/next navigation across task recommendations.
- Centered task-review navigation controls to keep previous and next actions aligned on narrow layouts.
- Removed the redundant Changes navbar link and grouped the Vercel credits and settings controls more tightly.
- Improved draft-task composition with mouse-friendly text editing, direct image attachments, auto-growing inputs, contextual JEV precision guidance, and a simplified launch-only execution action.
- Persisted a visible per-task JEV precision score, added queue scrolling after analysis and save-to-close context editing, and corrected Codex app-server compaction completion handling.
- Changed draft precision checks to run only when the user explicitly validates a task with the checkmark or Ctrl+Enter.
- Fixed JEV task-precision scoring to use the supported ten-level scale and added permanent pending-ticket removal from its editor.
- Added an optional, private-chat-only Telegram bot for per-project progress and guided pending-ticket creation, with local TOML configuration.
- Restored local credential reveal controls and added Telegram chat-ID pairing before private bot activation.
- Refined the Telegram bot with an English rich-message interface, masked token display, and chat clearing for bot-managed messages.
- Added Telegram-controlled Codex launch for explicitly selected projects that have pending tickets.
- Reworked Telegram as a button-guided dashboard after `/start`, including a reliable inline ticket-cancellation action.
- Rebuilt Telegram as a versioned single-screen flow with startup chat cleanup and confirmed deletion of newly created pending tickets.
