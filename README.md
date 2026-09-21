# retirement-calc

Two answers: **how many days until you can retire**, and **how much you get per month afterwards**.

China began phasing in a higher statutory retirement age on 1 January 2025. The rules are
*exact* — the delay schedule and the contribution-year ramp are published as tables and
steps — yet most people (and most third-party calculators) answer from impression and land
years off. This project encodes the rules once and reuses them in three places.

```
Born Jan 1990 · male employee · Guangdong
→ retires Jan 2053 at 63 (36 months of delay), 9,599 days away
→ projected ￥7,673.48 / month (￥4,925.86 basic + ￥2,747.63 individual account)
```

## Three shapes

| Shape | For | How |
| --- | --- | --- |
| **Single-file web page** | anyone | Open `dist/retirement-calculator.html`, type on the left, watch the right update live |
| **DSH plugin** | DeepSeek Harness | A "days to retirement" button in the sidebar, plus three tools for the agent |
| **Agent skill** | other coding agents | Symlink `skills/retirement-planner/` into `~/.agents/skills` or similar |

All three share one `core.js`, so the page and the agent can never disagree.

## The rules

Every number traces to a published document.

### Statutory retirement age (NPC Standing Committee, 13 Sep 2024)

From 2025-01-01, by original statutory age:

| Group | Was | Delay | Ceiling |
| --- | --- | --- | --- |
| Male employee | 60 | 1 month per 4 months | **63** (+36 months) |
| Female, managerial/technical | 55 | 1 month per 4 months | **58** (+36 months) |
| Female, worker | 50 | 1 month per 2 months | **55** (+60 months) |

Positioning works off the date you *would* have retired under the old age, measured from
2025-01. The result matches the official table month by month: retiring Jan–Apr 2025 means
one month's delay, May–Aug means two, Sep–Dec means three, and so on.

> **The common trap.** A man born March 1978 does retire in March 2041 at 63. A woman born
> the same month does not. In the worker category she retires Nov 2029 at 51 years 8 months
> (20 months' delay); in the managerial category, April 2035 at 57 years 1 month (25 months).
> Some calculators apply the male delay schedule to women and overshoot by years — sex and
> job category are the two inputs you must never guess.

### Minimum contribution years

- Retiring 2029 or earlier: **15 years**
- From 2030, +6 months each year
- 2039 and later: **20 years**

### Annuity divisor (`计发月数`)

Taken at the **whole-year** age on the retirement date (Annex to Guofa〔2005〕38). Retiring
at 50 years 11 months uses the age-50 figure of 195, not 51's. Common values: 50→195,
55→170, 60→139, 63→117.

### Contribution base: a figure, or a tier

The contribution index is `base ÷ social average` for that year. The pension formula consumes the
**index**, but most people only know their **base** ("it's 10,000 now"), and the two are not
interchangeable:

- **Always contributing at the same tier** → the base rises along with the social average, so the
  index stays put.
- **A frozen base** → the social average keeps climbing, so the index **slides every year** and drags
  the average down.

So the tool accepts either. In *by contribution base* mode you enter your current monthly base and
choose whether it **tracks the social average** or stays **fixed** — only the latter reflects what
"just keep paying this amount" really costs. At the same 10,000, a frozen base comes out about 15%
lower.

Supporting rules:

- The base is bounded by **60%–300% of the social average**, so the derived index is clamped to
  `[0.6, 3.0]`.
- The individual account is credited at **8% of the real base**, not back-solved from
  "social average × index".
- If the planned contribution months exceed the months actually remaining until retirement, only the
  real ones count.

Conversely, if all you have is the average index printed on your social-insurance statement, entering
the index directly is simpler — that number already *is* the average of "base ÷ social average" over
the years.

### Pension composition

```
Basic          = (base × (1 + average index) ÷ 2) × contribution years × 1%
Individual     = account balance at retirement ÷ annuity divisor
Transitional   = base × deemed index × transition rate × deemed years
```

Guangdong and a few other provinces apply an extra haircut when the average index falls
below 0.6 (`a = index ÷ 0.6`); this tool enables it per province.

### Flexible retirement

Reaching the minimum contribution years permits voluntary early retirement up to **3 years**,
but never below the original statutory age. Agreement with the employer permits delay up to
**3 years**. The two are mutually exclusive.

## Quick start

### Web page

```bash
node scripts/build-web.mjs
open dist/retirement-calculator.html
```

The output is self-contained — send the file to anyone, no install needed.

### DSH plugin

```bash
# 1. Point the package at the harness's peer dependencies
mkdir -p retirement_calc/node_modules/@deepseek-ai
for p in cordis dsh-llm dsh-settings dsh-skill dsh-system-prompt dsh-tools schemastery; do
  ln -sfn "$HOME/.dsh/profiles/node_modules/@deepseek-ai/$p" "retirement_calc/node_modules/@deepseek-ai/$p"
done

# 2. Install into a profile (this edits the profile's package.json and cordis.patch.yml — back them up first)
dsh plugin --profile web add link:/path/to/retirement_calc

# 3. Confirm the composition picked it up
dsh --profile web --dump-config | grep retirement-calc
```

A "🕐 retirement in N days" button appears at the bottom of the sidebar. If the profile
already has a `retirement-calc` row, delete it first: two rows would each register the
`/retire/api` prefix route, and the duplicate makes the plugin tree fail to boot.

### Cross-tool skill

```bash
ln -s /path/to/retirement_calc/skills/retirement-planner ~/.agents/skills/retirement-planner
```

The skill carries the rules and the phrasing, not the numbers — install the plugin for
live computation.

## Tools

| Tool | Purpose |
| --- | --- |
| `retirement_plan` | Date, age, days remaining, monthly pension and its three parts |
| `retirement_profile` | `get` / `set` / `clear` the stored particulars and assumptions |
| `retirement_compare` | What-if: contribute more years, raise the index, retire later |

The profile lives at `$DSH_HOME/retirement-calc.json`. Panel edits go through `preview`
(compute only); nothing is written until you press save.

## Configuration

```yaml
- insert:
    - id: retirement-calc
      name: '@dsh-plugin/retirement-calc'
      config:
        promptSection: true
        skill: true
        # stateFile: /absolute/path/retirement-calc.json
```

Calculation parameters — base-amount growth, account interest rate, transition coefficient —
live in the **profile**, editable from the panel or the tools, not here. One place to change
a number is the point.

## Development

```bash
npm test              # 52 tests: 23 core formula + 15 plugin behaviour + 7 real cordis composition + 7 client structure
npm run verify        # drive the built page in a headless browser: rendering and live recompute
npm run verify:plugin # mount on a real WebServer, hit /retire/api over HTTP (touches no profile)
npm run audit         # secret scan: credentials, home paths, private IPs, emails
npm run check         # all of the above plus skill/artifact drift checks
npm run web           # rebuild the single-file page
```

`npm test` needs **no install step**: the package has no runtime dependencies. The harness-dependent
layers (plugin behaviour, real composition, live routes) skip themselves with a stated reason rather
than failing when the peer packages are absent — so a clean clone gets a green, lower-coverage run.

Several tests are deliberate anchors that fire the moment a formula drifts:

- **Published worked examples** — the two problems in Jiangxi Xinyu's bureau article
  *"Can you compute your pension?"*, whose answers are 955.29 and 3967.89; the engine
  reproduces both to the cent.
- **Delay table** — month-by-month spot checks plus each group's ceiling age.
- **Minimum years** — the 2030 / 2038 / 2039 / 2041 steps.
- **Annuity divisor** — whole-year lookup (50y11m uses the age-50 value).

`npm run verify:plugin` deserves a note of its own: it mounts the plugin on a **real**
cordis composition in a temp directory, brings up an actual WebServer, and drives every
`/retire/api` route over HTTP — including the cross-site guard and teardown. It reads and
writes no profile at all, and the process leaves nothing behind. Run it when you want to
know whether the plugin will work inside Harness without touching your live environment.

## Security and privacy

- **Zero runtime dependencies, zero outbound requests, zero telemetry.** The package opens no
  external connection and reports nothing anywhere. The single-file page is the same — open it with
  the network unplugged and every feature still works.
- **One file on disk.** `$DSH_HOME/retirement-calc.json`, written atomically. It holds a birth month,
  a province and a contribution history; it does not leave the machine.
- **The HTTP routes have a same-origin fence.** `/retire/api` is registered directly on the harness's
  web server and is **not** behind its `/api` browser-trust fence, while profile updates arrive as
  simple cross-origin POSTs (a `text/plain` body is parsed just the same). Every route therefore
  checks that `Origin` and `Host` agree — otherwise any page the user happened to visit could read or
  rewrite their profile.
- **No dynamic evaluation**: no `eval`, no child processes, no template engine. `innerHTML` only ever
  receives self-generated numbers and hard-coded labels, and the form offers nothing but `number`,
  `range` and `select` controls.
- **Caller-supplied field maps are read with `Object.hasOwn`**, so a `__proto__` key cannot reach
  `Object.prototype` through the lookup table.

The full threat model, scope boundaries and hardening list are in [SECURITY.md](SECURITY.md).
Secret scanning runs as `npm run audit` and is wired into CI on every push.

## Limits

- This is an **estimate, not a promise**. Base amounts, interest rates and contribution caps
  are republished yearly by each province; the growth rates here are assumptions. Your
  actual benefit is whatever the social insurance office determines.
- The built-in provincial base table carries a year and a status: `published` (official),
  `reference` (carried over from the prior year), `manual` (not collected — a generic
  fallback is used and the panel says so). Henan, Shaanxi and Gansu are `manual`.
- Transitional pensions vary widely by province (coefficients 1.0%–1.4%, different rules for
  deemed-contribution indices). Where deemed years are involved, defer to the local office.
- No investment advice, no commercial annuity product recommendations.

## License

MIT
