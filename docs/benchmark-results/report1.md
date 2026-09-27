# JEV benchmark results

Generated: 2026-09-24T14:29:22.136Z
Suite snapshot: suite.json
JEV revision: 55f850e38331da67a4bc6b1df75426b91b5f69e2 (working tree changed)
Repetitions: 1

## Summary

- Planned tasks: 4; both passed with token usage: 4.
- Baseline passed: 4; JEV passed: 4.
- Median Codex token change on tasks both passed: -22.9% (input + output, cached input included once).
- setup: 1 paired pass(es), median change +15.3%.
- recipes: 1 paired pass(es), median change -20.5%.
- features: 1 paired pass(es), median change -25.3%.
- quality: 1 paired pass(es), median change -44.5%.

Results are exploratory until the suite includes enough representative tasks and repetitions. A percentage change is reported only for pairs where both independent checks passed and Codex usage is complete.

## Task results

Consumption is Codex input plus output tokens; performance is elapsed agent time. Δ % = (JEV − baseline) / baseline × 100, so negative values favor JEV. TOTAL includes only comparable passing pairs.

<table>
<thead>
<tr><th rowspan="2">Task</th><th colspan="3" align="center">Consumption</th><th colspan="3" align="center">Performance</th></tr>
<tr><th align="right">Baseline</th><th align="right">JEV</th><th align="right">Δ %</th><th align="right">Baseline</th><th align="right">JEV</th><th align="right">Δ %</th></tr>
</thead>
<tbody>
<tr><th scope="row">recipe_manager / vite_react_app_setup</th><td align="right">404,554</td><td align="right">466,360</td><td align="right">+15.3%</td><td align="right">389.4 s</td><td align="right">178.9 s</td><td align="right">-54.0%</td></tr>
<tr><th scope="row">recipe_manager / recipe_data_search_and_filters</th><td align="right">1,207,428</td><td align="right">959,856</td><td align="right">-20.5%</td><td align="right">383.2 s</td><td align="right">242.8 s</td><td align="right">-36.6%</td></tr>
<tr><th scope="row">recipe_manager / recipe_details_and_persistent_favorites</th><td align="right">2,574,858</td><td align="right">1,922,942</td><td align="right">-25.3%</td><td align="right">380.5 s</td><td align="right">244.5 s</td><td align="right">-35.7%</td></tr>
<tr><th scope="row">recipe_manager / responsive_accessibility_and_final_review</th><td align="right">6,483,735</td><td align="right">3,597,714</td><td align="right">-44.5%</td><td align="right">835.7 s</td><td align="right">493.1 s</td><td align="right">-41.0%</td></tr>
</tbody>
<tfoot>
<tr><th scope="row">TOTAL</th><th align="right">10,670,575</th><th align="right">6,946,872</th><th align="right">-34.9%</th><th align="right">33.1 min</th><th align="right">19.3 min</th><th align="right">-41.7%</th></tr>
</tfoot>
</table>

## Run details

| Scenario / task | Repeat | Route | Baseline | JEV | JEV provider tokens | Cost B/J |
| --- | ---: | --- | --- | --- | ---: | --- |
| recipe_manager / vite_react_app_setup | 1 | gpt-6-luna max | completed / pass | success / pass | 1669 | — / — |
| recipe_manager / recipe_data_search_and_filters | 1 | gpt-6-luna max | completed / pass | success / pass | 2309 | — / — |
| recipe_manager / recipe_details_and_persistent_favorites | 1 | gpt-6-luna max | completed / pass | success / pass | 2300 | — / — |
| recipe_manager / responsive_accessibility_and_final_review | 1 | gpt-6-luna max | completed / pass | success / pass | 2367 | — / — |

## Check failures and skipped tasks

- None.

## Measurement notes

- Each variant starts from the same filesystem snapshot copied at launch, with AGENTS.md saved beside this report; `.git`, `.jev`, `node_modules`, and the benchmark output directory are omitted. A scenario retains its own edits and thread between tasks.
- Codex tokens are the sum of completed turn usage. Cached input is part of input tokens and is also recorded separately in results.json.
- Independent checks run after each variant and do not count toward agent tokens or duration.
- JEV provider usage includes analysis, verification, continuity and separate hook responses when the provider reports usage. The JSON report marks missing usage calls.
- USD estimates appear in results.json only when the suite supplies prices and all required usage is available. Prices are supplied by the suite author, not fetched live.
- Failed or incomplete pairs remain visible but are excluded from percentage changes and totals.
