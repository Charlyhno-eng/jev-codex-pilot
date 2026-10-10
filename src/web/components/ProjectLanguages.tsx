/** Displays detected source languages and configured project lint coverage. */
export function ProjectLanguages({ languages, linterConfigured }: { languages?: string[]; linterConfigured?: boolean }) {
  return <span className="project-languages" aria-label="Project languages and lint setup">{languages?.length ? languages.map(language => <span key={language}>{language}</span>) : <span className="project-languages-empty">No languages detected</span>}{linterConfigured && <span className="project-linter-badge" title="Linter configured for all detected supported languages">Linter</span>}</span>;
}
