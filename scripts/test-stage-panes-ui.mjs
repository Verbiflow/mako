import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

// No pane is ever left blank on the desk's stage, and when the stage is laid out wrong the desk says so itself. On the
// mock bridge's Apex scene at a 1352 × 847 window (the size a person saw the transcript squeezed into the top of the
// window above an empty half, 2026-11-11):
// - a split whose second pane holds a document that's gone, or nothing, closes that pane: the chat fills the
//   workbench and its composer sits at the bottom;
// - a chat pane beside the focused one whose Session is gone from its listed Thread closes; one whose Thread this
//   window doesn't list says so with Close, which closes it;
// - a reload whose saved second pane names a Session that's gone comes back as one pane;
// - a layout that stays off (here a squeezed chat) is logged once as `Stage layout off` with the window's size and
//   each pane's, and a right one never is.
// Screenshots land in the printed folder (or `MAKO_STAGE_PANES_SHOTS`).
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-stage-panes-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-stage-panes-ui", main: fileURLToPath(import.meta.url) }))
  const { createServer } = await import("vite")
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  const env = { ...process.env, MAKO_STAGE_PANES_ROOT: root, MAKO_STAGE_PANES_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Stage panes UI evidence: ${process.env.MAKO_STAGE_PANES_SHOTS ?? join(root, "shots")}`)
}

const APEX_THREAD = "1ead1ead-0000-4000-8000-000000001ead"

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_STAGE_PANES_ROOT
  const shots = process.env.MAKO_STAGE_PANES_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
  await app.whenReady()
  const base = process.env.MAKO_STAGE_PANES_URL
  const window = new BrowserWindow({ width: 1352, height: 847, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
  atSize(window, 1352, 847)
  const page = window.webContents
  const errors = []
  const warnings = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message)
    if (event.level === "warning") warnings.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, what = code, ms = 20_000) => {
    const deadline = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await writeFile(join(shots, "failure.png"), (await page.capturePage()).toPNG())
        throw new Error(`Timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
      }
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  const shoot = async (name) => writeFile(join(shots, `${name}.png`), (await page.capturePage()).toPNG())
  /** The workbench as laid out: its panes, and how far the composer sits above the bottom of the pane holding it. */
  const LAYOUT = `(() => {
    const first = document.querySelector('.workbench-pane')
    const bench = (first.closest('[data-workbench]') ?? first.parentElement.parentElement).getBoundingClientRect()
    const panes = [...document.querySelectorAll('.workbench-pane')].map((pane) => { const box = pane.getBoundingClientRect(); const composer = pane.querySelector('[data-composer]')?.getBoundingClientRect(); return { height: Math.round(box.height), composerGap: composer ? Math.round(box.bottom - composer.bottom) : null } })
    return { bench: Math.round(bench.height), panes }
  })()`
  const filled = async (what) => {
    const layout = await evaluate(LAYOUT)
    assert.equal(layout.panes.length, 1, `${what}: one pane is left: ${JSON.stringify(layout)}`)
    assert.ok(layout.panes[0].height >= layout.bench - 2, `${what}: the pane fills the workbench: ${JSON.stringify(layout)}`)
    assert.ok(layout.panes[0].composerGap !== null && layout.panes[0].composerGap <= 4, `${what}: the composer sits at the bottom: ${JSON.stringify(layout)}`)
  }
  const viewer = "import('/src/state/viewer.ts')"
  const panes = `${viewer}.then(({ viewerStore }) => viewerStore.get().panes.length)`

  const open = async () => {
    await window.loadURL(`${base}?mock&app=apex`)
    await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.querySelector('[data-fin-pips]'))", "the rail")
    await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')).click(); true")
    await until("Boolean(document.querySelector('[data-composer]'))", "the Apex's composer")
    await until("Boolean(document.querySelector('[data-transcript-viewport] [data-exchange]'))", "its transcript")
  }
  await open()
  await filled("the Apex opened")

  // 1. A split whose second pane holds a document that's gone, or nothing at all: written straight to the store, as a
  // restore or a race would, it never reaches the screen.
  for (const [what, second] of [["a gone document", { id: "pane-stale", tabIds: ["viewer-gone"], activeId: "viewer-gone" }], ["nothing", { id: "pane-empty", tabIds: [] }]]) {
    await evaluate(`${viewer}.then(({ viewerStore }) => { const state = viewerStore.get(); viewerStore.set({ panes: [...state.panes, ${JSON.stringify(second)}], split: "down" }); return true })`)
    await until(`${panes}.then((count) => count === 1)`, `the pane holding ${what} closing`)
    await new Promise((done) => setTimeout(done, 300))
    await filled(`a second pane holding ${what}`)
    console.log(`PASS: a second pane holding ${what} closes, and the chat fills the stage with its composer at the bottom`)
  }
  await shoot("after-gone-pane")

  // 2. A chat pane beside the focused one whose Session is gone from its Thread (closed, archived or moved) closes.
  await evaluate(`${viewer}.then(({ viewer }) => viewer.openAgentPane("down", { thread: ${JSON.stringify(APEX_THREAD)}, tab: "a-session-that-moved" }) !== null)`)
  await until(`${panes}.then((count) => count === 1)`, "the pane of a gone Session closing")
  await new Promise((done) => setTimeout(done, 300))
  await filled("a chat pane whose Session is gone")
  console.log("PASS: a chat pane whose Session left its Thread closes")

  // 3. One whose Thread this window doesn't list (a Fin's, or one not read yet) proves nothing: it stays, says so, and
  // Close closes it.
  await evaluate(`${viewer}.then(({ viewer }) => viewer.openAgentPane("down", { thread: "unlisted-thread", tab: "unlisted-tab" }) !== null)`)
  await until("Boolean(document.querySelector('[data-pane-notice=missing]'))", "the unknown Session's notice")
  const notice = await evaluate("document.querySelector('[data-pane-notice=missing]').innerText.replace(/\\s+/g, ' ')")
  assert.match(notice, /Close pane/, `the notice offers Close: ${notice}`)
  await shoot("unknown-session-pane")
  await evaluate("[...document.querySelectorAll('[data-pane-notice=missing] button')].find((button) => button.innerText.trim() === 'Close pane').click(); true")
  await until(`${panes}.then((count) => count === 1)`, "Close closing the pane")
  await new Promise((done) => setTimeout(done, 300))
  await filled("after Close")
  console.log("PASS: a pane whose Thread isn't listed says so with Close, and Close closes it")

  // 4. A reload whose saved second pane names a Session that's gone comes back as one pane.
  await evaluate(`sessionStorage.setItem("mako:chat-panes", JSON.stringify({ resting: { split: "down", first: false, session: { thread: ${JSON.stringify(APEX_THREAD)}, tab: "a-session-that-moved" } } })); true`)
  await open()
  await new Promise((done) => setTimeout(done, 1500))
  await filled("after a reload naming a gone Session")
  console.log("PASS: a reload naming a gone Session comes back as one pane")

  // 5. The desk says itself when its stage stays laid out wrong, once, with what it measured; never when it's right.
  assert.deepEqual(warnings.filter((message) => message.startsWith("Stage layout off")), [], "nothing was off so far, and nothing was said")
  await evaluate("(() => { const style = document.createElement('style'); style.id = 'squeeze'; style.textContent = '.agent-surface { flex: 0 0 300px !important; }'; document.head.append(style); return true })()")
  const deadline = Date.now() + 10_000
  while (!warnings.some((message) => message.startsWith("Stage layout off")) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200))
  await shoot("squeezed")
  const said = warnings.filter((message) => message.startsWith("Stage layout off"))
  assert.equal(said.length, 1, `a squeezed stage is said once: ${JSON.stringify(said)}`)
  const reading = JSON.parse(said[0].slice("Stage layout off ".length))
  assert.deepEqual(reading.window, await evaluate("({ width: innerWidth, height: innerHeight })"), "it says the window's size")
  assert.ok(reading.panes.length === 1 && reading.panes[0].composerGap > 48 && reading.why.some((why) => why.includes("composer")), `it says the composer is above its pane's bottom: ${said[0]}`)
  await new Promise((done) => setTimeout(done, 4_500))
  assert.equal(warnings.filter((message) => message.startsWith("Stage layout off")).length, 1, "and not again while nothing changes")
  console.log(`PASS: a squeezed stage is logged once: ${said[0].slice(0, 220)}…`)

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [])
  console.log("Stage panes UI: passed")
  app.exit(0)
}
