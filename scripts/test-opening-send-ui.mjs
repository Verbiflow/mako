import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"

// Sending to a conversation while it opens, against the mock bridge's kept
// scene (`?mock&app=kept`) with its page reads held by the check. A
// conversation painted from the last read takes Enter at once while its
// fresh read is still under way; one with nothing on screen yet turns the
// send button and Enter says nothing; a read that failed says so once, with
// its reason and Retry, however often Enter is pressed, and nothing else
// says it; a cached conversation whose refresh fails keeps its saved
// messages, a quiet line and its send; a session only Mako's
// copy keeps, routed by the window, sends once its fresh read lands, the
// button turning meanwhile. Writes a screenshot of each.
//
//   node scripts/test-opening-send-ui.mjs [out]
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = process.argv[2] ?? await mkdtemp(join(tmpdir(), "mako-opening-send-ui-"))
  await mkdir(root, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, watch: null, fs: { strict: false } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-opening-send-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_OPENING_CHECK_ROOT: root, MAKO_OPENING_CHECK_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(electronExit("The opening send UI check", code, signal)))
    })
  } finally {
    await server.close()
  }
  console.log(`Opening send UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_OPENING_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const guard = guardElectronCheck({ app, page: window.webContents, name: "The opening send UI check", ms: 150_000 })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))")
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const until = async (code, what = code, ms = 15_000) => {
    guard.at(what)
    const end = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png")
        throw new Error(`Timed out: ${what}`)
      }
      await pause(25)
    }
  }
  const field = "[data-composer] textarea"
  const type = async (text) => {
    await evaluate(`document.querySelector(${JSON.stringify(field)}).focus(); true`)
    await page.debugger.sendCommand("Input.insertText", { text })
  }
  const enter = async () => {
    for (const type of ["keyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
    await pause(60)
  }
  /** Notices that a send was held: "Wait for this conversation to load", or a failed read's. */
  const said = (words) => evaluate(`[...document.querySelectorAll('[data-sonner-toast]')].filter((toast) => toast.textContent.includes(${JSON.stringify(words)})).length`)
  const held = () => evaluate(`[...document.querySelectorAll('[data-sonner-toast]')].filter((toast) => /conversation to load|Your draft is saved/.test(toast.textContent)).length`)
  const sendButton = () => evaluate("(() => { const button = document.querySelector('[data-composer] button.composer-send'); return button && { label: button.getAttribute('aria-label'), busy: button.getAttribute('aria-busy'), disabled: button.disabled } })()")
  const view = (path) => evaluate(`import('/src/state/threads.ts').then(({ threads, threadsStore }) => { void threads.view(threadsStore.get().threads.find((ref) => ref.path === ${JSON.stringify(path)})); return true })`)
  const settled = (path) => `(async () => { const { threadsStore } = await import('/src/state/threads.ts'); const state = threadsStore.get(); return state.opening === null && state.viewing?.ref.path === ${JSON.stringify(path)} })()`
  const cached = "/mock/claude.jsonl"
  const other = "/mock/claude-2.jsonl"
  const fresh = "/mock/codex.jsonl"
  const copy = "/mock/claude-kept-copy.jsonl"

  try {
    await window.loadURL(`${process.env.MAKO_OPENING_CHECK_URL}?mock&app=kept`)
    await until(`Boolean(document.querySelector(${JSON.stringify(field)}))`, "the composer")
    await until(`(async () => { const { threadsStore } = await import('/src/state/threads.ts'); return threadsStore.get().threads.some((ref) => ref.path === ${JSON.stringify(fresh)}) })()`, "the catalog")
    // Page reads of a held path wait for the check; a send is recorded where it went.
    await evaluate(`(() => {
      const bridge = window.mako
      const read = bridge.pageThread.bind(bridge)
      window.heldReads = new Set()
      window.waitingReads = []
      bridge.pageThread = (path, ...rest) => window.heldReads.has(path)
        ? new Promise((resolve, reject) => window.waitingReads.push({ path, release: () => read(path, ...rest).then(resolve, reject), fail: () => reject(new Error("The host stopped answering")) }))
        : read(path, ...rest)
      window.sent = []
      window.captured = []
      const liveCapture = bridge.liveCapture.bind(bridge)
      bridge.liveCapture = (id, path) => { window.captured.push(path); return liveCapture(id, path) }
      bridge.resolveContinuation = async (path) => ({ transport: "native", provider: "claude" })
      bridge.nativeSubmit = async (input) => { window.sent.push({ path: input.path, text: input.text }); return { input, ref: { harness: "claude", nativeId: "sent", path: input.path }, status: "completed" } }
      return true
    })()`)

    // Read once, so the next open paints from the cache.
    await view(cached)
    await until(settled(cached), "the first read of the cached conversation")
    await view(other)
    await until(settled(other), "another conversation")

    // Painted from the cache, its fresh read held: Enter sends to it now.
    await evaluate(`window.heldReads.add(${JSON.stringify(cached)}); true`)
    await view(cached)
    await until(`(async () => { const { threadsStore } = await import('/src/state/threads.ts'); const state = threadsStore.get(); return state.opening?.kind === 'loading' && state.viewing?.ref.path === ${JSON.stringify(cached)} && window.waitingReads.length === 1 })()`, "the cached paint with its fresh read under way")
    await type("Ship it with the regression test")
    assert.equal((await sendButton())?.label, "Send", "the send button offers to send while the fresh read lands")
    await capture("cached-refreshing.png")
    await enter()
    await until(`window.sent.some((send) => send.path === ${JSON.stringify(cached)} && send.text.includes("Ship it with the regression test"))`, "the send to the conversation on screen")
    assert.equal(await held(), 0, "no notice to wait")
    await evaluate(`window.heldReads.delete(${JSON.stringify(cached)}); window.waitingReads.splice(0).forEach((read) => read.release()); true`)
    await until(settled(cached), "the fresh read landing after the send")

    // Nothing on screen yet: the send button turns and Enter adds no notice.
    await evaluate(`window.heldReads.add(${JSON.stringify(fresh)}); true`)
    await view(fresh)
    await until(`window.waitingReads.some((read) => read.path === ${JSON.stringify(fresh)})`, "the uncached read under way")
    await type("Look at the retry budget")
    for (let press = 0; press < 3; press++) await enter()
    const loading = await sendButton()
    assert.deepEqual(loading, { label: "Loading this conversation…", busy: "true", disabled: true }, "the send button says what it waits on")
    assert.equal(await held(), 0, "Enter while it loads adds no notice")
    assert.equal(await evaluate(`window.sent.filter((send) => send.path === ${JSON.stringify(fresh)}).length`), 0, "and sends nothing anywhere")
    await capture("loading.png")

    // Its read fails: the viewer says so, and nothing else does until Enter, which says so once, with the reason and Retry.
    await evaluate("window.waitingReads.splice(0).forEach((read) => read.fail()); true")
    await until("document.body.textContent.includes('Could not load this conversation')", "the viewer's error")
    await pause(400)
    assert.equal(await said("The host stopped answering"), 0, "the viewer's error is the one place a failed open is said")
    for (let press = 0; press < 3; press++) await enter()
    await until(`[...document.querySelectorAll('[data-sonner-toast]')].some((toast) => toast.textContent.includes("Your draft is saved"))`, "the notice")
    await pause(400)
    assert.equal(await held(), 1, "one notice, however often Enter is pressed")
    assert.equal(await said("The host stopped answering"), 1, "and nothing stacked under it")
    const notice = await evaluate("[...document.querySelectorAll('[data-sonner-toast]')].find((toast) => toast.textContent.includes('Your draft is saved')).textContent")
    assert.match(notice, /^Could not load this conversation/, "in the viewer's words")
    assert.match(notice, /The host stopped answering\. Your draft is saved\./, "it says why, and that the draft is kept")
    assert.doesNotMatch(notice, /Wait for this conversation to load/, "a failed read is not called loading")
    assert.match(notice, /Retry loading/, "it offers Retry")
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(field)}).value`), "Look at the retry budget", "the draft stays in the composer")
    await capture("failed.png")

    // Retry from the notice reads it again; the draft then sends.
    await evaluate(`window.heldReads.delete(${JSON.stringify(fresh)}); [...document.querySelectorAll('[data-sonner-toast] button')].find((button) => button.textContent === 'Retry loading').click(); true`)
    await until(settled(fresh), "the retried read")
    await enter()
    await until(`window.sent.some((send) => send.path === ${JSON.stringify(fresh)} && send.text.includes("Look at the retry budget"))`, "the send after Retry")

    // A cached conversation whose refresh fails keeps its saved messages on screen, says so in one quiet line, and takes a send.
    await view(other)
    await until(settled(other), "another conversation before the failed refresh")
    await evaluate(`window.heldReads.add(${JSON.stringify(cached)}); true`)
    await view(cached)
    await until(`window.waitingReads.some((read) => read.path === ${JSON.stringify(cached)})`, "the cached conversation's refresh under way")
    await evaluate("window.waitingReads.splice(0).forEach((read) => read.fail()); true")
    await until("Boolean(document.querySelector('[data-refresh-failed]'))", "the refresh's quiet line")
    assert.match(await evaluate("document.querySelector('[data-refresh-failed]').textContent"), /^Couldn't refresh·Retry$/)
    assert.equal(await evaluate("document.body.textContent.includes('Could not load this conversation')"), false, "the saved messages are not swapped for the error")
    assert.equal(await evaluate("document.body.textContent.includes('Ship it with the regression test')"), true, "they stay on screen")
    await pause(400)
    assert.equal(await said("The host stopped answering"), 0, "no notice says it")
    assert.equal(await said("Could not refresh"), 0)
    await type("Send it anyway")
    assert.equal((await sendButton())?.label, "Send", "the send button offers to send")
    await capture("refresh-failed.png")
    await enter()
    await until(`window.sent.some((send) => send.path === ${JSON.stringify(cached)} && send.text.includes("Send it anyway"))`, "the send to the saved messages")
    assert.equal(await held(), 0, "with no notice")
    await evaluate(`window.heldReads.delete(${JSON.stringify(cached)}); document.querySelector('[data-refresh-failed] button').click(); true`)
    await until(settled(cached), "Retry on the quiet line")
    assert.equal(await evaluate("Boolean(document.querySelector('[data-refresh-failed]'))"), false, "and the line goes once it has refreshed")

    // Mako's copy goes on from its transcript, a route the window picks from the ref: the send waits for the fresh read, on the button.
    await view(copy)
    await until(settled(copy), "the first read of the kept copy")
    await view(other)
    await until(settled(other), "another conversation again")
    await evaluate(`window.heldReads.add(${JSON.stringify(copy)}); true`)
    await view(copy)
    await until(`(async () => { const { threadsStore } = await import('/src/state/threads.ts'); const state = threadsStore.get(); return state.opening?.kind === 'loading' && state.viewing?.ref.path === ${JSON.stringify(copy)} && window.waitingReads.some((read) => read.path === ${JSON.stringify(copy)}) })()`, "the kept copy painted with its fresh read under way")
    await type("Carry on from the transcript")
    await enter()
    await until(`document.querySelector('[data-composer] button.composer-send')?.getAttribute('aria-label') === "Sending once this conversation has loaded…"`, "the send waiting on the button")
    assert.equal((await sendButton()).busy, "true")
    assert.equal(await evaluate("window.captured.length"), 0, "nothing goes before the read says where")
    assert.equal(await held(), 0, "and no notice says it waits")
    await capture("confirming.png")
    await evaluate(`window.heldReads.delete(${JSON.stringify(copy)}); window.waitingReads.splice(0).forEach((read) => read.release()); true`)
    await until(`window.captured.includes(${JSON.stringify(copy)})`, "the kept copy's send once its read landed")

    console.log("✓ a conversation on screen takes a send while it refreshes; with nothing on screen the send button waits and Enter adds no notice; a failed open says why once, with Retry; a failed refresh keeps the saved messages and their send; a window-routed send waits for the fresh read on the button")
    guard.done()
    app.exit(0)
  } catch (error) {
    console.error(error)
    await capture("failure.png").catch(() => {})
    guard.done()
    app.exit(1)
  }
}
