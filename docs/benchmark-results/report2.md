# JEV benchmark results

Generated: 2026-09-27T16:28:17.091Z
Suite snapshot: suite.json
JEV revision: becad3a27575794346fecac2e2d43df13c1346e4 (working tree changed)
Repetitions: 1

## Summary

- Planned tasks: 7; both passed with token usage: 7.
- Baseline passed: 7; JEV passed: 7.
- Median Codex token change on tasks both passed: -69.2% (input + output, cached input included once).
- setup: 1 paired pass(es), median change -69.2%.
- visual_design: 1 paired pass(es), median change -34.3%.
- 3d_scene: 1 paired pass(es), median change -23.8%.
- interaction: 2 paired pass(es), median change -85.3%.
- features: 1 paired pass(es), median change -89.0%.
- quality: 1 paired pass(es), median change -68.3%.

Results are exploratory until the suite includes enough representative tasks and repetitions. A percentage change is reported only for pairs where both independent checks passed and Codex usage is complete.

## Task results

Consumption is Codex input plus output tokens; performance is elapsed agent time. Δ % = (JEV − baseline) / baseline × 100, so negative values favor JEV. TOTAL includes only comparable passing pairs.

<table>
<thead>
<tr><th rowspan="2">Task</th><th colspan="3" align="center">Consumption</th><th colspan="3" align="center">Performance</th></tr>
<tr><th align="right">Baseline</th><th align="right">JEV</th><th align="right">Δ %</th><th align="right">Baseline</th><th align="right">JEV</th><th align="right">Δ %</th></tr>
</thead>
<tbody>
<tr><th scope="row">neural_lab_portfolio / frontend_project_foundation</th><td align="right">628,872</td><td align="right">193,966</td><td align="right">-69.2%</td><td align="right">1295.3 s</td><td align="right">241.4 s</td><td align="right">-81.4%</td></tr>
<tr><th scope="row">neural_lab_portfolio / futuristic_lab_environment</th><td align="right">2,398,365</td><td align="right">1,575,762</td><td align="right">-34.3%</td><td align="right">591.0 s</td><td align="right">578.6 s</td><td align="right">-2.1%</td></tr>
<tr><th scope="row">neural_lab_portfolio / animated_brain_containment_tank</th><td align="right">3,541,810</td><td align="right">2,699,475</td><td align="right">-23.8%</td><td align="right">332.9 s</td><td align="right">404.8 s</td><td align="right">+21.6%</td></tr>
<tr><th scope="row">neural_lab_portfolio / computer_portfolio_navigation</th><td align="right">4,872,395</td><td align="right">488,974</td><td align="right">-90.0%</td><td align="right">925.7 s</td><td align="right">407.5 s</td><td align="right">-56.0%</td></tr>
<tr><th scope="row">neural_lab_portfolio / empty_content_popups</th><td align="right">5,002,171</td><td align="right">967,246</td><td align="right">-80.7%</td><td align="right">96.9 s</td><td align="right">117.1 s</td><td align="right">+20.8%</td></tr>
<tr><th scope="row">neural_lab_portfolio / tank_visual_controls</th><td align="right">5,558,556</td><td align="right">611,806</td><td align="right">-89.0%</td><td align="right">953.5 s</td><td align="right">407.8 s</td><td align="right">-57.2%</td></tr>
<tr><th scope="row">neural_lab_portfolio / bilingual_accessibility_and_polish</th><td align="right">7,395,220</td><td align="right">2,344,153</td><td align="right">-68.3%</td><td align="right">1135.0 s</td><td align="right">594.8 s</td><td align="right">-47.6%</td></tr>
</tbody>
<tfoot>
<tr><th scope="row">TOTAL</th><th align="right">29,397,389</th><th align="right">8,881,382</th><th align="right">-69.8%</th><th align="right">88.8 min</th><th align="right">45.9 min</th><th align="right">-48.4%</th></tr>
</tfoot>
</table>

## Run details

| Scenario / task | Repeat | Route | Baseline | JEV | JEV provider tokens | Cost B/J |
| --- | ---: | --- | --- | --- | ---: | --- |
| neural_lab_portfolio / frontend_project_foundation | 1 | gpt-6-luna max | completed / pass | success / pass | 1601 | — / — |
| neural_lab_portfolio / futuristic_lab_environment | 1 | gpt-6-sol high | completed / pass | success / pass | 2215 | — / — |
| neural_lab_portfolio / animated_brain_containment_tank | 1 | gpt-6-sol high | completed / pass | success / pass | 2194 | — / — |
| neural_lab_portfolio / computer_portfolio_navigation | 1 | gpt-6-luna max | completed / pass | success / pass | 2186 | — / — |
| neural_lab_portfolio / empty_content_popups | 1 | gpt-6-luna max | completed / pass | success / pass | 2219 | — / — |
| neural_lab_portfolio / tank_visual_controls | 1 | gpt-6-luna max | completed / pass | success / pass | 2245 | — / — |
| neural_lab_portfolio / bilingual_accessibility_and_polish | 1 | gpt-6-luna max | completed / pass | success / pass | 2319 | — / — |

## Check failures and skipped tasks

- None.

## Measurement notes

- Each variant starts from the same filesystem snapshot copied at launch, with AGENTS.md saved beside this report; `.git`, `.jev`, `node_modules`, and the benchmark output directory are omitted. A scenario retains its own edits and thread between tasks.
- Codex tokens are the sum of completed turn usage. Cached input is part of input tokens and is also recorded separately in results.json.
- Independent checks run after each variant and do not count toward agent tokens or duration.
- JEV provider usage includes analysis, verification, continuity and separate hook responses when the provider reports usage. The JSON report marks missing usage calls.
- USD estimates appear in results.json only when the suite supplies prices and all required usage is available. Prices are supplied by the suite author, not fetched live.
- Failed or incomplete pairs remain visible but are excluded from percentage changes and totals.
