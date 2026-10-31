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
 * - The model, its effort and the access are one chip ("GPT-5.6 Sol · High", a caution mark under Full access) opening
 *   one sheet: the harness's models, the chosen one's effort levels and nothing for a model without, the access as its
 *   last row. A choice made there goes with the next message; an access change the owner refuses says why. A flick
 *   down closes it.
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
  /** Every finite animation on the page finished, or 800 ms gone. */
  const settled = async () => {
    await frames(3)
    await evaluate("Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))), new Promise(done => setTimeout(done, 800))]).then(() => true)")
  }
  const capture = async (name) => {
    await settled()
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
  const phone = async (theme, scene = "") => {
    // Each page starts from the fixture's own record: no choice kept by the one before.
    if ((await evaluate("location.protocol")) === "http:") await evaluate("localStorage.clear(), true")
    await window.loadURL(`${new URL("scripts/phone-composer.html", process.env.MAKO_PHONE_URL).href}?theme=${theme}${scene}`)
    await until("document.querySelectorAll('[data-answer]').length >= 3 && Boolean(document.querySelector('.web-composer-input'))", "the phone's transcript and composer")
    await evaluate("document.fonts.ready.then(() => true)")
  }

  const sheet = '[role="dialog"][aria-label="Model and access"]'
  /** The chip as it reads: the model, its effort suffix, and whether it carries the caution mark. */
  const chip = () => evaluate(`(() => {
    const chip = document.querySelector('[data-thread-chip="settings"]')
    const words = chip.querySelector('.truncate')
    return { model: words.textContent, effort: chip.querySelector('.web-settings-chip-effort')?.textContent ?? null, risky: Boolean(chip.querySelector('[data-risky-mark]')), cut: words.scrollWidth > words.clientWidth, spoken: chip.getAttribute('aria-label') }
  })()`)
  /** The effort levels the sheet offers, and the one chosen. */
  const efforts = () => evaluate(`(() => {
    const row = document.querySelector('${sheet} [data-effort]')
    if (!row) return null
    return { kind: row.dataset.effort, values: [...row.querySelectorAll('[role="radio"]')].map(node => node.dataset.value), chosen: row.querySelector('[aria-checked="true"]')?.dataset.value ?? null, note: row.querySelector('.web-settings-effort-note')?.textContent ?? null }
  })()`)
  /** A tap on what `selector` names, once what's moving has come to rest, as a finger would aim. */
  const tap = async (selector) => {
    await settled()
    await press(await centre(selector), 40)
  }
  const openSheet = async () => {
    await tap('[data-thread-chip="settings"]')
    await until(`Boolean(document.querySelector('${sheet}'))`, "the settings sheet")
    await settled()
  }
  /** A finger flicked down from the sheet's top: 240 px in about 80 ms. */
  const flickDown = async () => {
    await settled()
    const from = await centre(`${sheet} .web-settings-head`)
    await touch("touchStart", from)
    for (let step = 1; step <= 6; step += 1) {
      await wait(14)
      await touch("touchMove", { x: from.x, y: from.y + step * 40 })
    }
    await touch("touchEnd")
    await until(`!document.querySelector('${sheet}')`, "the sheet closing on a flick")
  }

  /** The one chip and its sheet, on Codex (every model with effort) and on Grok (ending on a model without). */
  const checkSettings = async () => {
    // The bar keeps what a thumb needs: add, the one chip, the mic and send.
    await phone("dark", "&mode=before")
    const bar = await evaluate("[...document.querySelector('.web-composer-bar').querySelectorAll('button')].filter(node => node.offsetParent).map(node => node.dataset.threadChip ? 'chip' : node.dataset.sendAction ? 'send' : node.getAttribute('aria-label'))")
    assert.deepEqual(bar, ["Add photos or files", "chip", "Dictate", "send"], `the composer's bar: ${JSON.stringify(bar)}`)
    let read = await chip()
    assert.deepEqual([read.model, read.effort, read.risky, read.cut], ["GPT-5.6 Sol", "· High", false, false], `the chip reads the model and its effort, whole: ${JSON.stringify(read)}`)
    assert.equal(read.spoken, "Model and access: GPT-5.6 Sol, High reasoning, Ask before acting")
    const reach = await evaluate(`(() => { const chip = document.querySelector('[data-thread-chip="settings"]'); const r = chip.getBoundingClientRect(); const x = r.left + r.width / 2; return [r.top - 3, r.bottom + 3].every(y => chip.contains(document.elementFromPoint(x, y))) })()`)
    assert.ok(reach, "the chip takes a touch 44 px tall")
    await evaluate("document.activeElement?.blur(), true")
    await capture("composer-iphone-dark.png")

    await phone("dark")
    read = await chip()
    assert.deepEqual([read.model, read.effort, read.risky], ["GPT-5.6 Sol", "· High", true], `under Full access the chip carries the caution mark: ${JSON.stringify(read)}`)
    await evaluate("document.activeElement?.blur(), true")
    await capture("composer-full-access-iphone-dark.png")

    // The sheet: Codex's models, the chosen one's levels, the access as its last row.
    await openSheet()
    assert.deepEqual(await efforts(), { kind: "choose", values: ["low", "medium", "high", "xhigh", "max", "ultra"], chosen: "high", note: null }, "GPT-5.6 Sol's levels")
    assert.equal(await evaluate(`document.querySelector('${sheet} [aria-checked="true"][data-model]')?.dataset.model`), "gpt-5.6-sol")
    for (const target of ['[data-model]', '[data-effort] [role="radiogroup"]', '[data-access-row]']) {
      const size = await box(`${sheet} ${target}`)
      assert.ok(size.height >= 44, `${target} is ${size.height} px tall`)
    }
    // A segment takes a touch anywhere on the track's height, its inset around the thumb included.
    const segmentReach = await evaluate(`(() => { const track = document.querySelector('${sheet} [data-effort] [role="radiogroup"]'); const r = track.getBoundingClientRect(); const segment = track.querySelector('[data-value="low"]').getBoundingClientRect(); const x = segment.left + segment.width / 2; return [r.top + 1, r.bottom - 1].every(y => document.elementFromPoint(x, y)?.dataset.value === 'low') })()`)
    assert.ok(segmentReach, "an effort segment takes a touch the track's full 44 px")
    await capture("sheet-iphone-dark.png")

    // Another model: its own levels, at once, and the chip follows; then a level of its own.
    await tap(`${sheet} [data-model="gpt-5.6-luna"]`)
    await until(`document.querySelector('${sheet} [data-effort] [role="radio"]:last-child')?.dataset.value === 'medium'`, "GPT-5.6 Luna's levels")
    assert.deepEqual((await efforts()).values, ["low", "medium"], "only the levels GPT-5.6 Luna offers")
    await tap(`${sheet} [data-effort] [data-value="medium"]`)
    await until(`document.querySelector('${sheet} [data-effort] [aria-checked="true"]')?.dataset.value === 'medium'`, "Medium chosen")
    read = await chip()
    assert.deepEqual([read.model, read.effort], ["GPT-5.6 Luna", "· Medium"], `the chip follows the sheet: ${JSON.stringify(read)}`)

    // The access: one row saying what it allows; tapped, the other levels open under it.
    assert.match(await evaluate(`document.querySelector('${sheet} [data-access-row]').textContent`), /Full access.*Nothing waits for approval/)
    await tap(`${sheet} [data-access-row]`)
    await until(`document.querySelector('${sheet} [data-access-row]').getAttribute('aria-expanded') === 'true'`, "the access opened")
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${sheet} [data-access-mode]')].map(node => node.dataset.accessMode)`), ["read-only", "auto"])
    await capture("sheet-access-iphone-dark.png")
    await tap(`${sheet} [data-access-mode="auto"]`)
    await until("!document.querySelector('[data-thread-chip=\"settings\"] [data-risky-mark]')", "the caution mark gone with Full access")
    assert.match(await evaluate(`document.querySelector('${sheet} [data-access-row]').textContent`), /^Ask before acting/)

    // Refused by the owner, the access stays where the Session is and says why.
    await evaluate("window.phoneCheck.refuseAccess('This session keeps the access it started with.'), true")
    await tap(`${sheet} [data-access-row]`)
    await until(`document.querySelector('${sheet} [data-access-row]').getAttribute('aria-expanded') === 'true'`, "the access opened again")
    await tap(`${sheet} [data-access-mode="full-access"]`)
    await until("[...document.querySelectorAll('[data-sonner-toast]')].some(node => node.textContent.includes('Not switched to Full access') && node.textContent.includes('keeps the access it started with'))", "the refusal, saying why")
    assert.equal((await chip()).risky, false, "a refused change leaves the chip where the Session is")
    await evaluate("window.phoneCheck.refuseAccess(undefined), true")

    // A flick down closes it; the next message goes with what was chosen.
    await flickDown()
    await evaluate("document.querySelector('.web-composer-input').focus(), true")
    await typeText("Then tidy the retry names")
    await tap('[data-send-action="send"]')
    await until("window.phoneCheck.sent.length === 1", "the next message sent")
    const [message] = await evaluate("window.phoneCheck.sent")
    assert.deepEqual([message.tuning?.model, message.tuning?.options?.effort], ["gpt-5.6-luna", "medium"], `the next message goes with the sheet's choice: ${JSON.stringify(message)}`)
    console.log(`Settings: one chip (${read.model} ${read.effort}), the levels each model offers, sent with the next message`)

    // Grok, its last model without effort: no suffix, and the sheet says so where the levels were.
    await phone("dark", "&harness=grok")
    read = await chip()
    assert.deepEqual([read.model, read.effort, read.risky], ["Grok 4.6", null, false], `a model without effort reads as itself: ${JSON.stringify(read)}`)
    await openSheet()
    assert.deepEqual(await efforts(), { kind: "absent", values: [], chosen: null, note: "Grok 4.6 has no effort setting" })
    await capture("no-effort-iphone-dark.png")
    await tap(`${sheet} [data-model="grok-4.7"]`)
    await until(`document.querySelector('${sheet} [data-effort]')?.dataset.effort === 'choose'`, "Grok 4.7's levels")
    assert.deepEqual((await efforts()).values, ["low", "high"], "only the levels Grok 4.7 offers")
    console.log("Settings: a model without effort has no control and no suffix")

    // The same four, light.
    await phone("light", "&mode=before")
    await evaluate("document.activeElement?.blur(), true")
    await capture("composer-iphone-light.png")
    await phone("light")
    await evaluate("document.activeElement?.blur(), true")
    await capture("composer-full-access-iphone-light.png")
    await openSheet()
    await capture("sheet-iphone-light.png")
    await tap(`${sheet} [data-access-row]`)
    await until(`document.querySelector('${sheet} [data-access-row]').getAttribute('aria-expanded') === 'true'`, "the access opened")
    await capture("sheet-access-iphone-light.png")
    await phone("light", "&harness=grok")
    await openSheet()
    await capture("no-effort-iphone-light.png")
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

    await checkSettings()
  } finally {
    clearTimeout(watchdog)
  }
}
