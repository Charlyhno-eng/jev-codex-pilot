import React from "react";
import type { Analysis } from "../lib/types.js";
import { formatUsd, reasoningLabel } from "../lib/format.js";
import { useCodexModels } from "../hooks/use-codex-models.js";

export function Plan({ analysis, adjustable, onAdjust }: { analysis: Analysis; adjustable: boolean; onAdjust: (dimension: "model" | "reasoning", delta: -1 | 1) => Promise<void> }) {
  const { models, modelLevels, reasoningLevels } = useCodexModels();
  const configuredModelIndex = modelLevels.indexOf(analysis.model);
  const modelIndex = configuredModelIndex < 0 ? 0 : configuredModelIndex;
  const configuredReasoningIndex = reasoningLevels.indexOf(analysis.reasoning);
  const reasoningIndex = configuredReasoningIndex < 0 ? (analysis.reasoning === "xhigh" ? reasoningLevels.length - 1 : 0) : configuredReasoningIndex;
  const adjustment = (dimension: "model" | "reasoning", delta: -1 | 1) => void onAdjust(dimension, delta);
  const modelName = models[analysis.model] ?? (modelLevels.includes(analysis.model) ? analysis.model : models[modelLevels[0]] ?? analysis.model);
  return <div className="plan-grid"><div className="plan-summary">
    <p className="panel-label">JEV RECOMMENDATION · THIS TASK ONLY</p>
    <div className="recommendation">
      <div><small>MODEL</small><b>{modelName}</b></div>
      <div><small>REASONING</small><b>{reasoningLabel(analysis.reasoning)}</b></div>
      <div><small>TASK PRECISION</small><b>{analysis.precision_score === undefined ? "—" : `${analysis.precision_score}%`}</b></div>
      <div title="Higher means this ticket is a focused, independently deliverable unit of work."><small>TASK BREAKDOWN</small><b>{analysis.decomposition_score === undefined ? "—" : `${analysis.decomposition_score}%`}</b></div>
    </div>
    {analysis.precision_score !== undefined && analysis.precision_score < 60 && <p className="precision-advisory">This task is still valid, but JEV recommends adding more detail before Codex starts.</p>}
    {analysis.decomposition_score !== undefined && analysis.decomposition_score < 70 && <p className="precision-advisory">Consider splitting independent outcomes into separate tickets. This score does not prevent launch.</p>}
    {adjustable && <div className="jev-tuning">
      <div><div><small>MODEL LEVEL</small><b>{modelName}</b></div><span><button type="button" onClick={() => adjustment("model", -1)} disabled={modelIndex <= 0} aria-label="Lower model one level">−</button><button type="button" onClick={() => adjustment("model", 1)} disabled={modelIndex < 0 || modelIndex >= modelLevels.length - 1} aria-label="Raise model one level">＋</button></span></div>
      <div><div><small>REASONING LEVEL</small><b>{reasoningLabel(analysis.reasoning)}</b></div><span><button type="button" onClick={() => adjustment("reasoning", -1)} disabled={reasoningIndex <= 0} aria-label="Lower reasoning one level">−</button><button type="button" onClick={() => adjustment("reasoning", 1)} disabled={reasoningIndex >= reasoningLevels.length - 1} aria-label="Raise reasoning one level">＋</button></span></div>
      <p>Adjust one level before launching this pending task. The selected model and reasoning will be used by Codex.</p>
    </div>}
    <div className="type-list"><span>{analysis.evaluator ?? "legacy analyzer"}</span>{analysis.task_types.map(type => <span key={type}>{type.replace("_", " / ")}</span>)}{analysis.evaluation_usage?.total_tokens !== undefined && <span>{analysis.evaluation_usage.total_tokens} JEV tokens</span>}{analysis.evaluation_usage?.estimated_cost_usd !== undefined && <span>≈ {formatUsd(analysis.evaluation_usage.estimated_cost_usd)} JEV cost</span>}</div>
    <ul>{analysis.rationale.map(item => <li key={item}>{item}</li>)}</ul>
  </div><div className="scope-panel"><p className="panel-label">MINIMAL CONTEXT</p><FileGroup title="Context" values={analysis.context_files}/></div></div>;
}

function FileGroup({ title, values }: { title: string; values: string[] }) { return <div className="file-group"><div><span className="scope-dot context"/><b>{title}</b><small>{values.length}</small></div>{values.length ? <ul>{values.map(value => <li key={value}>{value}</li>)}</ul> : <p>Nothing inferred</p>}</div>; }
