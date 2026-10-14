import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The usage surfaces from `scripts/usage-check.html` (src/dev/usage-check.tsx),
// light and dark: the meter's popover for four kinds of harness reading, the
// line offering another account at a plan limit, and Settings › Usage. Checks
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
    assert.match(await text("[data-fixture-limit]"), /work@example\.com is at 96% of its weekly limit; personal@example\.com is at 12%\./)
    const settings = await text("[data-fixture-settings]")
    assert.match(settings, /≈ \$96\.42/)
    assert.match(settings, /Mako: Commit messages/)
    assert.match(settings, /No figure here is a bill/)
    await capture(`meter-popovers-${theme}.png`, "[data-fixture-meters]")
    await capture(`limit-offer-${theme}.png`, "[data-fixture-limit]")
    await capture(`settings-usage-${theme}.png`, "[data-fixture-settings]")
  }
  app.exit(0)
}
