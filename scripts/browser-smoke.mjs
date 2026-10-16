/**
 * Browser smoke test — renders the retirement panel in a real browser against a
 * running `dsh web` and verifies the sidebar entry, the panel, and light/dark
 * theme tokens. Not part of `npm test` (it needs a live Harness and Playwright);
 * run it manually before a release:
 *
 *   dsh --profile web --no-open --port 8321 &
 *   DSH_WEB_URL="http://127.0.0.1:8321/?token=…" pnpm test:browser
 *
 * Skips (exit 0) when Playwright is not installed.
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const url = process.env.DSH_WEB_URL || process.argv[2]
if (!url) {
  console.log('SKIP: pass the dsh web URL via DSH_WEB_URL or argv')
  process.exit(0)
}

let chromium
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'))
} catch {
  console.log('SKIP: playwright is not installed')
  process.exit(0)
}

const shots = os.tmpdir()
const errors = []
const browser = await chromium.launch()

/**
 * Page errors raised by *other* plugins in the same profile are not this
 * plugin's failure. A profile commonly carries third-party rows whose inject
 * declarations lag the host, and their errors surface on every page. Only
 * errors attributable to this plugin's own bundle count as a failure.
 */
const FOREIGN_ERROR = /remote\.session|without inject/i

async function openPanel (colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme })
  page.on('pageerror', (e) => { if (!FOREIGN_ERROR.test(e.message)) errors.push(`pageerror: ${e.message}`) })
  page.on('console', (m) => { if (m.type() === 'error' && !FOREIGN_ERROR.test(m.text())) errors.push(`console: ${m.text()}`) })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // Dismiss the host's "Preview Notice" modal if it shows up.
  const dialog = page.locator('[role="dialog"]')
  await dialog.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  if (await dialog.count()) {
    await dialog.first().locator('button').first().click().catch(() => {})
  }
  // The sidebar footer action shows the live "距退休 N 天" button.
  await page.locator('.dsh-rc-button').first().click()
  await page.locator('.dsh-rc-panel').first().waitFor({ state: 'visible', timeout: 15000 })
  return page
}

// Light scheme: sidebar entry, panel root, the retirement countdown hero.
const page = await openPanel('light')
console.log('PASS sidebar entry visible')
console.log('PASS panel .dsh-rc-panel rendered')
await page.locator('.dsh-rc-hero .dsh-rc-hero-v').first().waitFor({ state: 'visible', timeout: 10000 })
console.log('PASS retirement countdown hero visible')

// The panel paints its own background from a hosted token; the primary button
// uses a hard-coded fill by design (brand tokens are neutral, not blue), so
// only the panel background is expected to follow the scheme.
const panelBg = await page.locator('.dsh-rc-panel').first().evaluate((el) => getComputedStyle(el).backgroundColor)
const fg = await page.locator('.dsh-rc-panel').first().evaluate((el) => getComputedStyle(el).color)
if (panelBg === 'rgba(0, 0, 0, 0)' || fg === 'rgba(0, 0, 0, 0)') {
  throw new Error(`theme tokens unresolved: panelBg=${panelBg} fg=${fg}`)
}
console.log(`PASS light theme tokens resolve (panelBg=${panelBg}, fg=${fg})`)
await page.screenshot({ path: path.join(shots, 'retire-panel-light.png') })
await page.close()

// Dark scheme: the same tokens must resolve to a different palette.
const dark = await openPanel('dark')
const darkPanelBg = await dark.locator('.dsh-rc-panel').first().evaluate((el) => getComputedStyle(el).backgroundColor)
if (darkPanelBg === panelBg) throw new Error(`dark scheme did not change the palette: ${darkPanelBg}`)
console.log(`PASS dark scheme re-themes (panelBg=${panelBg} -> ${darkPanelBg})`)
await dark.screenshot({ path: path.join(shots, 'retire-panel-dark.png') })
await dark.close()

await browser.close()

if (errors.length) {
  console.log('JS errors observed:')
  for (const e of errors) console.log('  ' + e)
  process.exit(1)
}
console.log('PASS no page errors')
