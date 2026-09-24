import type { Analysis } from "../lib/types.js";
import { formatUsd, reasoningLabel } from "../lib/format.js";
import { useCodexModels } from "../hooks/use-codex-models.js";

/** Renders JEV analysis and pending route controls. */
export function Plan({ analysis, adjustable, onAdjust }: { analysis: Analysis; adjustable: boolean; onAdjust: (dimension: "model" | "reasoning", delta: -1 | 1) => Promise<void> }) {
  const { models, modelLevels, reasoningLevels, complexityRoutes } = useCodexModels();
  const routes = complexityRoutes?.[String(analysis.complexity)];
  const availableModels = routes ? modelLevels.filter(model => routes.some(route => route.model === model)) : modelLevels;
  const availableReasoning = routes ? reasoningLevels.filter(reasoning => routes.some(route => route.model === analysis.model && route.reasoning === reasoning)) : reasoningLevels;
  const configuredModelIndex = availableModels.indexOf(analysis.model);
  const modelIndex = configuredModelIndex < 0 ? 0 : configuredModelIndex;
  const reasoningIndex = availableReasoning.indexOf(analysis.reasoning);
  const adjustment = (dimension: "model" | "reasoning", delta: -1 | 1) => void onAdjust(dimension, delta);
  const modelName = models[analysis.model] ?? (modelLevels.includes(analysis.model) ? analysis.model : models[modelLevels[0]] ?? analysis.model);
  return <div className="plan-grid"><div className="plan-summary">
    <p className="panel-label">JEV RECOMMENDATION · THIS TASK ONLY</p>
    <div className="recommendation">
      <div><small>MODEL</small><b>{modelName}</b></div>
      <div><small>REASONING</small><b>{reasoningLabel(analysis.reasoning)}</b></div>
      <div title="How clearly does this ticket describe the result that should be achieved?"><small>EXPECTED OUTCOME CLARITY</small><b>{analysis.outcome_clarity_score === undefined ? "—" : `${analysis.outcome_clarity_score}%`}</b></div>
      <div title="JEV's assessment of the task's implementation difficulty on a five-level scale."><small>COMPLEXITY</small><b>{analysis.complexity}/5</b></div>
    </div>
    {analysis.outcome_clarity_score !== undefined && analysis.outcome_clarity_score < 60 && <p className="score-advisory">The ticket is still valid, but its expected result may need clarification before Codex starts.</p>}
    {adjustable && <div className="jev-tuning">
      <div><div><small>MODEL LEVEL</small><b>{modelName}</b></div><span><button type="button" onClick={() => adjustment("model", -1)} disabled={modelIndex <= 0} aria-label="Lower model one level">−</button><button type="button" onClick={() => adjustment("model", 1)} disabled={modelIndex < 0 || modelIndex >= availableModels.length - 1} aria-label="Raise model one level">＋</button></span></div>
      <div><div><small>REASONING LEVEL</small><b>{reasoningLabel(analysis.reasoning)}</b></div><span><button type="button" onClick={() => adjustment("reasoning", -1)} disabled={reasoningIndex <= 0} aria-label="Lower reasoning one level">−</button><button type="button" onClick={() => adjustment("reasoning", 1)} disabled={reasoningIndex < 0 || reasoningIndex >= availableReasoning.length - 1} aria-label="Raise reasoning one level">＋</button></span></div>
      <p>Adjust one level before launching this pending task. The selected model and reasoning will be used by Codex.</p>
    </div>}
    <div className="type-list"><span>{analysis.evaluator ?? "legacy analyzer"}</span>{analysis.task_types.map(type => <span key={type}>{type.replace("_", " / ")}</span>)}{analysis.evaluation_usage?.total_tokens !== undefined && <span>{analysis.evaluation_usage.total_tokens} JEV tokens</span>}{analysis.evaluation_usage?.estimated_cost_usd !== undefined && <span>≈ {formatUsd(analysis.evaluation_usage.estimated_cost_usd)} JEV cost</span>}</div>
    <ul>{analysis.rationale.map(item => <li key={item}>{item}</li>)}</ul>
  </div></div>;
}
