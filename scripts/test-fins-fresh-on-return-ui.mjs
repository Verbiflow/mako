import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

/**
 * An Apex's Fins are current the moment the person comes back to its Thread (`npm run test:fins-fresh-on-return-ui`):
 * the person opens the Apex, leaves for another Thread, its Fins move while it's off screen (some finish, one is
 * stopped, one asks), and the person comes back. Sampled every frame from the click, the crew card never draws the
 * roster from before, and draws the one the host said last from its first frame, without the composer being touched.
 */
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-fins-fresh-on-return-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-fins-fresh-on-return-ui", main: fileURLToPath(import.meta.url) }))
  const given = process.argv.slice(2).find((arg) => /^https?:/.test(arg))
  let server
  if (!given) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const env = { ...process.env, MAKO_FRESH_UI_ROOT: root, MAKO_FRESH_UI_URL: given ?? server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server?.close()
  }
}

/** The asks of Fins drawn on screen, by what each asks: in the crew card, or over the composer. */
const ASKS = `[...document.querySelectorAll("[data-fin-ask]")].map((ask) => ask.innerText.replace(/\\s+/g, " ").trim())`

/** Every frame from now: the asks drawn. */
const SAMPLER = `(() => {
  const frames = []
  const look = () => {
    frames.push(${ASKS})
    window.__fresh.raf = requestAnimationFrame(look)
  }
  window.__fresh = { frames, raf: requestAnimationFrame(look) }
  return true
})()`

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_FRESH_UI_ROOT
  const shots = join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 1100, show: false, webPreferences: { backgroundThrottling: false } })
  atSize(window, 1440, 1100)
  const page = window.webContents
  const errors = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, what = code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await writeFile(join(shots, "fins-fresh-timeout.png"), (await page.capturePage()).toPNG())
        throw new Error(`Timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
      }
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const capture = async (name) => writeFile(join(shots, `fins-fresh-${name}.png`), (await page.capturePage()).toPNG())
  /** The page's own: opens a Thread by its row's title. */
  const OPEN = "window.__open = (title) => { [...document.querySelectorAll('[data-thread-row]')].find((row) => row.innerText.includes(title)).click(); return true }; true"

  await window.loadURL(`${process.env.MAKO_FRESH_UI_URL}?mock&app=apex&apexes=1`)
  await until("[...document.querySelectorAll('[data-thread-row]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row")
  await evaluate(OPEN)
  await evaluate("window.__open('Mobile polish')")
  await until("document.querySelectorAll('[data-fin-ask]').length > 0", "the Apex's Fins' asks")
  const before = await evaluate(`window.__before = ${ASKS}`)
  assert.ok(before.length > 1, `the Apex's Fins ask: ${JSON.stringify(before)}`)
  await capture("before")

  // Away, on another Apex's Thread, while this one's Fins move as its host's batches say: every ask is answered and
  // its Fin finishes, all but four go, and one of those four asks something new.
  await evaluate("window.__open('Apex 1')")
  await until(`(() => { const asks = ${ASKS}; return !asks.some((ask) => window.__before.includes(ask)) })()`, "the other Apex on screen")
  await evaluate(`(() => {
    const fins = window.apexScene.children().filter((agent) => agent.child).slice(0, 4)
    window.apexScene.setChildren(fins.map((agent, index) => ({ ...agent, child: { ...agent.child, state: index === 0
      ? { kind: "blocked", on: "person", question: "Ship the sheet now or after the review?", ask: { kind: "report", id: "report:fresh:ship", options: [{ label: "Now" }, { label: "After the review" }], recommended: 1, action: "Pick when the sheet ships." } }
      : { kind: "ended", outcome: "done", reason: "Done." } } })))
    return true
  })()`)

  // Back: sampled every frame from the click.
  await evaluate(SAMPLER)
  await evaluate("window.__open('Mobile polish')")
  await until("window.__fresh.frames.some((asks) => asks.some((ask) => ask.includes('Ship the sheet now')))", "the new ask")
  await until("window.__fresh.frames.length > 30", "frames after coming back")
  const frames = await evaluate("(() => { cancelAnimationFrame(window.__fresh.raf); return window.__fresh.frames })()")
  await capture("after")
  const stale = frames.findIndex((asks) => asks.some((ask) => before.includes(ask)))
  assert.equal(stale, -1, `no frame draws an ask answered while away: frame ${stale} of ${frames.length} drew ${JSON.stringify(frames[stale])}`)
  const shown = frames.findIndex((asks) => asks.some((ask) => ask.includes("Ship the sheet now")))
  assert.ok(frames.slice(shown).every((asks) => asks.length === 1), "from the first frame of the Apex on, its one ask, alone")
  assert.deepEqual(errors, [], "the page said nothing went wrong")
  console.log(`Fins fresh on return: coming back to an Apex whose Fins moved while away, no frame of ${frames.length} draws the ${before.length} asks answered meanwhile, and the new one is drawn from frame ${shown}`)
  app.exit(0)
}
