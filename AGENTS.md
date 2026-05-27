# AGENTS.md

Conventions for AI coding agents (and humans) working on **diff-review**.

## Commands

- `npm run lint` — Biome lint + format check. **Run before committing.**
- `npm run lint:fix` — auto-fix lint issues and format.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — unit + browser tests (`npm run test:unit` for the fast, no-browser subset).
- `npm run build` — rebuild `bin/diff-review.js` from `src/`.

## Conventions

- **Biome owns formatting** — never hand-format. Run `npm run lint:fix` instead.
- **Generated, never edit by hand:** `bin/diff-review.js` and `src/cli/embedded.ts`.
- After changing anything under `src/`, run `npm run build` and commit the
  regenerated `bin/diff-review.js` so the shipped binary stays in sync.
- Keep the `version` in sync across `package.json`, `.claude-plugin/plugin.json`,
  and `.claude-plugin/marketplace.json` — plugin updates are gated on it.
- Before opening a PR: `npm run lint && npm run typecheck && npm test`.
