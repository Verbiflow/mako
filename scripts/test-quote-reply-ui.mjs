import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Quoting an earlier reply, through production components (`AcpPanel`, the
 * `transcript.overlay` slot the desk's builtins fill, `Composer`, the command
 * palette and the desk's one key listener) with trusted CDP input: a mouse
 * drag selects, the floating button or the chord or the palette quotes, and
 * the `mako:add-context` event's detail is what is checked. No host and no
 * agent are involved. Screenshots go to the printed directory, or to the
 * directory given as the first argument.
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void checkQuotes().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-quote-reply-ui-"))
  const evidence = process.argv[2] ? resolve(process.argv[2]) : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-quote-reply-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_QUOTE_ROOT: root, MAKO_QUOTE_EVIDENCE: evidence, MAKO_QUOTE_URL: server.resolvedUrls.local[0] }
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
  console.log(`Quote reply UI evidence: ${evidence}`)
}

async function checkQuotes() {
  const { app, BrowserWindow, clipboard } = await import("electron")
  const root = process.env.MAKO_QUOTE_ROOT
  const evidence = process.env.MAKO_QUOTE_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const saved = { text: clipboard.readText(), html: clipboard.readHTML() }
  const watchdog = setTimeout(() => app.exit(1), 120_000)
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, label = code) => {
    const deadline = Date.now() + 10_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`Timed out: ${label}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  const frames = (count = 2) => evaluate(`new Promise(resolve => { let left = ${count}; const step = () => --left > 0 ? requestAnimationFrame(step) : resolve(true); requestAnimationFrame(step) })`)
  const capture = async (name) => {
    await frames(3)
    await evaluate("Promise.all([...document.querySelectorAll('[data-quote-toolbar]')].flatMap(node => node.getAnimations()).map(animation => animation.finished)).then(() => true)")
    await writeFile(join(evidence, name), (await page.capturePage()).toPNG())
  }
  const mouse = (type, point, extra = {}) =>
    page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, x: point.x, y: point.y, ...extra })
  const key = async (key, code, modifiers, keyCode) => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers, windowsVirtualKeyCode: keyCode })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: keyCode })
  }
  /** The client point at character `index` of `needle`, in the `nth` element matching `selector` that contains it. */
  const point = (selector, needle, index, side = "left") => evaluate(`(() => {
    const host = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.includes(${JSON.stringify(needle)}))
    if (!host) throw new Error('No element holds ' + ${JSON.stringify(needle)})
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    const whole = nodes.map(node => node.data).join('')
    let at = whole.indexOf(${JSON.stringify(needle)}) + ${index}
    for (const node of nodes) {
      if (at < node.data.length) {
        const range = document.createRange()
        range.setStart(node, at); range.setEnd(node, at + 1)
        const box = range.getClientRects()[0]
        return {x: Math.round(${side === "left" ? "box.left + 1" : "box.right - 1"}), y: Math.round(box.top + box.height / 2)}
      }
      at -= node.data.length
    }
    throw new Error('Offset outside ' + ${JSON.stringify(needle)})
  })()`)
  /** Select from the first character of `from` to the last of `to` with a trusted mouse drag. */
  const drag = async (selector, from, to, checkHiddenWhileDragging = false) => {
    // Bring the words on screen with the wheel, as a reader would: the
    // transcript opens at its end and follows it until the person scrolls.
    await reveal(selector, from, 120, true)
    const start = await point(selector, from, 0, "left")
    const end = await point(selector, to, to.length - 1, "right")
    await mouse("mouseMoved", start, { button: "none" })
    await mouse("mousePressed", start)
    for (let step = 1; step <= 6; step++)
      await mouse("mouseMoved", { x: start.x + ((end.x - start.x) * step) / 6, y: start.y + ((end.y - start.y) * step) / 6 }, { buttons: 1 })
    if (checkHiddenWhileDragging) {
      await frames(3)
      assert.equal(await evaluate(`document.querySelectorAll('[data-quote-toolbar]').length`), 0, "no button while the drag is still selecting")
    }
    await mouse("mouseReleased", end)
    await frames(3)
  }
  /**
   * Wheel the transcript holding `needle` until it sits `offset` pixels below
   * the transcript's top, or, when `loose`, anywhere comfortably on screen.
   */
  const reveal = async (selector, needle, offset, loose = false) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const place = await evaluate(`(() => {
        const host = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.includes(${JSON.stringify(needle)}))
        // The innermost element holding the words: a highlighted code line splits them over several text nodes.
        const holder = [...host.querySelectorAll('*')].reverse().find(node => node.textContent.includes(${JSON.stringify(needle)})) ?? host
        const scroller = host.closest('[aria-label="Conversation transcript"]').getBoundingClientRect()
        const top = holder.getClientRects()[0].top - scroller.top
        if (${loose} && top >= 0 && top <= scroller.height - 120) return { delta: 0 }
        return { delta: Math.round(top - ${offset}), x: Math.round(scroller.left + scroller.width / 2), y: Math.round(scroller.top + scroller.height / 2) }
      })()`)
      if (Math.abs(place.delta) <= 2) return
      await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: place.x, y: place.y, deltaX: 0, deltaY: place.delta })
      await frames(4)
    }
    throw new Error(`Could not scroll ${needle} into place`)
  }
  const click = async (selector) => {
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
    await mouse("mouseMoved", box, { button: "none" })
    await mouse("mousePressed", box)
    await mouse("mouseReleased", box)
  }
  const selected = () => evaluate("document.getSelection().toString()")
  const quotes = () => evaluate("window.quoteEvents")
  const answerId = (needle) => evaluate(`[...document.querySelectorAll('[data-answer]')].find(node => node.textContent.includes(${JSON.stringify(needle)}))?.getAttribute('data-answer')`)

  try {
    await window.loadURL(new URL("scripts/quote-reply.html", process.env.MAKO_QUOTE_URL).href)
    await until("document.querySelectorAll('[data-answer]').length >= 3 && Boolean(document.querySelector('.composer-input'))", "the fixture's answers and composer")
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`(() => {
      window.quoteEvents = []
      window.addEventListener('mako:add-context', event => window.quoteEvents.push(JSON.parse(JSON.stringify(event.detail))))
    })()`)
    const active = '[data-quote-pane="active"] [data-answer]'
    const other = '[data-quote-pane="other"] [data-answer]'

    // 1. Prose, the floating button above the selection, and native copy left alone.
    await drag(active, "Restoring a draft", "the paragraph", true)
    assert.equal(await selected(), "Restoring a draft on that promise overwrites the paragraph")
    await until(`document.querySelector('[data-quote-toolbar]')?.getAttribute('data-quote-toolbar') === 'top'`, "the button above the selection")
    await evaluate("Promise.all(document.querySelector('[data-quote-toolbar]').getAnimations().map(animation => animation.finished)).then(() => true)")
    const geometry = await evaluate(`(() => {
      const button = document.querySelector('[data-quote-toolbar]').getBoundingClientRect()
      const selection = document.getSelection().getRangeAt(0).getClientRects()[0]
      return { buttonBottom: button.bottom, selectionTop: selection.top, height: button.height, centre: button.left + button.width / 2, start: selection.left, end: selection.right }
    })()`)
    assert.ok(geometry.buttonBottom <= geometry.selectionTop, `the button sits clear above the selection's first line: ${JSON.stringify(geometry)}`)
    assert.equal(geometry.height, 28)
    assert.ok(geometry.centre >= geometry.start && geometry.centre <= geometry.end, "the button centres on the selected line")
    await capture("prose-top.png")
    clipboard.writeText("")
    page.copy()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(clipboard.readText(), "Restoring a draft on that promise overwrites the paragraph", "⌘C still copies the selection itself")
    await click("[data-quote-toolbar]")
    await until("window.quoteEvents.length === 1", "the first quote")
    const proseAnswer = await answerId("Restoring a draft")
    assert.ok(proseAnswer, "the answer carries its message id")
    assert.deepEqual((await quotes())[0], {
      detail: { kind: "quote", text: "Restoring a draft on that promise overwrites the paragraph", messageId: proseAnswer },
      label: "“Restoring a draft on that promise…”",
    })
    assert.equal(await selected(), "", "quoting clears the selection")
    await until("document.querySelectorAll('[data-quote-toolbar]').length === 0", "the button leaving")
    await capture("after-quote.png")
    console.log("Prose: button above, copy untouched, quoted and cleared")

    // 2. Across a paragraph, a numbered list and into a code block, by the chord.
    await drag(active, "Rejection is", "const result")
    await until("Boolean(document.querySelector('[data-quote-toolbar]'))", "the button for a selection across blocks")
    await capture("across-blocks.png")
    await key("\"", "Quote", 4 | 8, 222)
    await until("window.quoteEvents.length === 2", "the chord's quote")
    assert.deepEqual((await quotes())[1].detail, {
      kind: "quote",
      text: "Rejection is a preflight fact, so the fix reads it in one tick:\n\n1. Read `preflightResult` from the prompt options.\n2. Settle while the composer is still provably empty.\n3. Leave later repaints to check the draft first.\n\n```ts\nconst result\n```",
      messageId: proseAnswer,
    })
    assert.equal((await quotes())[1].label, "“Rejection is a preflight fact, so…”")
    assert.equal(await selected(), "")
    console.log("Across blocks: ⌘⇧' quoted the paragraph, the list with its numbers and the fenced code")

    // 3. Inside a code block, by the palette: the selection is kept while the palette's field has focus.
    await drag(active, "if (result.rejected", "restore(saved)")
    await until("Boolean(document.querySelector('[data-quote-toolbar]'))", "the button over code")
    const overCode = await evaluate(`(() => {
      const button = document.querySelector('[data-quote-toolbar]').getBoundingClientRect()
      const rects = [...document.getSelection().getRangeAt(0).getClientRects()].filter(rect => rect.width >= 2)
      return { centre: button.left + button.width / 2, left: Math.min(...rects.map(rect => rect.left)), right: Math.max(...rects.map(rect => rect.right)) }
    })()`)
    assert.ok(overCode.centre > overCode.left + 40 && overCode.centre < overCode.right, `the button centres over the selected code line: ${JSON.stringify(overCode)}`)
    await capture("code-selection.png")
    await key("k", "KeyK", 4, 75)
    await until(`Boolean(document.querySelector('[aria-label="Command palette"] input'))`, "the palette")
    await page.debugger.sendCommand("Input.insertText", { text: "Quote selection" })
    await until(`document.querySelector('[aria-label="Command palette"]').textContent.includes('Quote selection in reply')`, "the palette entry")
    await capture("palette.png")
    await key("Enter", "Enter", 0, 13)
    await until("window.quoteEvents.length === 3", "the palette's quote")
    assert.deepEqual((await quotes())[2], {
      detail: { kind: "quote", text: "```ts\nif (result.rejected && draft.isEmpty()) restore(saved)\n```", messageId: proseAnswer },
      label: "“if (result.rejected &&…”",
    })
    console.log("Code: the palette quoted a fenced line with its language")

    // 4. Nothing to quote: the prompt bubble, a tool row; the command is off and the chord passes through.
    await drag('[data-quote-pane="active"] [data-exchange]', "Why did the restored", "after sending?")
    assert.ok((await selected()).length > 0)
    await frames(4)
    assert.equal(await evaluate("document.querySelectorAll('[data-quote-toolbar]').length"), 0, "the person's own prompt offers no quote")
    assert.equal(await evaluate("import('/src/extend/commands.ts').then(({commands}) => commands.get('transcript.quote-selection').when())"), false)
    await capture("prompt-no-button.png")
    await key("\"", "Quote", 4 | 8, 222)
    await frames(3)
    assert.equal((await quotes()).length, 3, "the chord does nothing without an answer selected")
    await evaluate("document.getSelection().removeAllRanges()")
    console.log("Prompt bubble: no button, command unavailable")

    // 5. Bottom placement: the selected line sits at the pane's top edge.
    await reveal(active, "Restoring a draft", 4)
    await drag(active, "Restoring a draft", "since typed")
    await until(`document.querySelector('[data-quote-toolbar]')?.getAttribute('data-quote-toolbar') === 'bottom'`, "the button below a selection at the top edge")
    const below = await evaluate(`(() => {
      const button = document.querySelector('[data-quote-toolbar]').getBoundingClientRect()
      const rects = document.getSelection().getRangeAt(0).getClientRects()
      return { top: button.top, bottom: rects[rects.length - 1].bottom }
    })()`)
    assert.ok(below.top >= below.bottom, "the button sits below the selection's last line")
    await capture("prose-bottom.png")
    await evaluate("document.getSelection().removeAllRanges()")
    console.log("Top edge: button below the selection")

    // 6. Another pane's conversation: the quote names it.
    await drag(other, "The guard redirects", "refresh settles")
    await until(`Boolean(document.querySelector('[data-quote-pane="other"] [data-quote-toolbar]'))`, "the button inside the other pane")
    assert.equal(await evaluate(`document.querySelectorAll('[data-quote-pane="active"] [data-quote-toolbar]').length`), 0, "only the pane holding the selection shows a button")
    await capture("other-pane.png")
    await click("[data-quote-toolbar]")
    await until("window.quoteEvents.length === 4", "the other pane's quote")
    const otherQuote = (await quotes())[3]
    assert.deepEqual(otherQuote, {
      detail: {
        kind: "quote",
        text: "The guard redirects to sign-in before the refresh settles",
        conversation: { harness: otherQuote.detail.conversation?.harness, id: "native-other", title: "Sign-in loop investigation" },
        messageId: await answerId("The guard redirects"),
      },
      label: "“The guard redirects to sign-in…”",
    })
    assert.ok(otherQuote.detail.conversation.harness, "the conversation names its harness")
    console.log("Other pane: the quote carries the conversation it came from")

    // 6b. Characters that mean something in markup stay characters, in the payload and in the composer's chip.
    await drag(other, "Compare with", "? a : b)")
    await until(`Boolean(document.querySelector('[data-quote-pane="other"] [data-quote-toolbar]'))`, "the button over prose and code with markup characters")
    await key("\"", "Quote", 4 | 8, 222)
    await until("window.quoteEvents.length === 5", "the markup characters' quote")
    const literal = (await quotes())[4]
    assert.deepEqual(literal, {
      detail: {
        kind: "quote",
        text: "Compare with `Map<K, V>` only when a > b && b < c.\n\n```ts\nconst pick = <T,>(a: T, b: T) => (a > b && b ? a : b)\n```",
        conversation: otherQuote.detail.conversation,
        messageId: otherQuote.detail.messageId,
      },
      label: "“Compare with Map<K, V> only when…”",
    })
    assert.doesNotMatch(JSON.stringify(literal), /&(?:amp|lt|gt|quot|#\d+);/, "no entity reaches the payload")
    await until(`document.querySelector('.composer-input').value.includes('“Compare with Map<K, V> only when…”')`, "the composer's chip")
    assert.doesNotMatch(await evaluate("document.querySelector('.composer-input').value"), /&(?:amp|lt|gt|quot|#\d+);/, "no entity reaches the composer")
    assert.ok(await evaluate("document.querySelector('.composer-input').value.includes('“if (result.rejected &&…”')"), "the code quote's chip reads && in the composer")
    await capture("composer-chips.png")
    console.log("Markup characters: &&, <T> and a > b stay literal in the payload and the composer's chips")

    // 7. The hot path: tokens streaming with nothing selected do no selection work.
    const cost = await evaluate(`(async () => {
      const { applyLiveSnapshot } = await import('/src/state/live-recovery.ts')
      const { acpStore } = await import('/src/state/acp-state.ts')
      const conversation = acpStore.get().conversations['${"aaaaaaaa-1111-4111-8111-111111111111"}']
      let rects = 0
      const original = Range.prototype.getClientRects
      Range.prototype.getClientRects = function () { rects++; return original.call(this) }
      let selectionEvents = 0
      const count = () => selectionEvents++
      document.addEventListener('selectionchange', count)
      const base = { session: { ...conversation.session, status: 'running' }, createdAt: 1, base: null, permissions: [], requests: [], control: conversation.control }
      const blocks = [{ type: 'user', text: 'Stream something.' }]
      let text = ''
      const started = performance.now()
      for (let token = 0; token < 120; token++) {
        text += 'word '
        applyLiveSnapshot({ ...base, revision: (acpStore.get().conversations[conversation.key]?.revision ?? 0) + 1, blocks: [...blocks, { type: 'text', text }] })
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
      const elapsed = performance.now() - started
      document.removeEventListener('selectionchange', count)
      Range.prototype.getClientRects = original
      return { rects, selectionEvents, elapsed, buttons: document.querySelectorAll('[data-quote-toolbar]').length }
    })()`)
    assert.equal(cost.rects, 0, "streaming with nothing selected measures no selection")
    assert.equal(cost.selectionEvents, 0)
    assert.equal(cost.buttons, 0)
    console.log(`Hot path: 120 streamed updates, ${cost.selectionEvents} selection events, ${cost.rects} range measurements, ${Math.round(cost.elapsed)} ms`)
    console.log(`Quote payloads: ${JSON.stringify(await quotes(), null, 2)}`)
  } finally {
    clearTimeout(watchdog)
    clipboard.write(saved)
    window.destroy()
  }
}
