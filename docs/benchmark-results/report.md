# JEV benchmark results

Generated: 2026-09-23T19:27:20.849Z
Suite snapshot: suite.json
JEV revision: 65e8f32a1b7c26809379f4acde713516b52e96ba (working tree changed)
Repetitions: 1

## Summary

- Planned tasks: 8; both passed with token usage: 8.
- Baseline passed: 8; JEV passed: 8.
- Median Codex token change on tasks both passed: -64.8% (input + output, cached input included once).
- setup: 1 paired pass(es), median change -75.7%.
- scene: 1 paired pass(es), median change -62.2%.
- tank: 1 paired pass(es), median change -51.7%.
- state: 1 paired pass(es), median change -57.5%.
- interface: 1 paired pass(es), median change -64.8%.
- environment: 1 paired pass(es), median change -66.2%.
- responsive: 1 paired pass(es), median change -76.7%.
- test: 1 paired pass(es), median change -75.7%.


Results are exploratory until the suite includes enough representative tasks and repetitions. A percentage change is reported only for pairs where both independent checks passed and Codex usage is complete.

## Task results

Consumption is Codex input plus output tokens; performance is elapsed agent time. Δ % = (JEV − baseline) / baseline × 100, so negative values favor JEV. TOTAL includes only comparable passing pairs.

<table>
<thead>
<tr><th rowspan="2">Task</th><th colspan="3" align="center">Consumption</th><th colspan="3" align="center">Performance</th></tr>
<tr><th align="right">Baseline</th><th align="right">JEV</th><th align="right">Δ %</th><th align="right">Baseline</th><th align="right">JEV</th><th align="right">Δ %</th></tr>
</thead>
<tbody>
<tr><th scope="row">threejs_brain_lab / project_setup_configuration</th><td align="right">501,228</td><td align="right">121,973</td><td align="right">-75.7%</td><td align="right">288.6 s</td><td align="right">97.8 s</td><td align="right">-66.1%</td></tr>
<tr><th scope="row">threejs_brain_lab / threejs_laboratory_environment</th><td align="right">876,597</td><td align="right">331,200</td><td align="right">-62.2%</td><td align="right">177.6 s</td><td align="right">175.0 s</td><td align="right">-1.4%</td></tr>
<tr><th scope="row">threejs_brain_lab / brain_containment_tank</th><td align="right">1,147,822</td><td align="right">553,980</td><td align="right">-51.7%</td><td align="right">149.7 s</td><td align="right">157.0 s</td><td align="right">+4.8%</td></tr>
<tr><th scope="row">threejs_brain_lab / tank_parameters_state_management</th><td align="right">1,621,866</td><td align="right">688,673</td><td align="right">-57.5%</td><td align="right">136.5 s</td><td align="right">96.1 s</td><td align="right">-29.6%</td></tr>
<tr><th scope="row">threejs_brain_lab / control_computer_interface</th><td align="right">2,302,991</td><td align="right">810,662</td><td align="right">-64.8%</td><td align="right">189.6 s</td><td align="right">85.3 s</td><td align="right">-55.0%</td></tr>
<tr><th scope="row">threejs_brain_lab / organic_vegetation_environmental_details</th><td align="right">3,009,822</td><td align="right">1,016,615</td><td align="right">-66.2%</td><td align="right">197.0 s</td><td align="right">173.1 s</td><td align="right">-12.2%</td></tr>
<tr><th scope="row">threejs_brain_lab / visual_integration_responsive_experience</th><td align="right">5,262,293</td><td align="right">1,223,486</td><td align="right">-76.7%</td><td align="right">317.1 s</td><td align="right">156.2 s</td><td align="right">-50.8%</td></tr>
<tr><th scope="row">threejs_brain_lab / testing_documentation</th><td align="right">7,495,954</td><td align="right">1,818,887</td><td align="right">-75.7%</td><td align="right">378.9 s</td><td align="right">180.1 s</td><td align="right">-52.4%</td></tr>
</tbody>
<tfoot>
<tr><th scope="row">TOTAL</th><th align="right">14,722,619</th><th align="right">4,746,589</th><th align="right">-67.8%</th><th align="right">24.3 min</th><th align="right">15.7 min</th><th align="right">-35.4%</th></tr>
</tfoot>
</table>

## Run details

| Scenario / task | Repeat | Route | Baseline | JEV | JEV provider tokens | Cost B/J |
| --- | ---: | --- | --- | --- | ---: | --- |
| threejs_brain_lab / project_setup_configuration | 1 | gpt-6-sol medium | completed / pass | success / pass | 1701 | — / — |
| threejs_brain_lab / threejs_laboratory_environment | 1 | gpt-6-sol medium | completed / pass | success / pass | 2152 | — / — |
| threejs_brain_lab / brain_containment_tank | 1 | gpt-6-sol medium | completed / pass | success / pass | 2235 | — / — |
| threejs_brain_lab / tank_parameters_state_management | 1 | gpt-6-sol medium | completed / pass | success / pass | 2394 | — / — |
| threejs_brain_lab / control_computer_interface | 1 | gpt-6-sol medium | completed / pass | success / pass | 2490 | — / — |
| threejs_brain_lab / organic_vegetation_environmental_details | 1 | gpt-6-sol medium | completed / pass | success / pass | 2642 | — / — |
| threejs_brain_lab / visual_integration_responsive_experience | 1 | gpt-6-sol medium | completed / pass | success / pass | 2748 | — / — |
| threejs_brain_lab / testing_documentation | 1 | gpt-6-luna high | completed / pass | success / check pass | 2829 | — / — |

## Measurement notes

- Each variant starts from the same committed Git revision; a scenario retains its own edits and thread between tasks.
- Codex tokens are the sum of completed turn usage. Cached input is part of input tokens and is also recorded separately in results.json.
- Independent checks run after each variant and do not count toward agent tokens or duration.
- JEV provider usage includes analysis, verification, continuity and separate hook responses when the provider reports usage. The JSON report marks missing usage calls.
- USD estimates appear in results.json only when the suite supplies prices and all required usage is available. Prices are supplied by the suite author, not fetched live.
