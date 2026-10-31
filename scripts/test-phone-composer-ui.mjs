import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The phone's live Session through its production pieces (`LiveSession`, the dock, the composer) on the mock bridge
 * (`src/dev/phone-composer-check.tsx`), at an iPhone's size with trusted touch input:
 *
 * - The mic held stops listening when the finger lifts; tapped, it listens on.
 * - Listening redraws nothing while no words arrive: the meter's samples don't render the composer.
 * - The Queue/Steer choice closes when it's no longer offered, and a later working turn doesn't open it again.
 * - An answer's words can be selected; a long press beside them still offers Copy and Branch.
 * - "Switched to" lines come from the Session's record, so a reload draws the same ones.
 * - The queue's actions, the steps line and the edit's Cancel are 44 px targets.
 * - The queue's count is said once, by the queue; a phone's transcript keeps no rail of turns, nor a gutter for one.
 *
 * Screenshots go to the printed directory, or to the directory given as the first argument; `--port` serves the page
 * on that port (default: any free one).
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void checkPhone().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
  const root = await mkdtemp(join(tmpdir(), "mako-phone-composer-ui-"))
  const evidence = args[0] ? resolve(args[0]) : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port, strictPort: port !== 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-phone-composer-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_PHONE_ROOT: root, MAKO_PHONE_EVIDENCE: evidence, MAKO_PHONE_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Phone composer UI evidence: ${evidence}`)
}

async function checkPhone() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_PHONE_ROOT
  const evidence = process.env.MAKO_PHONE_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 180_000)
  const window = new BrowserWindow({ width: 393, height: 852, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = (count = 2) => evaluate(`new Promise(resolve => { let left = ${count}; const step = () => --left > 0 ? requestAnimationFrame(step) : resolve(true); requestAnimationFrame(step) })`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (code, label = code) => {
    const deadline = Date.now() + 10_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`Timed out: ${label}`)
      }
      await wait(30)
    }
  }
  const capture = async (name) => {
    await frames(3)
    await evaluate("Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))), new Promise(done => setTimeout(done, 800))]).then(() => true)")
    await writeFile(join(evidence, name), (await page.capturePage()).toPNG())
  }
  const centre = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const box = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { width: r.width, height: r.height } })()`)
  const touch = (type, point) => page.debugger.sendCommand("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [] })
  /** A finger on `point` for `ms`, then lifted. */
  const press = async (point, ms) => {
    await touch("touchStart", point)
    await wait(ms)
    await touch("touchEnd")
    await frames(2)
  }
  /** Empties the composer's field, as deleting its words would. */
  const clear = async () => {
    await evaluate(`(() => { const field = document.querySelector('.web-composer-input'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(field, ''); field.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await until("document.querySelector('.web-composer-input').value === ''", "an empty field")
  }
  /** Back to the newest turn, as the way back does. */
  const toEnd = async () => {
    await evaluate("(() => { const scroller = document.querySelector('[aria-label=\"Conversation transcript\"]'); scroller.scrollTop = scroller.scrollHeight; return true })()")
    await wait(400)
  }
  const typeText = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const phone = async (theme) => {
    await window.loadURL(`${new URL("scripts/phone-composer.html", process.env.MAKO_PHONE_URL).href}?theme=${theme}`)
    await until("document.querySelectorAll('[data-answer]').length >= 3 && Boolean(document.querySelector('.web-composer-input'))", "the phone's transcript and composer")
    await evaluate("document.fonts.ready.then(() => true)")
  }

  // A page first: emulating a window that has drawn nothing yet crashes Electron.
  await window.loadURL("about:blank")
  await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 3, mobile: true })
  await page.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  try {
    await phone("dark")
    assert.equal(await evaluate("matchMedia('(pointer: coarse)').matches"), true, "the page reads as under a finger")

    // 1. "Switched to" lines from the record: the access and the model changed before the third turn.
    const switched = () => evaluate("[...document.querySelectorAll('[data-switched]')].map(node => node.textContent)")
    await until("document.querySelectorAll('[data-switched]').length >= 2", "the record's switch lines")
    const drawn = await switched()
    assert.ok(drawn.includes("Switched to Full access"), `the access switch is drawn: ${JSON.stringify(drawn)}`)
    assert.ok(drawn.some((words) => words.startsWith("Switched to") && /GPT-5.6 Sol/.test(words)), `the model switch is drawn: ${JSON.stringify(drawn)}`)
    console.log(`Switch lines from the record: ${drawn.join(", ")}`)

    // 2. An answer's words are the platform's to select; beside them, a long press offers Copy and Branch.
    assert.notEqual(await evaluate(`getComputedStyle([...document.querySelectorAll('[data-answer]')].at(-1)).userSelect`), "none", "an answer's words can be selected")
    const word = await evaluate(`(() => {
      const host = [...document.querySelectorAll('[data-answer]')].at(-1)
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const at = walker.currentNode.data.indexOf('backoff')
        if (at === -1) continue
        host.closest('[aria-label="Conversation transcript"]')?.scrollBy(0, 0)
        const range = document.createRange(); range.setStart(walker.currentNode, at + 1); range.setEnd(walker.currentNode, at + 2)
        const r = range.getClientRects()[0]
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      }
      throw new Error('No word to press')
    })()`)
    await press(word, 800)
    assert.equal(await evaluate("Boolean(document.querySelector('[data-reply-menu]'))"), false, "a long press on words doesn't open the reply's sheet")
    const beside = await evaluate(`(() => {
      const host = [...document.querySelectorAll('[data-answer]')].at(-1)
      const line = [...host.querySelectorAll('p')].find(node => node.textContent === 'What changed:')
      const r = line.getBoundingClientRect()
      const range = document.createRange(); range.selectNodeContents(line)
      const words = range.getBoundingClientRect()
      return { x: Math.round((words.right + r.right) / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    await press(beside, 800)
    await until("Boolean(document.querySelector('[data-reply-menu=\"copy\"]'))", "Copy offered by a long press beside the words")
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await until("!document.querySelector('[data-reply-menu]')", "the sheet closing")
    await evaluate(`(() => {
      const host = [...document.querySelectorAll('[data-answer]')].at(-1)
      const block = [...host.querySelectorAll('p')].find(node => node.textContent.startsWith('The retry fix holds'))
      block.scrollIntoView({ block: 'center' })
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      const nodes = []
      while (walker.nextNode()) nodes.push(walker.currentNode)
      const first = nodes[0], last = nodes.at(-1)
      const start = first.data.indexOf('The backoff')
      getSelection().setBaseAndExtent(first, start, last, last.data.indexOf('gets six tries') + 'gets six tries'.length)
      return true
    })()`)
    assert.match(await evaluate("getSelection().toString()"), /^The backoff now doubles/)
    await capture("answer-selected-iphone-dark.png")
    await evaluate("getSelection().removeAllRanges(), true")
    console.log("Answers: words selectable, Copy and Branch beside them")

    // 3. The mic: held, it stops when the finger lifts; tapped, it listens on.
    const mic = '[aria-label="Dictate"]'
    await press(await centre(mic), 600)
    await until("!window.phoneCheck.listening() && !document.querySelector('[aria-label=\"Dictating\"]')", "push-to-talk ending on release")
    await press(await centre(mic), 60)
    await frames(4)
    assert.equal(await evaluate("window.phoneCheck.listening()"), true, "a tap keeps listening")

    // 4. Listening with nothing heard renders nothing: the meter samples every 80 ms without React.
    await wait(300)
    await evaluate("window.phoneCheck.renders.composer = 0, true")
    await wait(1_000)
    const renders = await evaluate("window.phoneCheck.renders.composer")
    assert.ok(renders <= 2, `a second of listening rendered the phone ${renders} times`)
    await evaluate("window.phoneCheck.say('check the webhook retries')")
    await frames(3)
    await capture("composer-dictating-iphone-dark.png")
    await press(await centre('[aria-label="Stop dictating"]'), 40)
    await until("!document.querySelector('[aria-label=\"Dictating\"]') && document.querySelector('.web-composer-input').value.includes('webhook')", "dictation stopped, its words in the field")
    await clear()
    console.log(`Mic: release stops a hold, a tap listens on; ${renders} renders in a second of listening`)

    // 5. Queue/Steer: closed when no longer offered, and not opened again by the next working turn.
    await evaluate("window.phoneCheck.setRunning(true), true")
    await until("document.querySelector('[data-send-action]')?.getAttribute('data-send-action') === 'stop'", "Stop while the agent works")
    await toEnd()
    await capture("composer-working-iphone-dark.png")
    await evaluate("document.querySelector('.web-composer-input').focus(), true")
    await typeText("Then update the changelog")
    await until("['queue', 'steer'].includes(document.querySelector('[data-send-action]')?.getAttribute('data-send-action'))", "the Queue or Steer pill")
    const pill = await centre("[data-send-action]")
    await touch("touchStart", pill)
    await until("Boolean(document.querySelector('[role=\"menu\"]'))", "both ways offered by a hold")
    await touch("touchEnd")
    await evaluate("window.phoneCheck.setRunning(false), true")
    await until("!document.querySelector('[role=\"menu\"]')", "the choice closing with the turn")
    await evaluate("window.phoneCheck.setRunning(true), true")
    await evaluate("document.querySelector('.web-composer-input').focus(), true")
    await typeText(" now")
    await frames(4)
    assert.equal(await evaluate("Boolean(document.querySelector('[role=\"menu\"]'))"), false, "the next working turn doesn't open the choice")
    assert.equal(await evaluate("document.activeElement === document.querySelector('.web-composer-input')"), true, "the field keeps the keys")
    console.log("Queue/Steer: closed with the turn, not reopened")

    // 6. A queued message, its actions a thumb's size; the steps line too.
    await clear()
    await evaluate("document.querySelector('.web-composer-input').blur(), true")
    await evaluate("window.phoneCheck.queue('Then update the changelog with the new backoff'), true")
    await until("Boolean(document.querySelector('[data-queued-action=\"edit\"]'))", "the queued row")
    await toEnd()
    for (const action of ["edit", "remove"]) {
      const size = await box(`[data-queued-action="${action}"]`)
      assert.ok(size.width >= 44 && size.height >= 44, `the queued row's ${action} is ${size.width}×${size.height}`)
    }
    // The steps line reads 36 px tall and takes its touch 4 px above and below it.
    const reach = await evaluate(`(() => { const line = document.querySelector('[data-steps-line]'); line.scrollIntoView({ block: 'center' }); const r = line.getBoundingClientRect(); const x = r.left + 8; return [r.top - 3, r.bottom + 3].every(y => line.contains(document.elementFromPoint(x, y))) })()`)
    assert.ok(reach, "the steps line takes a touch 44 px tall")
    await toEnd()
    // The queue says what's queued once, in its own panel; the transcript has the screen's width, no rail of turns.
    assert.equal(await evaluate("document.querySelector('.web-capsule')?.textContent.includes('queued') ?? false"), false, "the capsule doesn't repeat the queue's count")
    assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=\"Previous prompts\"]'))"), false, "a phone's width keeps no turn rail")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[aria-label=\"Conversation transcript\"]')).paddingInlineEnd"), "0px", "nor a gutter for one")
    await capture("composer-queued-iphone-dark.png")
    console.log("Targets: queued edit and remove, the steps line, 44 px")

    // 7. A reload draws the same switch lines: they are the record's, not this page's memory.
    page.reload()
    await until("document.readyState === 'complete' && document.querySelectorAll('[data-switched]').length >= 2", "the reloaded page's switch lines")
    assert.deepEqual(await switched(), drawn, "reloaded, the same switch lines")
    console.log("Reload: the same switch lines")

    await phone("light")
    await capture("answer-iphone-light.png")
  } finally {
    clearTimeout(watchdog)
  }
}
