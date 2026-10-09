/** Displays detected source languages with a clear empty state. */
export function ProjectLanguages({ languages }: { languages?: string[] }) {
  return <span className="project-languages" aria-label="Project languages">{languages?.length ? languages.map(language => <span key={language}>{language}</span>) : <span className="project-languages-empty">No languages detected</span>}</span>;
}
