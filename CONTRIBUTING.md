# Contributing

Thanks for your interest. Bug reports, fixes and small focused features are welcome.

## Setup

Requires Node.js 22 or later.

```sh
npm ci
npm run all   # typecheck, lint, test, build
```

## Project layout

| Path | Purpose |
| --- | --- |
| `src/diff.ts` | Unified diff and per-file patch parser |
| `src/linemap.ts` | Index of head-side diff lines used to validate comment positions |
| `src/filter.ts` | Include/exclude globs, lockfile, generated and binary detection |
| `src/chunk.ts` | Token estimate, diff rendering and chunking |
| `src/prompt.ts` | System and user prompts |
| `src/reviewer.ts` | Anthropic Messages API call and response handling |
| `src/findings.ts` | Findings schema, validation, anchoring, threshold and limits |
| `src/format.ts` | Comment and summary Markdown, fingerprints, sanitizing |
| `src/github.ts` | Octokit calls: fetch diff, post review, upsert summary |
| `src/main.ts` | Orchestration, inputs and outputs |
| `dist/` | Bundled action (generated, committed) |

## Guidelines

- **Tests stay offline.** Stub Octokit (see `test/octokit-stub.ts`) and the Anthropic client; never call real APIs from tests.
- **Add a test with every bug fix.** For diff parsing problems, a minimal diff that reproduces the issue is the most useful thing you can include.
- **Rebuild `dist/`.** GitHub runs `dist/index.js` directly, so run `npm run build` and commit the result. CI fails if `dist/` is out of date.
- **Keep the prompt and schema in sync.** If you change `FindingSchema`, update `REVIEW_JSON_SCHEMA` too; a test checks that they match.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Testing changes against a real PR

Push your branch to a fork, then in a test repository reference it as `uses: <you>/ai-pr-reviewer@<branch>` with `dry_run: true` first. The job summary shows what would have been posted.

## Reporting security issues

Please do not open a public issue for vulnerabilities (for example a way for PR content to exfiltrate secrets). Use GitHub's private vulnerability reporting on this repository instead.
