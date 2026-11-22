import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// A window too narrow for a Thread and the right sidebar side by side (1024 × 768, where the stage is 768 wide and the
// two need 791), on the mock bridge's desk (`?mock`). At launch the sidebar the person last used is restored only
// where it fits beside the Thread: here the Thread shows and the sidebar stays closed. It stays reachable: the title
// bar's button opens it over the Thread, and its Workbench button gives the Thread back. In a wide window (1440) it is
// restored beside the Thread, as before. Writes screenshots into <out>.
//
//   node scripts/test-stage-narrow.mjs <out> [--port 20047] [--observe]
//
// `--observe` checks nothing and only writes what each window shows at launch (for a before picture).
if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const out = resolve(args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--port") ?? "stage-narrow")
  const port = Number(args[args.indexOf("--port") + 1]) || 20047
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  await mkdir(join(out, "electron"), { recursive: true })
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true, watch: null } })
  await server.listen()
  await writeFile(join(out, "electron", "package.json"), JSON.stringify({ name: "mako-stage-narrow", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_STAGE_SHOTS: out, MAKO_STAGE_URL: `http://127.0.0.1:${port}/`, MAKO_STAGE_OBSERVE: args.includes("--observe") ? "1" : "" }
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
  console.log(`Stage screenshots: ${out}`)
}

async function shoot() {
  const { app, BrowserWindow, nativeTheme } = await import("electron")
  const out = process.env.MAKO_STAGE_SHOTS
  const base = process.env.MAKO_STAGE_URL
  const observe = Boolean(process.env.MAKO_STAGE_OBSERVE)
  app.setPath("userData", join(out, "electron", "profile"))
  await app.whenReady()
  nativeTheme.themeSource = "dark"
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))

  const window = new BrowserWindow({ width: 1024, height: 768, useContentSize: true, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  /** The one window at this size on the desk, booted anew; `read` evaluates in it. */
  const desk = async (width, height) => {
    window.setContentSize(width, height)
    const read = (code) => page.executeJavaScript(code)
    const until = async (code, what) => {
      const end = Date.now() + 20_000
      while (!(await read(code))) {
        if (Date.now() > end) {
          await writeFile(join(out, "timed-out.png"), (await page.capturePage()).toPNG())
          throw new Error(`Timed out: ${what}`)
        }
        await pause(50)
      }
    }
    const capture = async (name) => {
      await read("document.fonts.ready.then(() => true)")
      await pause(400)
      await writeFile(join(out, name), (await page.capturePage()).toPNG())
    }
    await window.loadURL(`${base}?mock&idle=1&theme=dark`)
    await until("document.querySelectorAll('[data-thread-row]').length > 0 && Boolean(document.querySelector('[data-workbench]'))", "the desk")
    // The stage's first measure, and what follows from it.
    await pause(600)
    return { read, until, capture }
  }
  /** What the stage shows: whether the Thread's workbench is laid out, and the sidebar, and whether it covers. */
  const shown = (read) =>
    read(`(() => {
      const box = (node) => { const r = node?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 ? Math.round(r.width) : 0 }
      const panel = document.querySelector('.companion-panel')
      return {
        inner: window.innerWidth,
        workbench: box(document.querySelector('[data-workbench]')),
        sidebar: box(panel),
        back: Boolean(panel && [...panel.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Workbench')),
        toggle: document.querySelector('[aria-label="Show the right sidebar"], [aria-label="Hide the right sidebar"]')?.getAttribute('aria-label') ?? null,
      }
    })()`)

  const narrow = await desk(1024, 768)
  const atLaunch = await shown(narrow.read)
  console.log(`1024 × 768 at launch: ${JSON.stringify(atLaunch)}`)
  await narrow.capture("narrow-at-launch.png")
  if (!observe) {
    assert.equal(atLaunch.inner, 1024, "the window is 1024 wide")
    assert.ok(atLaunch.workbench > 400, "the Thread shows at launch in a narrow window")
    assert.equal(atLaunch.sidebar, 0, "and the sidebar nobody asked for doesn't cover it")
    assert.equal(atLaunch.toggle, "Show the right sidebar", "the title bar offers the sidebar")

    // Asked for, it opens over the Thread, with the way back.
    await narrow.read("document.querySelector('[aria-label=\"Show the right sidebar\"]').click(); true")
    await narrow.until("Boolean(document.querySelector('.companion-panel'))", "the sidebar, asked for")
    const asked = await shown(narrow.read)
    assert.ok(asked.sidebar > 400 && asked.workbench === 0 && asked.back, `asked for, the sidebar covers the Thread and offers the way back: ${JSON.stringify(asked)}`)
    await narrow.capture("narrow-sidebar-asked-for.png")
    await narrow.read("[...document.querySelectorAll('.companion-panel button')].find((button) => button.textContent.trim() === 'Workbench').click(); true")
    await narrow.until("!document.querySelector('.companion-panel')", "the Thread back")
    const back = await shown(narrow.read)
    assert.ok(back.workbench > 400 && back.sidebar === 0, `its Workbench button gives the Thread back: ${JSON.stringify(back)}`)
  }

  const wide = await desk(1440, 900)
  const wideAtLaunch = await shown(wide.read)
  console.log(`1440 × 900 at launch: ${JSON.stringify(wideAtLaunch)}`)
  await wide.capture("wide-at-launch.png")
  if (!observe) assert.ok(wideAtLaunch.workbench >= 450 && wideAtLaunch.sidebar >= 340 && !wideAtLaunch.back, `in a wide window the sidebar is restored beside the Thread: ${JSON.stringify(wideAtLaunch)}`)
  console.log(observe ? "observed" : "ok   a narrow window opens on the Thread; the sidebar stays reachable; a wide one restores it beside")
  app.exit(0)
}
