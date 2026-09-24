# Running a Codex / JEV benchmark

The benchmark runs each task twice from the same starting project state: once with Codex directly and once with JEV. Git projects start from a selected commit; projects without Git are copied from a filesystem snapshot taken at launch. It records reported token usage, elapsed time, optional cost estimates, and the results of independent checks. By default, clones, JEV history, and reports are stored under `.jev/benchmarks/`. The source folder is not modified.

## Prerequisites

- Install JEV dependencies by running `npm install` in this repository.
- Install and sign in to the `codex` command used for normal Codex runs.
- Configure the Vercel AI Gateway key in JEV's local settings. The benchmark uses that local configuration and does not copy the key into reports.
- Put an `AGENTS.md` file at the project root; any letter case is accepted, and the benchmark installs it as `AGENTS.md` in both variants. Git is optional. For a Git repository, source files come from the selected commit while the current instructions file is snapshotted at launch. For a folder without Git, omit `revision` fields from the suite and the benchmark copies its current files into both variants. That snapshot omits `.git`, `.jev`, `node_modules`, and the benchmark output directory.

The benchmark makes real Codex and JEV model calls unless `--dry-run` is used. Check the suite first without starting agents:

```bash
npm run benchmark -- --suite benchmarks/demo.json --dry-run
```

Then run the demonstration:

```bash
npm run benchmark -- --suite benchmarks/demo.json
```

The output directory is shown when the run starts. To choose a new directory:

```bash
npm run benchmark -- --suite benchmarks/demo.json --output .jev/benchmarks/trial-01
```

The `benchmarks/demo.json` suite uses the current contents of `/home/charly/Téléchargements/benchmark-test` to run four related recipe manager tasks: app setup, recipe search and filters, details and favorites, then responsive accessibility and final review. It takes a filesystem snapshot, so no Git revision is needed. It measures Codex-versus-JEV results for this task sequence; it does not reproduce the external model benchmark charts in the README.

## Create a representative suite

Copy `benchmarks/demo.json` and replace its scenarios with real tasks. Each scenario starts from a fixed commit and keeps each variant's project changes and conversation between its tasks. Use several scenarios for focused tickets, typical work in an established repository, and longer sessions. Choose the tasks and success criteria before looking at results.

```json
{
  "version": 1,
  "repository": "../path/to/project",
  "revision": "fixed-commit-or-tag",
  "repetitions": 3,
  "scenarios": [
    {
      "id": "example_fix",
      "setup": [["npm", "ci"]],
      "tasks": [
        {
          "id": "fix_the_bug",
          "category": "typical",
          "prompt": "Describe the behavior to fix and the expected result.",
          "checks": [["npm", "run", "test:regression"]],
          "timeoutSeconds": 1800
        }
      ]
    }
  ]
}
```

`repository` is resolved relative to the suite file. For Git projects, provide a suite-level `revision` and optionally override it per scenario; uncommitted source changes are not included, except that the current root instructions file is applied to both variants. For non-Git folders, omit all `revision` fields; the runner uses a filesystem snapshot from launch time. Scenario `setup` commands prepare both copies before agents start; task `setup` commands run before that task. `checks` are argument arrays, so no shell is implied. Every task needs at least one independent check. Checks run in each copy after each variant, are not shown to agents, and their time and tokens are excluded from agent measurements. Make checks identical, repeatable, and safe to run more than once.

For a project that starts without `package.json`, put `npm install` as the first check of the ticket that creates it, followed by `npm run build`. A scenario `setup` runs too early to install dependencies declared by that ticket. Later tickets keep the installed dependencies in their own clone.

`repetitions` can be from 1 to 20. Start with a few tasks and one repetition. For results suitable for reporting, include multiple tasks per category and repeat them. Keep failed outcomes in the report; do not select only tasks JEV passes. If either variant fails a task in a scenario, later tasks in that sequence are marked skipped because the project states would otherwise diverge.

The direct Codex variant receives the task prompt and the model and reasoning level initially selected by JEV's analysis. It reuses its Codex thread between tasks in a scenario. The JEV variant uses its normal orchestration, including any later reasoning changes and targeted validation. This measures JEV as configured; it does not isolate the effect of one optimization.

## Read the results

Each run saves `suite.json`, the exact `AGENTS.md` snapshot used by both variants, `results.json`, and `report.md`. The report records whether the source used a Git commit or a filesystem snapshot, plus the JEV engine commit and whether its working tree had changes. `results.json` contains input, cached input, and output token counts, durations, check results, and JEV provider response details. `report.md` groups Codex token consumption and elapsed performance by task, with baseline, JEV, signed percentage change, and a TOTAL row. The change is `(JEV − baseline) / baseline × 100`, so a negative value favors JEV. Totals and median changes include only pairs where both variants pass their independent checks and have complete Codex usage. Run status, model route, provider usage, and optional cost remain in the detail section.

Cached input tokens are included in total input and also shown separately. JEV provider counts cover analysis, verification, continuity, and hook decisions running in separate processes when the provider reports usage. `missingCalls` marks responses without usable measurements. Hook counter files contain token counts only.

Optional USD estimates can be added to the suite with prices per million tokens. Prices are not fetched automatically:

```json
"pricing": {
  "codex": {
    "model-id": {
      "inputUsdPerMillion": 0,
      "cachedInputUsdPerMillion": 0,
      "outputUsdPerMillion": 0
    }
  },
  "jev": {
    "inputUsdPerMillion": 0,
    "outputUsdPerMillion": 0
  }
}
```

Replace the zeros with applicable rates and `model-id` with the identifier in `config/model.toml`. An estimate is omitted if a price or required usage count is missing. External quotas and charges are not measured.

Keep external model benchmark charts separate from paired JEV results. Treat demos and small task sets as exploratory, and report paired gains only for tasks where both variants pass and usage data is complete.
