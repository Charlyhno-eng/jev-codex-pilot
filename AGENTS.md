# JEV Codex Pilot

JEV Codex Pilot turns software requests into traceable Codex tickets. The API lives in `src/api`, the ticket engine in `src/core`, and the web app in `src/web`. The project also includes a headless `jc-pilot` CLI and a paired benchmark runner documented in the README and `docs/benchmark.md`.

JEV scores and routes tickets by complexity, keeps project history in `.jev/`, and lets Codex choose and run task checks. It preserves related work in a Codex thread, clears unrelated work, compacts long context at 100,000 tokens, and stops repeated failed actions when the project has not changed. The headless CLI runs tickets through the same engine, one command at a time in queue order. The paired benchmark runner compares JEV with direct Codex runs.

Do not change target project code or run its tests as part of JEV. Create or edit a target project's `AGENTS.md` only through the user flow, and run Codex only after an explicit API or Run action. Never expose secrets in code, logs, documentation, or the UI. Keep project instructions short and task focused, and record durable product behavior in `README.md`.

Give every exported function a concise adjacent JSDoc comment explaining its purpose. Record each delivered change in this file as a concise English paragraph. Earlier delivery notes are archived in `docs/agents-history.md`.

This update documents the project overview and replaces the README's CLI loop example with sequential commands joined by `&&`.

This update replaces advisory context review with Jev-scored tool-pair compaction. Pre-compaction processing now preserves user and assistant text, classifies paired calls and results as `keep`, `drop_result`, or `drop_call`, stores a redacted private checkpoint, and restores missing critical context through Codex's post-compaction `SessionStart` lifecycle.

This update replaces the demo benchmark's recipe manager scenario with seven sequential English tasks for a frontend-only Three.js, TypeScript, and Tailwind laboratory portfolio.

This update refreshes the README's JEV benchmark summary with the September 27, 2026 laboratory-portfolio run results.

This update adds a global ticket counter to benchmark terminal progress and highlights baseline coding in fuchsia.

This update adds an interactive Codex-style terminal workspace to `jc-pilot`. Users can compose multiple tickets, enter multiline requests, review or edit the pending session list, and run the batch in queue order. The existing headless `run` and `status` commands remain available, and the README documents the new flow.

This update gives the interactive terminal workspace colored project, queue, and next-action panels with opaque backgrounds for readability. All terminal prompts and messages are in English, and the README now shows the target-project launch command explicitly.

This update simplifies the README terminal section to the one-time setup command and the command that opens the interactive interface from a target project.

This update expands the web Git workspace with branch creation and selection, recent commit diffs, and an optional per-project commit and push after each successful ticket. JEV preserves the selected branch, uses Codex's suggested commit subject, and stops a ticket sequence when Git delivery fails.

This update fixes quota-resume and native Codex hook assertions, removes no-longer-used Git review UI code and a duplicate CI type-check, and makes TypeScript fail on unused local declarations and parameters. CI now uses Ubuntu 24.04 to avoid the upcoming ubuntu-latest image migration.

This update makes pending model and reasoning controls span all configured levels, changes per-ticket Git automation to create local commits only, and adds a manual push action for the selected branch.

This update gives the task composer a compact action row and shows the six Kanban states in a responsive three-column layout. It also aligns the Git controls with the application's blue theme and confirms a successful manual push with its branch and remote.

This update coordinates Codex execution fairly across project queues, letting another project run after each ticket instead of waiting for a whole batch or overlapping Codex processes. The web workspace also resets its ticket selection when switching projects, so Run cannot target a ticket from the previous project.

This update replaces the shared Codex execution slot with truly parallel project runs. Each project now has a private Codex home and SQLite state, while existing authentication and settings are linked and prior project sessions are imported for continuity; thread resume, compaction, and archival use the same private home.

This update replaces the README's model benchmark charts with a DeepSWE-inspired table of reasoning effort scores and estimated task costs for five models.

This update routes complexity levels 1–2 to GPT-6 Luna Medium/High and levels 3–5 to GPT-6.1 Sol Low/Medium/High, aligning configuration, fallback models, failure escalation, and documentation.

This update fixes the saved-ticket migration test to expect Sol Medium for complexity level 4 under the new routing policy.

This update fixes image argument parsing by separating Codex options from positional prompts and session IDs, allows automatic Git tickets to start with uncommitted local changes, and enforces Conventional Commit subjects with a chore fallback. Existing local changes are included in the next successful ticket commit.

This update limits Git workspace review to all unpushed commits, clears stale commit selections after a push or refresh, and explains the empty state. Branches without upstream tracking use a matching remote branch or exclude commits already on known remote branches.

This update removes the private messaging integration, its configuration, completion notifications, interface controls, and dedicated tests. Provider settings and ticket execution remain available through the web app and CLI.

This update swaps the Done and Escalating Kanban columns and simplifies draft controls by removing the ready button and placing removal below the right-aligned reorder arrows.

This update adds distinct Kanban alerts for completed, failed, and escalated tickets, with louder multi-note audio signals, browser interaction audio activation, dismissible ticket descriptions, and project-scoped transition tracking.

This update adds a persisted per-project Human in the loop option that pauses after each ticket for explicit approval, provides Continue and final approval actions, and exposes pending-ticket re-evaluation alongside existing model and reasoning level adjustments. Automatic batch behavior remains unchanged when the option is disabled.

This update adds visible return-to-Pending actions for completed and failed tickets, hides Project files from the web workspace, and reduces the height of the Human in the loop project settings panel.

This update removes the Project settings heading and replaces return-to-Pending buttons with mouse drag and drop using native data transfer, draggable card containers, and highlights restricted to eligible destination columns.

This update enables mouse drag and drop to reorder Pending tickets with insertion markers, persists project-wide queue positions across batches and reloads, and uses the same order for the board and ticket execution without launching Codex when tickets are rearranged.

This update stretches the four sidebar controls to match the task composer height on desktop and allows Human in the loop to be changed during execution, applying the current setting when each ticket finishes.

This update resumes interrupted model escalations as Running tickets on the next explicit launch, preserves the selected route and partial-work thread across recovery and reload, and verifies that legacy recovery notices and earlier attempt errors do not block queue continuation.

This update keeps pending tickets running after automatic Git delivery or ticket startup failures, preserves visible error history and explicit human-review and session-limit pauses, and verifies queue continuation after related-thread compaction.
