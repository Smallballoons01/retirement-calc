# Security Policy

## Reporting a vulnerability

Open a [private security advisory](../../security/advisories/new) on the repository, or email the
maintainer listed in `package.json`. Please do not open a public issue for anything exploitable.

Expect an acknowledgement within a few days. This is a small, single-maintainer project with no
funding behind it — a fix may take a while, but you will hear back.

## What this project touches

Knowing the blast radius is most of the review, so here it is in full:

| Surface | Detail |
| --- | --- |
| Files read/written | Exactly one: `$DSH_HOME/retirement-calc.json` (override with `stateFile`). Written atomically via a temp file + rename. |
| Network egress | **None.** Nothing in this package opens an outbound connection. |
| Telemetry | **None.** No analytics, no phone-home, no crash reporting. |
| Runtime dependencies | **Zero.** `dependencies` is empty; `@deepseek-ai/*` are host-provided peers. |
| HTTP routes | `POST /retire/api/{status,preview,save,reset,catalog}` on the harness's own web server. |
| Code execution | None. No `eval`, no `new Function`, no child processes. |

The single-file calculator in `dist/` is the same story: it is fully self-contained, so it makes no
requests at all — open it with the network unplugged and every feature still works.

## Threat model

**What is worth protecting.** The stored profile contains birth month, sex, province, contribution
history and account balance. It is personal but not secret in the credential sense — the real risk is
that a page the user merely *visits* could read or modify it.

**The concrete attack.** The `/retire/api` routes are registered directly on the harness's web server,
which means they are **not** behind the harness's own `/api` browser-trust fence. A handler that
accepts a `text/plain` body which happens to parse as JSON can be reached by a *simple* cross-origin
`POST` — no preflight, no CORS block. Without a guard, any page open in any tab could rewrite the
user's profile or read it back.

**The mitigation.** Every route rejects a request whose `Origin` host differs from its `Host` header,
and treats an unparseable or `null` origin as cross-site. Requests with no `Origin` at all are
allowed, because that is what a CLI client sends and it is not something a browser can forge.
See `crossSiteRequest()` in `index.js`.

**What is explicitly out of scope.** This tool runs inside the user's own harness process, with that
process's privileges, and reads a file in their home directory. An attacker who can already write to
`$DSH_HOME` or execute code in that process does not need a vulnerability here. Likewise, the
calculator is a static page with no server component — hosting it somewhere untrusted is a
distribution problem, not a vulnerability in it.

## Hardening already in place

- **Cross-site guard** on every route (above), covered by tests in `test/plugin.test.js` and by a real
  HTTP request in `scripts/verify-plugin.mjs`.
- **No trust in caller-supplied field maps.** `translateFields()` uses `Object.hasOwn` rather than
  `map[key]`, so a key like `__proto__` — which `JSON.parse` *does* surface as an own property —
  cannot reach `Object.prototype` through the lookup table.
- **Every input is clamped.** `normalizeInput()` bounds each numeric field, so a hostile value becomes
  a wrong-but-finite estimate rather than a crash or an absurd result.
- **No dynamic evaluation.** Nothing is `eval`'d; there is no template engine and no shell.
- **`innerHTML` only ever receives self-generated content.** The calculator's render functions
  interpolate formatted numbers and hard-coded labels — never raw user input, and the form offers only
  `number`, `range` and `select` controls. `textContent` is used wherever user-facing text is involved
  in the plugin's panel.
- **Secret scanning in CI.** `scripts/audit-secrets.mjs` rejects absolute home paths, private keys,
  known credential prefixes, JWTs, private IP ranges and email addresses; it runs as part of
  `npm run check`.
- **Human review of the whole surface.** The package is small enough to be read end to end, and it has
  no dependencies whose contents would need separate review.

## Supported versions

Only the latest `0.1.x` line receives fixes. This library performs arithmetic on published formulas;
when a formula or a published figure changes, that is a correctness issue rather than a security one,
and it will be handled in a normal release.
