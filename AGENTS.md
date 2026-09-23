# JEV Codex Pilot

- API: `src/api`; JEV: `src/core`; web: `src/web`.
- JEV does not change target project code or run its tests. Project `AGENTS.md` is created or edited through the user flow. Codex runs only after an explicit API or Run action.
- Preserve project state and history in `.jev/`. Never expose secrets in code, logs, documentation, or the UI.
- Keep project instructions short and task focused. Record durable product behavior in README.md.
- Give every exported function a concise JSDoc comment explaining its purpose; keep it adjacent to the export.
- Append one concise English bullet here for each delivered change. Earlier notes are archived in `docs/agents-history.md`.

## Delivery log

- Added JEV task continuity review to separate unrelated tickets, clear their threads, and compact related work at existing thresholds.
- Simplified project AGENTS.md templates and stopped adding delivery notes to them after every ticket.
- Moved ticket scoring to Kanban submission and replaced precision and breakdown with outcome clarity and standalone delivery.
- Colored automatic and manual `/clear` and `/compact` terminal logs orange with other JEV decisions.
- Isolated the Vercel AI Gateway adapter and added cache-preserving Luna/Sol routing across five reasoning levels.
- Replaced GPT-5.6 Sol with GPT-6 Astra and constrained each model to its benchmark-backed reasoning range.
- Displayed Codex context and quota snapshots above ticket history and added context and 5-hour usage to Telegram completion notices.
- Classified task batches by related work and model for cache reuse, with an optional exact execution order.
- Cached unchanged context file fingerprints per Codex thread and invalidated them on changes or thread resets.
- Stopped repetitive Codex command and message loops without project progress and prevented automatic loop retries.
- Replaced standalone delivery with six-level complexity scoring and configurable per-level Codex model and reasoning routes.
- Clarified TOML model routing, DeepSWE benchmark context, measured token reporting, and per-ticket Telegram status in the README.
- Preserved the selected queue ticket during live refreshes so pending work remains inspectable and editable while another ticket runs.
- Added contribution guidance welcoming feedback and bug reports via X while declining code submissions for review.
- Added a headless jc-pilot CLI that runs tickets through the shared JEV and Codex engine from a project directory.
- Documented a cross-platform Node entry point for the CLI that avoids global npm links and shell setup.
- Made CLI help print its actual path and clarified that target projects do not need Node.js.
- Applied workspace write permissions to every Codex turn, rejected empty implementations, and stopped reusing blocked threads.
- Added a user-local jc-pilot command installer for Linux, macOS, and Windows without global npm permissions.
- Removed the incompatible explicit sandbox flag from Codex execution and resume commands; automatic approval review already enables workspace writes.
- Clarified CLI setup and target-directory commands, automatic path discovery, and storage of machine-specific launcher paths outside the repository.
- Removed unused code, documented exported functions, and added regression tests for Telegram and web helpers.
- Collapsed the JEV activity log by default in the Codex console while keeping it expandable.
- Sent Telegram completion notices for locally run CLI tickets without changing ticket results on delivery failure.
- Added GitHub Actions CI for clean installation, build, TypeScript checks, and the full test suite.
