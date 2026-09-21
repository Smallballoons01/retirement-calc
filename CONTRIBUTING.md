# Contributing

Thanks for looking. This is a small project; the fastest way to get a change merged is to keep it
narrow and show the test that proves it.

## Setup

The package has **no runtime dependencies**, so there is nothing to install before running the tests.

The DeepSeek Harness packages are peer dependencies and are **not published to npm**. Tests that need
them skip themselves with a clear message instead of failing, so a plain checkout gives you a green
run and reduced coverage. To exercise the plugin layers, symlink them from a local harness install:

```bash
mkdir -p node_modules/@deepseek-ai
for p in cordis dsh-llm dsh-settings dsh-skill dsh-system-prompt dsh-tools schemastery dsh-host-webserver; do
  ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
```

## Checks

```bash
npm run check
```

That runs, in order: the unit and integration tests, the skill/artifact drift checks, the browser
end-to-end pass, and the real-composition HTTP pass. Individual pieces:

| Command | Needs |
| --- | --- |
| `npm test` | nothing (plugin layers skip without the harness) |
| `npm run verify` | a local Chrome, Edge or Chromium |
| `npm run verify:plugin` | the harness packages |
| `npm run skill:check` | nothing — fails if `SKILL.md` drifted from `skill.js` |
| `npm run web:check` | nothing — fails if `dist/` drifted from source |
| `npm run audit` | nothing — secret scan; runs in CI on every push |

## Changing a calculation

**Change the test first, and make sure it fails for the right reason.** The formulas here are
published rules, not preferences, so every one of them is pinned by a test that says where it came
from:

- The two worked examples in the Jiangxi Xinyu bureau's article *(answers 955.29 and 3967.89)* fix the
  basic and individual-account formulas and the transitional one.
- The delay table is checked month by month around January 2025 and at each group's ceiling age.
- The minimum-contribution ramp is checked at 2030, 2038, 2039 and 2041.
- The annuity divisor is checked at whole-year boundaries (50y11m must use the age-50 value).

If you believe one of these is wrong, say so in the issue with the document that contradicts it — a
citation beats an argument. Please don't adjust a formula to make a particular person's number come
out nicer.

## Data updates

Provincial base amounts (`PROVINCES` in `core.js`) and the account interest rate are republished
yearly. When you update one:

- Keep the `year` accurate and set `status` honestly — `published`, `reference` (carried over from the
  prior year) or `manual` (not collected, generic fallback in use). A stale number presented as
  current is worse than an obvious gap.
- Cite the notice you took it from in the PR description.
- Leave `note` present whenever a province has sub-regions with different figures (Shenzhen,
  Changchun, Shenyang/Dalian, Heze).

## Style

- Chinese comments and English comments are both fine; match the file you are editing.
- Comments explain **why**, not what. A comment restating the next line will be asked to leave.
- Every module has a header comment saying what it is for and how it relates to the others.
- No new runtime dependencies. If you think one is needed, open an issue first — the zero-dependency
  property is a feature, not an accident.

## Tests

Three layers, each catching something the others cannot:

1. **Pure logic** (`test/core.test.js`) — the formulas, against published worked examples.
2. **Fake host context** (`test/plugin.test.js`) — tool behaviour, and every result checked against the
   tool's own declared `output.schema`.
3. **Real cordis composition** (`test/integration.test.js`) — dependency resolution, skill
   discoverability, clean disposal.

Two scripts sit outside the test runner on purpose, because they bind ports and shells out to a
browser: `scripts/verify-web.mjs` and `scripts/verify-plugin.mjs`.

If you add a tool, assert its result against its own schema in layer 2 — that is where plugins rot
quietly.

## Pull requests

- One change per PR. A formula fix and a README rewrite are two PRs.
- Update `README.md` and `README.zh.md` together; they are kept in sync.
- Regenerate artifacts (`npm run web`, `npm run skill`) rather than editing `dist/` or `SKILL.md` by
  hand — `npm run check` will reject hand-edited output.
- State what you verified and how. "Tests pass" is weaker than "`npm run check` passes, and here is the
  number that changed for the default profile".

## License

By contributing you agree your work is released under the MIT license in `LICENSE`.
