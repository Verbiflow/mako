import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The usage surfaces from `scripts/usage-check.html` (src/dev/usage-check.tsx),
// light and dark: the meter's popover for four kinds of harness reading (Cursor's itemized), the
// line offering another account at a plan limit, and Settings › Usage with the
// changes agents made. Checks
// what each must say and writes the screenshots into <out>.
//
//   node scripts/usage-ui-screenshots.mjs <out> [--port 20024]
if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const out = resolve(args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--port") ?? "usage-screenshots")
  const port = Number(args[args.indexOf("--port") + 1]) || 20024
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  await mkdir(join(out, "electron"), { recursive: true })
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true, watch: null } })
  await server.listen()
  await writeFile(join(out, "electron", "package.json"), JSON.stringify({ name: "mako-usage-screenshots", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_USAGE_SHOTS: out, MAKO_USAGE_URL: `http://127.0.0.1:${port}/scripts/usage-check.html` }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [join(out, "electron")], { env, stdio: "inherit" })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Usage screenshots: ${out}`)
}

async function shoot() {
  const { app, BrowserWindow, nativeTheme } = await import("electron")
  const out = process.env.MAKO_USAGE_SHOTS
  app.setPath("userData", join(out, "electron", "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 1800, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code, what) => {
    const end = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) throw new Error(`Timed out: ${what}`)
      await pause(50)
    }
  }
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`)
  const capture = async (name, selector) => {
    await evaluate("document.fonts.ready")
    await pause(300)
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.floor(r.x) - 16, y: Math.floor(r.y) - 16, width: Math.ceil(r.width) + 32, height: Math.ceil(r.height) + 32 } })()`)
    await writeFile(join(out, name), (await page.capturePage(box)).toPNG())
  }
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme
    await window.loadURL(`${process.env.MAKO_USAGE_URL}?theme=${theme}`)
    // Tall enough that Settings › Usage is captured whole, at the Retina scale people see.
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1440, height: 2600, deviceScaleFactor: 2, mobile: false })
    await until("Boolean(document.querySelector('[data-fixture-settings] [data-usage-total]'))", "Settings › Usage read the summary")
    const meters = await text("[data-fixture-meters]")
    assert.match(meters, /124k of 200k tokens in the window now/)
    assert.match(meters, /Claude Code’s own count for this session/)
    assert.match(meters, /Held 16k of 262k tokens before compacting\. Devin doesn't say what a compaction left/)
    assert.match(meters, /Cost at API list prices≈ \$0\.49/)
    assert.match(meters, /The side question isn't in these totals/)
    assert.doesNotMatch(await text("[data-fixture='devin']"), /\d+%/, "no fill is shown for a compaction nothing measured")
    await until("Boolean(document.querySelector(\"[data-fixture='cursor'] [data-context-categories]\"))", "Cursor's popover itemized its reading")
    const cursor = await text("[data-fixture='cursor']")
    assert.match(cursor, /85k of 300k tokens in the window now/)
    assert.match(cursor, /Summarized conversation/)
    assert.match(await text("[data-fixture-limit]"), /work@example\.com is at 96% of its weekly limit · personal@example\.com is at 12%/)
    const settings = await text("[data-fixture-settings]")
    assert.match(await text("[data-usage-total]"), /^≈ \$[\d,]+\.\d{2}$/, "the month's cost, marked as partly estimated")
    assert.match(settings, /spent in the last 30 days/)
    assert.match(settings, /Mako: Commit messages/)
    assert.match(settings, /No figure here is a bill/)
    assert.equal(await evaluate("document.querySelectorAll('[data-usage-chart=month] [role=group] > div > div').length"), 30, "a bar for each of the month's days")
    // The readout names a day and adds its sources up to the day's total.
    await evaluate("document.querySelector('[data-usage-chart=month] [role=group]').focus()")
    await page.sendInputEvent({ type: "keyDown", keyCode: "Left" })
    await until("Boolean(document.querySelector('[data-usage-readout]'))", "the chart reads a day out")
    assert.match(await text("[data-usage-readout]"), /Total/)
    await capture(`settings-usage-readout-${theme}.png`, "[data-usage-spend]")
    await page.sendInputEvent({ type: "keyDown", keyCode: "Escape" })
    // Another window and measure read the same summary: nothing is asked of the host again.
    await evaluate("[...document.querySelectorAll('[aria-label=Window] button')].find((button) => button.textContent === '24 hours').click()")
    await until("Boolean(document.querySelector('[data-usage-chart=day]'))", "the last 24 hours, by the hour")
    assert.equal(await evaluate("document.querySelectorAll('[data-usage-chart=day] [role=group] > div > div').length"), 24)
    await evaluate("[...document.querySelectorAll('[aria-label=Measure] button')].find((button) => button.textContent === 'Tokens').click()")
    await until("/tokens$/.test(document.querySelector('[data-usage-total]')?.textContent ?? '')", "the total in tokens")
    await evaluate("[...document.querySelectorAll('[aria-label=\"Break down by\"] button')].find((button) => button.textContent === 'Hour').click()")
    await until("Boolean(document.querySelector('[data-usage-breakdown=period]'))", "the breakdown by hour")
    await capture(`settings-usage-day-tokens-${theme}.png`, "[data-usage-spend]")
    await evaluate("[...document.querySelectorAll('[aria-label=Window] button')].find((button) => button.textContent === '30 days').click()")
    await evaluate("[...document.querySelectorAll('[aria-label=Measure] button')].find((button) => button.textContent === 'Cost').click()")
    await evaluate("[...document.querySelectorAll('[aria-label=\"Break down by\"] button')].find((button) => button.textContent === 'Project').click()")
    await until("/more projects/.test(document.querySelector('[data-usage-breakdown=project]')?.textContent ?? '')", "the projects past the twelfth summed as one row")
    await until("Boolean(document.querySelector('[data-fixture-settings] [data-changes-total]'))", "Settings › Usage read the changes agents made")
    const changes = await text("[aria-labelledby='usage-changes']")
    assert.match(changes, /1,284 files/)
    assert.match(changes, /by 23 threads in the last 14 days/)
    assert.match(changes, /\+48,210 −17,932 lines/)
    assert.match(changes, /92% certain/)
    assert.match(changes, /Best guesses you put back3 of 41/)
    assert.match(changes, /Left behind, then brought9 of 58/)
    assert.match(changes, /~\/projects\/billing912 files/)
    await capture(`meter-popovers-${theme}.png`, "[data-fixture-meters]")
    // A long session's meter at the foot of a short window: the popover stops at the window's top, scrolls between its fixed reading and Compact.
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1440, height: 460, deviceScaleFactor: 2, mobile: false })
    await evaluate("document.querySelector('[data-fixture-bounded] [data-context-meter]').click()")
    await until("Boolean(document.querySelector('[data-slot=popover-content] [data-context-categories]'))", "the long session's popover itemized its context")
    const bounded = await evaluate(`(() => {
      const panel = document.querySelector("[data-slot=popover-content]").getBoundingClientRect()
      const scroller = document.querySelector("[data-slot=popover-content] [data-usage-scroll]")
      const compact = document.querySelector("[data-slot=popover-content] [data-usage-details] > :last-child").getBoundingClientRect()
      return { top: panel.top, bottom: panel.bottom, height: innerHeight, scrolls: scroller.scrollHeight > scroller.clientHeight, compact: compact.height > 0 && compact.bottom <= panel.bottom + 0.5 && compact.top >= panel.top }
    })()`)
    assert.ok(bounded.top >= 0, `the popover starts inside the window (top ${bounded.top})`)
    assert.ok(bounded.bottom <= bounded.height, "and ends inside it")
    assert.ok(bounded.scrolls, "what the session grew scrolls inside the popover")
    assert.ok(bounded.compact, "Compact stays in view at the popover's foot")
    assert.equal(await evaluate("document.querySelectorAll('[data-slot=popover-content] details[open]').length"), 0, "item groups start folded")
    const box = await evaluate("(() => { const r = document.querySelector('[data-slot=popover-content]').getBoundingClientRect(); return { x: Math.floor(r.x) - 16, y: Math.max(0, Math.floor(r.y) - 16), width: Math.ceil(r.width) + 32, height: Math.ceil(r.height) + 32 } })()")
    await evaluate("document.fonts.ready")
    await pause(300)
    await writeFile(join(out, `meter-bounded-${theme}.png`), (await page.capturePage(box)).toPNG())
    await page.sendInputEvent({ type: "keyDown", keyCode: "Escape" })
    await until("!document.querySelector('[data-slot=popover-content]')", "the popover closed")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1440, height: 2600, deviceScaleFactor: 2, mobile: false })
    await capture(`limit-offer-${theme}.png`, "[data-fixture-limit]")
    await capture(`settings-usage-${theme}.png`, "[data-fixture-settings]")
    await capture(`settings-changes-${theme}.png`, "[aria-labelledby='usage-changes']")
  }
  app.exit(0)
}
