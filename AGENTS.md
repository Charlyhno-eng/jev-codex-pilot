# JEV Codex Pilot

JEV Codex Pilot turns software requests into traceable Codex tickets. The API lives in `src/api`, the ticket engine in `src/core`, and the web app in `src/web`. The project also includes an optional private Telegram bot, a headless `jc-pilot` CLI, and a paired benchmark runner documented in the README and `docs/benchmark.md`.

JEV scores and routes tickets by complexity, keeps project history in `.jev/`, and lets Codex choose and run task checks. It preserves related work in a Codex thread, clears unrelated work, compacts long context at 100,000 tokens, and stops repeated failed actions when the project has not changed. The optional private Telegram bot supports progress updates and guided ticket creation. The headless CLI runs tickets through the same engine, one command at a time in queue order. The paired benchmark runner compares JEV with direct Codex runs.

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
