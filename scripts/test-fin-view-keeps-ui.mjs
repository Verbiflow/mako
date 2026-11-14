import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

/**
 * What an Apex's Thread shows stays through whatever its session does (`npm run test:fin-view-keeps-ui`): the person
 * writes in the composer of an Apex at rest, which wakes it ("Starting …"), and its session then runs a turn, drops
 * and reconnects, starts again, fails and comes back, with its harness each of Mako's in turn. Through all of it,
 * sampled every frame, the crew card and the transcript's messages never leave the screen.
 */
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-fin-view-keeps-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-fin-view-keeps-ui", main: fileURLToPath(import.meta.url) }))
  const given = process.argv.slice(2).find((arg) => /^https?:/.test(arg))
  let server
  if (!given) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const env = { ...process.env, MAKO_KEEPS_UI_ROOT: root, MAKO_KEEPS_UI_URL: given ?? server.resolvedUrls.local[0] }
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

const HARNESSES = ["claude", "codex", "cursor", "opencode", "grok", "devin"]

/** Every frame: whether the crew card and its rows are drawn, and how many of the transcript's messages are. */
const SAMPLER = `(() => {
  const seen = { frames: 0, crewMissing: 0, fewestRows: Infinity, fewestMessages: Infinity, statuses: new Set() }
  const look = () => {
    seen.frames += 1
    const crew = document.querySelector("[data-crew]")
    if (!crew) seen.crewMissing += 1
    seen.fewestRows = Math.min(seen.fewestRows, document.querySelectorAll("[data-crew-row]").length)
    seen.fewestMessages = Math.min(seen.fewestMessages, document.querySelectorAll("[data-message-avatar], [data-fin-report]").length)
    window.__keeps.raf = requestAnimationFrame(look)
  }
  window.__keeps = { seen, raf: requestAnimationFrame(look) }
  return true
})()`
const READ = `(() => { cancelAnimationFrame(window.__keeps.raf); const { seen } = window.__keeps; return { frames: seen.frames, crewMissing: seen.crewMissing, fewestRows: seen.fewestRows, fewestMessages: seen.fewestMessages } })()`

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_KEEPS_UI_ROOT
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
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const capture = async (name) => writeFile(join(shots, `fin-view-keeps-${name}.png`), (await page.capturePage()).toPNG())

  await window.loadURL(`${process.env.MAKO_KEEPS_UI_URL}?mock&app=apex&resting=1`)
  await until("[...document.querySelectorAll('[data-thread-row]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row")
  await evaluate("[...document.querySelectorAll('[data-thread-row]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
  await until("Boolean(document.querySelector('[data-composer] .composer-input'))", "the Apex's composer")
  // At rest: its turn over, its provider put away, as a host hibernates one idle a while.
  await evaluate("window.apexScene.setRunning(false); window.apexScene.setSession({ connection: 'hibernated', status: 'ready' }); true")
  await until("document.querySelectorAll('[data-crew-row]').length > 0", "the crew card at rest")
  const rows = await evaluate("document.querySelectorAll('[data-crew-row]').length")
  const messages = await evaluate("document.querySelectorAll('[data-message-avatar], [data-fin-report]').length")
  assert.ok(rows > 0 && messages > 0, `the Apex shows its Fins and its conversation: ${rows} rows, ${messages} messages`)
  await capture("rest")

  // The person writes: the first keys wake the Apex, which says it's starting.
  await evaluate(SAMPLER)
  await evaluate("(() => { const field = document.querySelector('[data-composer] .composer-input'); field.focus(); document.execCommand('insertText', false, 'How are the queued ones doing now?'); return true })()")
  await until("window.apexScene.prewarms() === 1", "writing to wake the Apex")
  await until("document.querySelector('[data-composer] .composer-input')?.placeholder !== undefined && (window.__keeps.seen.frames > 10)", "frames while it starts")
  await capture("starting")
  await wait(1_600)
  const woke = await evaluate(READ)
  assert.equal(woke.crewMissing, 0, `the crew card stays while the Apex starts: missing in ${woke.crewMissing} of ${woke.frames} frames`)
  assert.equal(woke.fewestRows, rows, "every row of it stays")
  assert.ok(woke.fewestMessages >= messages, `the transcript stays: ${woke.fewestMessages} of ${messages} messages at the least`)

  // Every transition a session goes through, on every harness: a turn, a drop and its reconnect, a start again, a
  // failure and its recovery, each held long enough to be painted.
  const steps = [
    ["a turn", "window.apexScene.setRunning(true)"],
    ["its end", "window.apexScene.setRunning(false)"],
    ["dropped", "window.apexScene.setSession({ connection: 'disconnected', status: 'ready' })"],
    ["reconnecting", "window.apexScene.setSession({ connection: 'starting', status: 'starting' })"],
    ["back", "window.apexScene.setSession({ connection: 'connected', status: 'ready' })"],
    ["failed", "window.apexScene.setSession({ status: 'failed', error: 'The provider exited.' })"],
    ["recovered", "window.apexScene.setSession({ connection: 'connected', status: 'ready', error: undefined })"],
    ["at rest", "window.apexScene.setSession({ connection: 'hibernated', status: 'ready' })"],
  ]
  for (const harness of HARNESSES) {
    await evaluate(SAMPLER)
    await evaluate(`window.apexScene.setSession({ harness: ${JSON.stringify(harness)} }); true`)
    for (const [what, code] of steps) {
      await evaluate(`${code}; true`)
      await wait(120)
      if (harness === "cursor" && (what === "reconnecting" || what === "failed")) await capture(`${harness}-${what.replaceAll(" ", "-")}`)
    }
    const seen = await evaluate(READ)
    assert.ok(seen.frames > 20, `${harness}: frames were painted through its transitions (${seen.frames})`)
    assert.equal(seen.crewMissing, 0, `${harness}: the crew card stays through every transition: missing in ${seen.crewMissing} of ${seen.frames} frames`)
    assert.equal(seen.fewestRows, rows, `${harness}: every row of it stays`)
    assert.ok(seen.fewestMessages >= messages, `${harness}: the transcript stays (${seen.fewestMessages} of ${messages} messages at the least)`)
  }
  assert.deepEqual(errors, [], "the page said nothing went wrong")
  console.log(`Fin view keeps: the crew card (${rows} rows) and the transcript stay through the composer's wake and ${steps.length} transitions on ${HARNESSES.length} harnesses`)
  app.exit(0)
}
