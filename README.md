![JEV Codex Pilot banner](assets/jev-codex-pilot-banner2.png)

# JEV Codex Pilot

JEV Codex Pilot is a local control center for turning software ideas into focused, traceable Codex work. It gives each ticket a clear path from project understanding to implementation, verification, recovery, and review. JEV analyses the request before execution, identifies the relevant project context, recommends the right model and reasoning effort, and keeps the full run visible in one place.

The main goal is a more deliberate development workflow. JEV turns broad requests into actionable tickets, gives Codex a bounded starting set of relevant files, adapts model effort during the run, validates only the changed surface, and stops when the result is already satisfactory. It records routing decisions, verification notes, token usage, session limits, interruptions, and recoverable errors so long running work remains understandable and manageable.

It is designed to reduce unnecessary Codex work as a consequence of that workflow. JEV records estimates and actual Codex usage per ticket so the effect can be reviewed in the application instead of assumed.

You keep control at every stage. Review the project files and Git state, edit `AGENTS.md`, inspect live Codex events, follow verification results, recover interrupted tasks, and review local changes from one workspace. The execution history makes it clear what JEV decided, what Codex changed, which checks ran, and why a ticket completed, paused, or needs attention. Token totals are reported from completed Codex turns, while account usage is clearly labelled when available.

JEV currently uses the **Vercel AI Gateway API** for ticket analysis and usage data. Its model connection, provider identifiers, dashboard URL, and credit lookup are isolated in `src/core/vercel-ai-gateway.ts`. The evaluation questions remain provider-neutral, so a direct TypeSafe API adapter can be added without duplicating JEV's decision logic.

Codex model IDs and the allowed model:reasoning routes for each complexity score from 0 to 5 are configured in `config/model.toml`. The first route at each level is JEV's default; the remaining routes are available for manual tuning before launch. Edit `[models]` to replace model IDs and `[complexity.N]` routes to change routing without code changes, then restart the application. JEV keeps the selected model for the complete ticket so cached context remains reusable. Documentation continuations and verification use Low on that model; implementation and repairs use the configured efforts for the selected complexity level. GPT-5.6 Sol appears in the benchmark below only for comparison.

### Complexity-based routing

The recommendation for 23 September 2026 was supplied for this project and is inspired by DeepSWE, AutomationBench, Agents’ Last Exam, OSWorld, and Artificial Analysis indexes. It guides the editable defaults below; it is not a measured result from this application. JEV scores each ticket from 0 to 5 at Kanban submission. The complexity score replaces the former standalone-delivery score; expected-outcome clarity remains advisory.

| Complexity | Typical work | Configured default | Other allowed routes |
| --- | --- | --- | --- |
| 0 | Documentation, tests, installation commands | GPT-6 Luna Low | Luna Medium |
| 1 | Small features, light refactors, short scripts, technical Q&A | GPT-6 Luna Medium | Luna High |
| 2 | Medium features, standard debugging, limited multi-file work | GPT-6 Sol Medium | Luna High/Max; Sol Low |
| 3 | Complex multi-step features, non-trivial refactors, multi-tool work | GPT-6 Sol Medium | Sol High |
| 4 | Difficult architecture or debugging, long-horizon work | GPT-6 Sol Extra High | Sol Max; Astra Low/Medium |
| 5 | Frontier or critical security, science, or major architecture | GPT-6 Astra High | — |

The first `routes` entry in each `[complexity.N]` section is the default. Every entry uses a model key from `[models]` and an effort from `[reasoning]`. JEV rejects invalid routes at startup. Manual model and effort controls offer only routes listed for the ticket's score. Existing saved tickets with the former text-based complexity labels are converted when loaded. Pending recommendations whose model and effort are no longer allowed are refreshed to the new default route; completed history keeps its recorded execution route.

### Model routing benchmark

This historical task-performance and approximate per-task cost table was supplied for comparison. It is separate from the editable routing configuration.

| Effort | **GPT-6 Luna** Score | Cost | **GPT-6 Sol** Score | Cost | **GPT-5.6 Sol** Score | Cost | **GPT-6 Astra** Score | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Low** | 2.4% | ~$0.006 | 37.2% | ~$0.16 | 45.4% | ~$1.07 | **67.0%** | **~$1.60** |
| **Medium** | 44.5% | ~$0.052 | 56.6% | ~$0.38 | 61.1% | ~$1.86 | **72.8%** | **~$3.08** |
| **High** | 59.3% | ~$0.084 | 65.3% | ~$0.64 | 69.4% | ~$3.47 | **73.2%** | **~$3.92** |
| **XHigh** | 61.3% | ~$0.11 | 66.6% | ~$1.00 | 70.7% | ~$4.70 | **74.1%** | **~$4.43** |
| **Max** | 66.6% | ~$0.22 | 68.8% | ~$2.74 | 72.7% | ~$8.39 | **73.2%** | **~$7.50** |

## How JEV reduces unnecessary Codex work

JEV makes small, bounded decisions before asking Codex to reason through a full turn. The table shows where token savings can come from. The ranges describe the affected part of a workflow, so they should not be added together.

### Expected token savings

| Workload | Estimated Codex token reduction |
| --- | ---: |
| Clear, focused ticket | **10–25%** |
| Typical work in an established project | **25–45%** |
| Long session with large context and targeted verification | **40–55%** |
| Unusually favourable case | **Up to 60%** |

These are practical estimates, not guaranteed results. Repository size, ticket quality, cache reuse, and genuine repair work have a material effect. JEV itself uses small typed evaluations, so the estimated **net reduction across all LLM usage** is more conservatively **15–35%** until project metrics provide a measured baseline.

| Optimisation | What JEV does | Typical Codex impact |
| --- | --- | --- |
| Relevant-file context | Identifies the files Codex should inspect first and sends the affected files forward for verification. | Avoids loading unrelated code; often the largest saving on established repositories. |
| Typed decision offload | Handles boolean checks, multiple choices, scores, routing, and validation judgments through compact Noul, Choice, and Score requests. Uncertain answers escalate to Codex. | Removes full Codex turns for decisions that do not need prose or code. |
| Cost-aware model and effort routing | Scores each task from 0 to 5 and selects the first configured route for that level. The model stays fixed; documentation continuations and verification use Low, while implementation and repair efforts follow the configured routes. | Uses each model only where its benchmarked quality justifies its cost and preserves cached context across development turns. |
| Targeted verification | Reviews the actual changed files and approves tests that cover that surface. Environment-blocked checks finish with a note instead of entering a repair loop. | Avoids broad test runs and repeated investigations caused by missing local dependencies. |
| Early validation stop | Stops repair and analysis turns as soon as the required checks are satisfied. | Saves the extra turns that simple tickets often spend rechecking a completed result. |
| Context diet and thread continuity | Reviews tool output and protects errors, paths, and test evidence before compaction. Between queued tickets, JEV compares the completed work with the next task: independent work starts in a cleared thread; related work keeps its thread and compacts after three successful tasks or at 90,000 context tokens. | Keeps useful context for related work and removes stale conversation from independent work. The native pre-compaction review is advisory. |
| Compatible ticket grouping | May execute related queued tickets in one shared run when JEV finds a task dependency and their route settings are close enough. | Reduces repeated project orientation and allows more cache reuse. |

When adding several tasks, JEV classifies their links after model evaluation, keeps related tasks together, and groups independent work by selected model to reduce model switches and preserve cache reuse. Select **Keep the exact order shown above** to execute the submitted sequence instead. The selected order appears in the Kanban task numbers. JEV refreshes automatic classification at launch if model recommendations were adjusted.

JEV keeps a context cache in `.jev/thread-state.json` for each active Codex thread. It stores SHA-256 fingerprints of selected regular project files up to 2 MB, never their contents. After a successful ticket, unchanged files can be reused from the existing conversation instead of being read again for orientation; Codex still reads a file when the current task needs its exact text. A changed file is read again. The cache is cleared when the thread changes, a ticket fails, or `/clear` or `/compact` runs.

JEV also watches each Codex turn for repeated actions. Three identical failed commands, four identical completed actions, or a six-action two-step cycle trigger a progress check. A repeated request for the same implementation route without file changes is also stopped before another turn. If no project file changed during the sequence, JEV stops Codex, marks the ticket as failed with a visible `loop` reason, and does not automatically retry that ticket later in the batch. The action detector resets between implementation, verification, and repair turns, and existing turn and repair limits still apply.

The shell gate is part of the same control layer: before a shell command, JEV checks its relevance and risk. It is fail-open when JEV is unavailable, and it logs the decision without exposing the raw command. This protects workflow quality without turning a temporary analysis issue into a blocked Codex session.

Each completed ticket shows the planning estimate, actual Codex tokens, cached input, turns, repair count, model routes, validation outcome, and available Codex session limits. These measurements make it possible to compare workflow changes against real usage over time.

## See JEV Codex Pilot in action

![JEV Codex Pilot page1](assets/jev-codex-pilot-demo.gif)

## Quickstart

### Install

```bash
npm install
```

### Run

```bash
npm run dev
```

Open `http://localhost:5173`, configure the available provider in Settings, then select or create a local project.

During development, JEV keeps the ticket's selected Codex model fixed and changes only reasoning effort within the configured routes for its complexity level. Documentation and mechanical work can use Low, targeted verification always uses Low on the selected model, and failed checks can raise effort for repair without losing the model's cached context. Every route, hook decision, selected context file, command gate, and context-diet action is visible in the backend logs and execution console.

JEV scores expected-outcome clarity and task complexity when the ticket is added to the Kanban board. Clarity is advisory; the 0–5 complexity score selects the default model and reasoning route. Neither score blocks execution.

## Telegram

The optional Telegram bot provides a private progress view, guided ticket creation, and explicit Codex launches. It is disabled by default, pairs one private chat, and sends a completion summary when a development run ends. Each finished ticket in that notice includes its remaining context window and 5-hour Codex limit, when available. The ticket's Codex Summary shows the captured context window, 5-hour limit, and weekly limit at the top; older tickets without a snapshot show unavailable values.

## Project principles

- JEV analyses projects without changing their files or running their tests.
- Codex runs only after an explicit user action.
- Project history, context, and execution data remain separated per project.
- API keys stay local and are never shown in logs or UI output.
