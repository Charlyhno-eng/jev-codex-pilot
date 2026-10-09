---
name: readme-writing
description: Create or rewrite a short English README with an existing banner, a clear application description, an optional visual, and verified installation and run commands.
---

# README Writing Skill

Create short, clear, consistent README files. Apply this format when asked to write or restructure a README; do not rewrite unrelated documentation.

## Discovery

Inspect the project structure, metadata, existing README, and `public/` and `assets/` before writing. Verify the application name, purpose, setup requirements, and install/run commands from actual project files. Reuse existing assets and commands. Never invent paths, commands, configuration, or claims about the application.

## Structure

Use exactly this order:

1. Banner
2. Application name
3. Description
4. Visual, if available
5. Quickstart

The banner is the first content. Use an existing image in `public/` or `assets/` whose filename contains `banner`, with a path relative to the README. Never invent or silently generate an asset. If no suitable banner exists, complete the verified text and report that the banner requirement remains unmet; request an existing asset or authorization to create one.

Use exactly one level-one heading: `# <actual application name>`. Put `---` immediately after the title, separated by blank lines.

Write the description in English as 8–13 concise, nonempty source lines. Describe what the application does, whom it serves, and its purpose. Avoid repetition, feature lists, marketing language, and technical implementation details. Each line should contribute distinct, verified information.

If a relevant screenshot, GIF, or video already exists, add a separator and `## See <actual application name> in action`, then reference the real asset. Use relative paths for local assets. Omit this entire section if no relevant visual exists; do not insert a placeholder.

After a separator, end with `## Quickstart`, containing `### Install` and `### Run`. Put verified commands in fenced `bash` blocks. Choose the actual package manager or tooling used by the project; `npm install` and `npm run dev` are examples, not defaults. Include concise configuration or prerequisite instructions here only when needed to install and run the application. Use placeholders for required credentials, never real secrets. If a required command cannot be verified, report the missing information rather than guessing.

## Style

Keep only information needed to understand, install, configure, and run the application. Do not add extra sections, repetition, history, architecture, API documentation, FAQs, or unnecessary badges. The JEV README illustrates banner and Quickstart placement, but its detailed product sections are project-specific exceptions, not part of this template. Preserve extra sections only when the user's explicit request requires them.

## Validation

Before delivering, check that:

- The banner is first, exists in `public/` or `assets/`, contains `banner` in its filename, and uses a valid relative path.
- There is exactly one `#` heading and `---` follows the title.
- The description contains 8–13 concise English source lines.
- Every visual reference is valid; the visual section is absent when no relevant asset exists.
- Commands and required configuration match the inspected project.
- Quickstart is the final section, with Install and Run subsections.

Report any unmet requirement caused by missing project information or assets. Do not claim validation passed when it did not.
