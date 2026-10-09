# Domain Docs

This repo uses a single context: root `CONTEXT.md` for the glossary and `docs/adr/` for architectural decisions.

## Before exploring

Read `CONTEXT.md` and ADRs relevant to the topic. If a future `CONTEXT-MAP.md` introduces multiple contexts, use it to find the relevant glossaries and ADRs. If a document is absent, proceed without creating a placeholder.

## Vocabulary and decisions

Use the glossary's canonical terms in issues, specifications, proposals and tests; avoid its listed synonyms. Flag contradictions with an ADR explicitly rather than silently replacing the decision.

Keep `CONTEXT.md` a glossary. Use `domain-modeling` to capture terms when resolved and to record ADRs only for meaningful architectural tradeoffs.
