import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkillCaution, SkillPicker } from "../../src/web/components/Skills.js";
import type { Skill } from "../../src/web/lib/types.js";

const advanced: Skill = { id: "advanced", name: "rust-low-level-performance", description: "Low-level Rust", caution: { title: "Advanced · profile first", useWhen: "Use for measured CPU hotspots.", avoidWhen: "Avoid for routine work." } };

describe("advanced skill usage guidance", () => {
  it("shows readable usage criteria with a note role and a decorative warning symbol", () => {
    const markup = renderToStaticMarkup(<SkillCaution caution={advanced.caution}/>);
    expect(markup).toContain('role="note"');
    expect(markup).toContain('aria-hidden="true"');
    for (const text of Object.values(advanced.caution!)) expect(markup).toContain(text);
    expect(renderToStaticMarkup(<SkillCaution caution={undefined}/>)).toBe("");
  });
  it("keeps the warning visible after selection without prompting for confirmation", () => {
    const markup = renderToStaticMarkup(<SkillPicker selected={[advanced]} onChange={() => {}}/>);
    expect(markup).toContain(advanced.caution!.title);
    expect(markup).toContain(advanced.caution!.useWhen);
    expect(markup).toContain(advanced.caution!.avoidWhen);
    expect(markup).toContain('aria-label="Remove skill rust-low-level-performance"');
    expect(markup).not.toContain('role="dialog"');
    const ordinary = { id: "ordinary", name: "rust-engineer", description: "General Rust" };
    expect(renderToStaticMarkup(<SkillPicker selected={[ordinary]} onChange={() => {}}/>)).not.toContain('role="note"');
  });
});
