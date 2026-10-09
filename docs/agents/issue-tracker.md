# Issue tracker: GitHub

Issues and specs for this repo live in `eesql/k-dense-byok` GitHub Issues. Use the `gh` CLI and always pass `--repo eesql/k-dense-byok`; the upstream repository is not this project's tracker.

## Conventions

- Create or publish: `gh issue create --repo eesql/k-dense-byok --title "..." --body-file <markdown-file> --label <label>`.
- Read: `gh issue view <number> --repo eesql/k-dense-byok --comments`.
- List: `gh issue list --repo eesql/k-dense-byok --state open --json number,title,body,labels`.
- Comment: `gh issue comment <number> --repo eesql/k-dense-byok --body-file <markdown-file>`.
- Change labels: `gh issue edit <number> --repo eesql/k-dense-byok --add-label <label>` or `--remove-label <label>`.
- Close: `gh issue close <number> --repo eesql/k-dense-byok`.

Publishing to the issue tracker means creating a GitHub issue. Read `docs/agents/triage-labels.md` for the canonical label mapping.

## Pull requests as a triage surface

PRs as a request surface: no.
