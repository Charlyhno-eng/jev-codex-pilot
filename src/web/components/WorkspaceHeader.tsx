import { ProjectLanguages } from "./ProjectLanguages.js";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** Groups page navigation, identity, and optional status controls in one workspace header. */
export function WorkspaceHeader({ backTo, backLabel, eyebrow, title, description, languages, children }: {
  backTo: string;
  backLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  languages?: string[];
  children?: ReactNode;
}) {
  return <header className="workspace-header">
    <div className="workspace-header-identity">
      <Link className="workspace-header-back" to={backTo} aria-label={backLabel} title={backLabel}><span aria-hidden="true">←</span></Link>
      <div className="workspace-header-copy"><p className="eyebrow">{eyebrow}</p><div className="workspace-header-title"><h1>{title}</h1>{languages && <ProjectLanguages languages={languages}/>}</div><p className="workspace-header-description">{description}</p></div>
    </div>
    {children && <div className="workspace-header-details">{children}</div>}
  </header>;
}
