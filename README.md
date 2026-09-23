![JEV Codex Pilot banner](assets/jev-codex-pilot-banner2.png)

# JEV Codex Pilot

JEV Codex Pilot is a local control center for turning software ideas into focused, traceable Codex work. It gives each ticket a clear path from project understanding to implementation, verification, recovery, and review. JEV analyses the request before execution, identifies the relevant project context, recommends the right model and reasoning effort, and keeps the full run visible in one place.

The main goal is a more deliberate development workflow. JEV turns broad requests into actionable tickets, gives Codex a bounded starting set of relevant files, adapts model effort during the run, validates only the changed surface, and stops when the result is already satisfactory. It records routing decisions, verification notes, token usage, session limits, interruptions, and recoverable errors so long running work remains understandable and manageable.

It is designed to reduce unnecessary Codex work as a consequence of that workflow. JEV records estimates and actual Codex usage per ticket so the effect can be reviewed in the application instead of assumed.

You keep control at every stage. Review the project files and Git state, edit `AGENTS.md`, inspect live Codex events, follow verification results, recover interrupted tasks, and review local changes from one workspace. The execution history makes it clear what JEV decided, what Codex changed, which checks ran, and why a ticket completed, paused, or needs attention. Token totals are reported from completed Codex turns, while account usage is clearly labelled when available.

JEV currently uses the **Vercel AI Gateway API** for ticket analysis and usage data. Its model connection, provider identifiers, dashboard URL, and credit lookup are isolated in `src/core/vercel-ai-gateway.ts`. The evaluation questions remain provider-neutral, so a direct TypeSafe API adapter can be added without duplicating JEV's decision logic.

Codex model IDs and the model:reasoning routes for complexity levels 0 to 5 are configured in `config/model.toml`. Each ticket's complexity selects the default route listed there; edit `[models]` or the corresponding `[complexity.N]` section and restart the application to change the model or effort without code changes. JEV keeps the selected model fixed for the ticket to preserve cached context. Documentation continuations and verification use Low on that model; implementation and repairs use the configured efforts. GPT-5.6 Terra and GPT-5.6 Sol are no longer used by the configured routes.

JEV assigns each ticket a complexity score from 0 to 5 when it enters the Kanban board. The recommended defaults below were supplied for this project based on DeepSWE, AutomationBench, Agents’ Last Exam, OSWorld, and Artificial Analysis indexes; the score is a routing input, not a measurement from this application. Expected-outcome clarity remains advisory.

---

## Model routing benchmark

This table reports the supplied DeepSWE benchmark scores and approximate per-task costs by reasoning effort. GPT-5.6 Sol is retained as a historical benchmark comparison; neither GPT-5.6 Terra nor GPT-5.6 Sol is used by the current routes. The routing defaults are configurable in `config/model.toml`.

|   Effort   | **GPT-6 Luna** — Score |    Coût | **GPT-6 Sol** — Score |   Coût | **GPT-5.6 Sol** — Score |   Coût | **GPT-6 Astra** — Score |       Coût |
| :--------: | ---------------------: | ------: | --------------------: | -----: | ----------------------: | -----: | ----------------------: | ---------: |
|   **Low**  |                   2.4% | ~$0.006 |                 37.2% | ~$0.16 |                   45.4% | ~$1.07 |               **67.0%** | **~$1.60** |
| **Medium** |                  44.5% | ~$0.052 |                 56.6% | ~$0.38 |                   61.1% | ~$1.86 |               **72.8%** | **~$3.08** |
|  **High**  |                  59.3% | ~$0.084 |                 65.3% | ~$0.64 |                   69.4% | ~$3.47 |               **73.2%** | **~$3.92** |
|  **XHigh** |                  61.3% |  ~$0.11 |                 66.6% | ~$1.00 |                   70.7% | ~$4.70 |               **74.1%** | **~$4.43** |
|   **Max**  |                  66.6% |  ~$0.22 |                 68.8% | ~$2.74 |                   72.7% | ~$8.39 |               **73.2%** | **~$7.50** |

---

## JEV benchmark results

The first paired Codex-versus-JEV benchmark is archived in [`docs/benchmark-results`](docs/benchmark-results/). Its [report](docs/benchmark-results/report.md) includes token consumption, elapsed time, task-level outcomes, routes, and measurement notes. This folder is the growing index of benchmark results; future runs will be added there so changes can be compared over time. See [the benchmark guide](docs/benchmark.md) to reproduce the run or add another suite.

The benchmark runner also writes raw run data under `.jev/benchmarks/`. Results are exploratory while the benchmark set grows.

Its concrete implementation thresholds are:

- **Up to 2 MB per file** fingerprinted for context reuse; unchanged files need no repeated orientation read.
- **3 related successful tickets or 90,000 context tokens** before thread compaction.
- Repetition detection stops a run after **3 identical failed commands**, **4 identical completed actions**, or a **6-action cycle**.

| Optimisation | What JEV does | Typical Codex impact |
| --- | --- | --- |
| Relevant-file context | Identifies the files Codex should inspect first and sends the affected files forward for verification. | Avoids loading unrelated code; often the largest saving on established repositories. |
| Typed decision offload | Handles boolean checks, multiple choices, scores, routing, and validation judgments through compact Noul, Choice, and Score requests. Uncertain answers escalate to Codex. | Removes full Codex turns for decisions that do not need prose or code. |
| Cost-aware model and effort routing | Scores each task from 0 to 5 and selects the first configured route for that level. The model stays fixed; documentation continuations and verification use Low, while implementation and repair efforts follow the configured routes. | Uses each model only where its benchmarked quality justifies its cost and preserves cached context across development turns. |
| Targeted verification | Reviews the actual changed files and approves tests that cover that surface. Environment-blocked checks finish with a note instead of entering a repair loop. | Avoids broad test runs and repeated investigations caused by missing local dependencies. |
| Early validation stop | Stops repair and analysis turns as soon as the required checks are satisfied. | Saves the extra turns that simple tickets often spend rechecking a completed result. |
| Context diet and thread continuity | Reviews tool output and protects errors, paths, and test evidence before compaction. Independent work starts in a cleared thread; related work compacts after three successful tasks or at 90,000 context tokens. | Keeps useful context while limiting stale conversation. The native pre-compaction review is advisory. |
| Compatible ticket grouping | May execute related queued tickets in one shared run when JEV finds a task dependency and their route settings are close enough. | Reduces repeated project orientation and allows more cache reuse. |

---

## See JEV Codex Pilot in action

![JEV Codex Pilot page1](assets/jev-codex-pilot-demo.gif)

---

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

During development, JEV keeps the ticket's selected Codex model fixed and changes only reasoning effort within the configured routes for its complexity level. Documentation and mechanical work can use Low, targeted verification always uses Low on the selected model, and failed checks can raise effort for repair without losing the model's cached context. Every route, hook decision, selected context file, command gate, and context-diet action is visible in the backend logs and execution console. The JEV activity log in the web console starts collapsed and can be expanded to inspect those decisions.

JEV scores expected-outcome clarity and task complexity when the ticket is added to the Kanban board. Clarity is advisory; the 0–5 complexity score selects the default model and reasoning route. Neither score blocks execution.

GitHub Actions runs `.github/workflows/ci.yml` on pushes and pull requests. It installs dependencies from the lockfile, builds and type-checks the app, checks for unused TypeScript declarations, and runs the test suite. It can also be started manually from the Actions tab.

---

## Command line

The headless CLI runs tickets through the same JEV and Codex engine. From the **jev-codex-pilot repository directory**, install dependencies and the command once:

```bash
npm install
npm run setup:cli
```

From the **directory of the target project**, run:

```bash
jc-pilot run "Fix bug X"
jc-pilot status
```

The target is selected from the current directory. The launcher is installed for your user account (`~/.local/bin` on Linux/macOS or `%LOCALAPPDATA%\jc-pilot\bin` on Windows), so setup is only needed once and should be repeated if you move the JEV repository. The target project needs Node.js only on the machine running JEV, plus an `AGENTS.md`; if it is missing, create one before a noninteractive run. Codex CLI must be installed and authenticated, and JEV needs its configured Vercel AI Gateway key.

To run without installing the launcher, replace the placeholder with your JEV checkout path:

```bash
cd /path/to/your/project
node "/path/to/jev-codex-pilot/bin/jc-pilot.mjs" run "Fix bug X"
node "/path/to/jev-codex-pilot/bin/jc-pilot.mjs" status
```

`run` creates and executes a ticket; `status [ticket-id]` shows the latest ticket or a selected one. The CLI shares `.jev/` history and `config/model.toml` with the app, and uses a running local API when available. See the CLI help (`jc-pilot --help`) for options.

## Telegram

The optional Telegram bot provides a private progress view, guided ticket creation, and explicit Codex launches. It is disabled by default and pairs one private chat. At the end of a run, its completion notice reports the remaining 5-hour Codex session limit and context window for each ticket, when available. The ticket's Codex Summary also shows the weekly limit; older tickets without a snapshot show unavailable values.

## Feedback and bug reports

Improvement ideas and bug reports are welcome via [X](https://x.com/Charlyhno). See [CONTRIBUTING.md](CONTRIBUTING.md) for reporting guidance and contribution scope.
