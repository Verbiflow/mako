import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The waiting-on-background-work state in production components: the line
// at the transcript's end, the Agents panel, the status marks, in dark and
// light, and what a subagent's progress costs the panel. Runs the isolated
// live workflow fixture; no agent is started. Pass a dev web desk's URL to
// use its Vite server (`node scripts/test-background-work-ui.mjs
// http://127.0.0.1:20027/`); with none it serves its own.
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = await mkdtemp(join(tmpdir(), "mako-background-work-ui-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-background-work-ui", main: fileURLToPath(import.meta.url) }))
  const given = process.argv[2]
  let server
  if (!given) {
    const { createServer } = await import("vite")
    server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const env = { ...process.env, MAKO_BACKGROUND_UI_ROOT: root, MAKO_BACKGROUND_UI_URL: given ?? server.resolvedUrls.local[0] }
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
  console.log(`Background work UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_BACKGROUND_UI_ROOT
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const errors = []
  page.on("console-message", (event) => { if (event.level === "error") errors.push(event.message) })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}`)
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))).then(() => true)")
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const theme = (light) => evaluate(`document.documentElement.classList.toggle('light', ${light}); document.documentElement.style.colorScheme = '${light ? "light" : "dark"}'; true`)

  await window.loadURL(new URL("scripts/live-workflow.html", process.env.MAKO_BACKGROUND_UI_URL).href)
  await until("Boolean(document.querySelector('[data-fixture=background]'))")
  await evaluate("document.querySelector('[data-fixture=background]').click(); true")
  await until("Boolean(document.querySelector('[data-background-work]'))")

  // The transcript's end: what runs, in words, then each piece with its time.
  const line = await evaluate("document.querySelector('[data-background-work]').innerText")
  assert.match(line, /^Waiting on 3 background tasks/)
  assert.match(line, /Build the desktop app/)
  assert.match(line, /7 tool uses/)
  assert.match(line, /1m 1\ds/, "elapsed counts from when the task started")
  assert.doesNotMatch(line, /Live update watcher/, "an ambient watcher is not something the session waits on")
  assert.doesNotMatch(line, /Lint the changed files/, "settled work has left the line")

  // The panel: every entry, the settled one with its output, ambient last.
  const panel = await evaluate("document.querySelector('aside').innerText")
  assert.match(panel, /Waiting on 3 background tasks/)
  assert.match(panel, /1 finished/)
  const order = await evaluate("[...document.querySelectorAll('aside article')].map((row) => row.dataset.nativeWork + ':' + row.dataset.nativeState)")
  assert.deepEqual(order, ["command:working", "agent:working", "monitor:working", "command:completed", "monitor:working"])
  assert.equal(await evaluate("document.querySelectorAll('aside article button[aria-label^=\"Stop \"]').length"), 3, "each task its provider can stop alone offers Stop")

  // The marks: running, waiting on background work, and done are three different things.
  const marks = await evaluate("[...document.querySelectorAll('[data-fixture=status-marks] [role=img]')].map((mark) => mark.getAttribute('aria-label'))")
  assert.deepEqual(marks, ["Working in Mako", "Waiting on 3 background tasks", "Answer ready to review"])
  assert.equal(await evaluate("document.querySelector('[data-background-mark] .activity-mark, [data-background-mark] canvas') === null"), true, "the waiting mark is not the running mark")

  await theme(false)
  await capture("background-dark.png")
  await theme(true)
  await capture("background-light.png")
  await evaluate("document.querySelector('aside article[data-native-state=completed] button').click(); true")
  await until("Boolean(document.querySelector('[data-native-output]'))")
  assert.match(await evaluate("document.querySelector('[data-native-output]').innerText"), /No problems found/)
  await capture("background-light-output.png")
  await theme(false)
  await capture("background-dark-output.png")

  // Cost: one entry of fifty moves per batch, 120 batches.
  const baseline = await evaluate("window.makoBackgroundBench(false)")
  const reconciled = await evaluate("window.makoBackgroundBench(true)")
  console.log(`Agents panel, 50 entries, one moving: ${baseline.perBatchMs} ms a batch replacing the roster, ${reconciled.perBatchMs} ms reconciled`)
  assert.ok(reconciled.perBatchMs * 3 < baseline.perBatchMs, "a progress batch re-renders one row, not the panel")
  // A shared dev server's hot update re-runs the fixture's entry; that is the server's, not the page's.
  assert.deepEqual(errors.filter((message) => !/Download the React DevTools|already been passed to createRoot/.test(message)), [])
  console.log("Background work UI: transcript line, Agents panel, status marks in dark and light, and progress cost passed")
  app.exit(0)
}
