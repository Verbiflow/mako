import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Comments on picked lines, through the production file viewer, the Changes
// panel's diff, its Review stream and a commit's diff in the center, with
// trusted CDP input. Every "Add to message" must dispatch `mako:add-context`
// with the `CommentDetail` of exactly the lines picked; nothing replaces the
// draft. Screenshots go to the printed directory, or to the folder named by
// MAKO_LINE_COMMENTS_OUT.

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = await mkdtemp(join(tmpdir(), "mako-line-comments-"))
  const out = process.env.MAKO_LINE_COMMENTS_OUT ?? root
  await mkdir(out, { recursive: true })
  const server = await createServer({
    cacheDir: join(root, "cache"),
    // Other work in the checkout must not reload the fixture mid-run.
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-line-comments-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_LINE_ROOT: root, MAKO_LINE_OUT: out, MAKO_LINE_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Line comments evidence: ${out}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_LINE_ROOT
  const out = process.env.MAKO_LINE_OUT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const fixture = (code) => evaluate(`import('/src/dev/line-comments-check.tsx').then(m => { ${code} })`)
  const frames = () => evaluate("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))")
  const capture = async (name) => {
    await evaluate("Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})))")
    await frames()
    await writeFile(join(out, name), (await page.capturePage()).toPNG())
  }
  const until = async (code, label = code) => {
    const end = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png")
        throw new Error(`Timed out: ${label}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  /** The centre of an element inside a rendered file or diff's shadow root. */
  const inside = (host, selector, at = "center") => evaluate(`(() => {
    const roots = [...document.querySelectorAll(${JSON.stringify(`${host} diffs-container`)})].map(node => node.shadowRoot).filter(Boolean)
    const node = roots.map(root => root.querySelector(${JSON.stringify(selector)})).find(Boolean)
    if (!node) throw new Error('Missing ' + ${JSON.stringify(selector)})
    node.scrollIntoView({ block: 'nearest' })
    const r = node.getBoundingClientRect()
    return { x: Math.round(${at === "start" ? "r.x + 2" : at === "end" ? "r.right - 2" : "r.x + r.width / 2"}), y: Math.round(r.y + r.height / 2) }
  })()`)
  const mouse = (type, point, extra = {}) => page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point, ...extra })
  const press = async (point, modifiers = 0) => {
    await mouse("mouseMoved", point, { button: "none", modifiers })
    await mouse("mousePressed", point, { modifiers, buttons: 1 })
    await mouse("mouseReleased", point, { modifiers })
    await frames()
  }
  const drag = async (from, to) => {
    await mouse("mouseMoved", from, { button: "none" })
    await mouse("mousePressed", from, { buttons: 1 })
    const steps = 6
    for (let step = 1; step <= steps; step += 1) {
      await mouse("mouseMoved", { x: Math.round(from.x + ((to.x - from.x) * step) / steps), y: Math.round(from.y + ((to.y - from.y) * step) / steps) }, { buttons: 1 })
    }
    await mouse("mouseReleased", to)
    await frames()
  }
  const key = async (name, code = name, keyCode = 0, text) => {
    const down = { type: "rawKeyDown", key: name, code, windowsVirtualKeyCode: keyCode }
    if (text) Object.assign(down, { type: "keyDown", text })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", down)
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: keyCode })
  }
  const type = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const added = () => fixture("return m.added")
  const field = (label) => `[data-line-comment=${JSON.stringify(label)}]`

  const timer = setTimeout(() => app.exit(1), 120_000)
  try {
    await window.loadURL(`${process.env.MAKO_LINE_URL}scripts/line-comments.html`)
    await until("Boolean(document.querySelector('[data-changes] diffs-container')?.shadowRoot?.querySelector('[data-column-number]'))", "the Changes diff renders")
    await evaluate("window.composed = 0; window.addEventListener('mako:compose', () => { window.composed += 1 }); true")
    const VIEWER = 'section[aria-label="Workbench pane"]'
    const CHANGES = "[data-changes]"
    const file = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => `const value${from + index} = ${from + index}`).join("\n")

    // ---- The file viewer: a gutter range, extended with shift ---------------
    await fixture("return m.openFile()")
    await until(`Boolean(document.querySelector('${VIEWER} diffs-container')?.shadowRoot?.querySelector('[data-line="40"]'))`, "the file renders")
    await press(await inside(VIEWER, '[data-column-number="5"]'))
    await until(`Boolean(document.querySelector(${JSON.stringify(field("review.ts:5"))}))`, "one picked line offers its field")
    assert.equal(await evaluate(`document.querySelector('${VIEWER} diffs-container').shadowRoot.querySelectorAll('[data-line][data-selected-line]').length`), 1, "the picked line wears the selection tint")
    await press(await inside(VIEWER, '[data-column-number="8"]'), 8)
    await until(`Boolean(document.querySelector(${JSON.stringify(field("review.ts:5–8"))}))`, "shift extends the pick")
    assert.equal(await evaluate(`document.querySelector('${VIEWER} diffs-container').shadowRoot.querySelectorAll('[data-line][data-selected-line]').length`), 4)
    assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), "Comment on review.ts:5–8", "a gutter pick puts the caret in the comment")
    const tint = await evaluate(`getComputedStyle(document.querySelector('${VIEWER} diffs-container').shadowRoot.querySelector('[data-line="6"]')).backgroundColor`)
    // The picked numbers carry the text's colour, not the diff's "modified" hue.
    const spread = await evaluate(`(() => {
      const color = getComputedStyle(document.querySelector('${VIEWER} diffs-container').shadowRoot.querySelector('[data-column-number="6"]')).color
      const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data
      return Math.max(r, g, b) - Math.min(r, g, b)
    })()`)
    assert.ok(spread < 24, `a picked line number is a neutral tint, not a hue (channel spread ${spread})`)
    await type("Why are these four separate constants?")
    await capture("viewer-gutter-range.png")
    await key("Enter", "Enter", 13, "\r")
    await until("import('/src/dev/line-comments-check.tsx').then(m => m.added.length === 1)", "Enter adds the chip")
    assert.deepEqual((await added())[0], {
      label: "review.ts:5–8",
      detail: { kind: "comment", path: "src/state/review.ts", startLine: 5, endLine: 8, side: "new", source: "file", code: file(5, 8), comment: "Why are these four separate constants?" },
    }, "the viewer's chip is the file's lines, CRLF read away, relative to the workspace")
    assert.equal(await evaluate("document.querySelector('[data-line-comment]')"), null, "adding closes the field")
    assert.equal(await evaluate(`document.querySelector('${VIEWER} diffs-container').shadowRoot.querySelectorAll('[data-line][data-selected-line]').length`), 0, "and lets the lines go")
    console.log(`Viewer: line 5 picked, shift to 8, Enter added the chip; selection tint ${tint}`)

    // A drag down the gutter, then Escape: nothing is added, the file stays open.
    await drag(await inside(VIEWER, '[data-column-number="20"]'), await inside(VIEWER, '[data-column-number="22"]'))
    await until(`Boolean(document.querySelector(${JSON.stringify(field("review.ts:20–22"))}))`, "a drag picks a range")
    await key("Escape", "Escape", 27)
    await until("!document.querySelector('[data-line-comment]')", "Escape closes the field")
    assert.equal((await added()).length, 1, "Escape adds nothing")
    assert.ok(await evaluate(`Boolean(document.querySelector('${VIEWER} diffs-container'))`), "Escape in the field leaves the file open")

    // A text selection inside the code picks the lines it touches; dragged upward, it is the same lines.
    await drag(await inside(VIEWER, '[data-line="11"]', "end"), await inside(VIEWER, '[data-line="10"]', "start"))
    if (process.env.MAKO_LINE_PROBE) console.log(await evaluate(`(() => { const host = document.querySelector('${VIEWER} diffs-container'); const root = host.shadowRoot; const sel = getSelection(); const out = { collapsed: sel.isCollapsed, text: sel.toString().slice(0, 40), has: 'getComposedRanges' in sel }; try { const [r] = sel.getComposedRanges({ shadowRoots: [root] }); out.start = r && (r.startContainer.nodeName + ':' + (r.startContainer.parentElement?.outerHTML.slice(0, 120))); out.inRoot = r && root.contains(r.startContainer); out.end = r && r.endContainer.nodeName + ' ' + r.endOffset } catch (e) { out.error = String(e) } return JSON.stringify(out) })()`))
    await until(`Boolean(document.querySelector(${JSON.stringify(field("review.ts:10–11"))}))`, "a text selection picks its lines")
    assert.ok(await evaluate("getSelection().toString().includes('value10')"), "the text stays selected")
    assert.notEqual(await evaluate("document.activeElement?.getAttribute('aria-label')"), "Comment on review.ts:10–11", "a text selection keeps its highlight: the field does not take focus")
    await capture("viewer-text-selection.png")
    await press(await evaluate(`(() => { const r = document.querySelector('[aria-label="Add review.ts:10–11 to message"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`))
    await until("import('/src/dev/line-comments-check.tsx').then(m => m.added.length === 2)", "the button adds the chip")
    assert.deepEqual((await added())[1], {
      label: "review.ts:10–11",
      detail: { kind: "comment", path: "src/state/review.ts", startLine: 10, endLine: 11, side: "new", source: "file", code: file(10, 11), comment: "" },
    })
    console.log("Viewer: a drag picked 20–22 and Escape let it go; text selected upward across 11–10 added lines 10–11")

    // ---- The Changes panel's diff: a range of added and unchanged lines --------
    const changeRow = (type, line) => `[data-line-type="${type}"][data-column-number="${line}"]`
    await press(await inside(CHANGES, changeRow("change-addition", 12)))
    await press(await inside(CHANGES, changeRow("context", 15)), 8)
    await until(`Boolean(document.querySelector(${JSON.stringify(field("review.ts:12–15"))}))`, "a diff range offers its field under its last line")
    assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), "Comment on review.ts:12–15")
    await type("Twelve is spelled out here only")
    await capture("diff-range.png")
    await key("Enter", "Enter", 13, "\r")
    await until("import('/src/dev/line-comments-check.tsx').then(m => m.added.length === 3)", "Enter adds the diff's chip")
    assert.deepEqual((await added())[2], {
      label: "review.ts:12–15",
      detail: { kind: "comment", path: "src/state/review.ts", startLine: 12, endLine: 15, side: "new", source: "diff", base: "HEAD", code: "const value12 = twelve\nconst value14 = 14\nconst value15 = 15\nconst value16 = 16", comment: "Twelve is spelled out here only" },
    })

    // A removed line is the old side, numbered in the old file.
    await press(await inside(CHANGES, changeRow("change-deletion", 13)))
    await until(`Boolean(document.querySelector(${JSON.stringify(field("review.ts:13"))}))`)
    await press(await evaluate(`(() => { const r = document.querySelector('[aria-label="Add review.ts:13 to message"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`))
    await until("import('/src/dev/line-comments-check.tsx').then(m => m.added.length === 4)")
    assert.deepEqual((await added())[3], {
      label: "review.ts:13",
      detail: { kind: "comment", path: "src/state/review.ts", startLine: 13, endLine: 13, side: "old", source: "diff", base: "HEAD", code: "const value13 = 13", comment: "" },
    })
    console.log("Changes diff: new 12 to 15 with shift, and removed line 13 on the old side")

    // ---- Notes on the diff: each becomes a chip ------------------------------
    const note = async (kind, line, body) => {
      const row = await inside(CHANGES, changeRow(kind, line))
      await mouse("mouseMoved", row, { button: "none" })
      await until(`(() => { const b = document.querySelector('[data-changes] button[aria-label="Comment on this line"]'); if (!b) return false; const r = b.getBoundingClientRect(); return Math.abs(r.y + r.height / 2 - ${row.y}) < 8 })()`, "the gutter offers a note on the hovered line")
      const button = await evaluate("(() => { const r = document.querySelector('[data-changes] button[aria-label=\"Comment on this line\"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()")
      await press(button)
      await until("Boolean(document.querySelector('[data-changes] textarea[placeholder=\"What is wrong with this line?\"]'))", "the note's field opens")
      assert.equal(await evaluate("document.querySelector('[data-line-comment]')"), null, "pressing the note button does not also pick the line")
      await type(body)
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 4 })
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 4 })
      await until("!document.querySelector('[data-changes] textarea[placeholder=\"What is wrong with this line?\"]')", `⌘↩ saves the note on ${kind} ${line}`)
    }
    await note("change-addition", 29, "Name this for what it holds")
    await note("change-deletion", 30, "Was anything reading thirty?")
    await note("context", 10, "Leave this one alone")
    await until("Boolean([...document.querySelectorAll('[data-changes] button')].find(b => b.textContent === 'Add 3 notes to message'))", "the bar counts the notes")
    // One note on its own.
    await press(await evaluate("(() => { const button = [...document.querySelectorAll('[data-changes] p')].find(p => p.textContent === 'Leave this one alone').parentElement.querySelector('[aria-label=\"Add this note to the message\"]'); const r = button.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()"))
    await until("import('/src/dev/line-comments-check.tsx').then(m => m.added.length === 5)", "a note's own button adds it")
    assert.deepEqual((await added())[4], {
      label: "review.ts:10",
      detail: { kind: "comment", path: "src/state/review.ts", startLine: 10, endLine: 10, side: "new", source: "diff", base: "HEAD", code: "const value10 = 10", comment: "Leave this one alone" },
    })
    await until("Boolean([...document.querySelectorAll('[data-changes] button')].find(b => b.textContent === 'Add 2 notes to message'))", "the added note leaves the diff")
    await capture("diff-notes.png")
    await press(await evaluate("(() => { const r = [...document.querySelectorAll('[data-changes] button')].find(b => b.textContent === 'Add 2 notes to message').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()"))
    await until("import('/src/dev/line-comments-check.tsx').then(m => m.added.length === 7)", "the bar adds one chip per note")
    assert.deepEqual((await added()).slice(5), [
      { label: "review.ts:29", detail: { kind: "comment", path: "src/state/review.ts", startLine: 29, endLine: 29, side: "new", source: "diff", base: "HEAD", code: "const value30 = thirty", comment: "Name this for what it holds" } },
      { label: "review.ts:30", detail: { kind: "comment", path: "src/state/review.ts", startLine: 30, endLine: 30, side: "old", source: "diff", base: "HEAD", code: "const value30 = 30", comment: "Was anything reading thirty?" } },
    ], "ordered by line, each with its side")
    assert.equal(await evaluate("Boolean([...document.querySelectorAll('[data-changes] button')].find(b => /notes? to message/.test(b.textContent)))"), false, "no notes are left once added")
    console.log("Notes: three saved, one added from its own button, two from Add 2 notes to message")

    // ---- The Review stream ----------------------------------------------------------
    await fixture("m.layout('review')")
    await until("Boolean(document.querySelector('[data-review-stream] diffs-container')?.shadowRoot?.querySelector('[data-line-type=\"change-addition\"][data-column-number=\"30\"]'))", "the Review stream renders the diff")
    const STREAM = "[data-review-stream]"
    await drag(await inside(STREAM, changeRow("change-addition", 29)), await inside(STREAM, changeRow("change-addition", 30)))
    await until(`Boolean(document.querySelector(${JSON.stringify(field("review.ts:29–30"))}))`, "a drag picks a range in the stream")
    await type("Split into two on purpose?")
    await capture("review-stream-range.png")
    await key("Enter", "Enter", 13, "\r")
    await until("import('/src/dev/line-comments-check.tsx').then(m => m.added.length === 8)")
    assert.deepEqual((await added())[7], {
      label: "review.ts:29–30",
      detail: { kind: "comment", path: "src/state/review.ts", startLine: 29, endLine: 30, side: "new", source: "diff", base: "HEAD", code: "const value30 = thirty\nconst value30b = 30.5", comment: "Split into two on purpose?" },
    })
    assert.equal(await evaluate(`document.querySelector('${STREAM} diffs-container').shadowRoot.querySelectorAll('[data-selected-line]').length`), 0, "adding lets the stream's lines go")
    console.log("Review stream: a drag over new 29–30 added its chip")

    // ---- A commit's diff in the center: one pick across both sides --------------------
    await fixture("return m.openCommitDiff()")
    await until(`Boolean(document.querySelector('${VIEWER} diffs-container')?.shadowRoot?.querySelector('[data-line-type="change-deletion"][data-column-number="13"]'))`, "the commit's diff opens in the center")
    await press(await inside(VIEWER, changeRow("change-deletion", 13)))
    await press(await inside(VIEWER, changeRow("change-addition", 12)), 8)
    await until(`Boolean(document.querySelector(${JSON.stringify(field("review.ts:13 old, review.ts:12 new"))}))`, "a pick across both sides names each file's lines")
    await capture("commit-diff-cross-side.png")
    await type("Same change, both sides")
    await key("Enter", "Enter", 13, "\r")
    await until("import('/src/dev/line-comments-check.tsx').then(m => m.added.length === 10)")
    assert.deepEqual((await added()).slice(8), [
      { label: "review.ts:13", detail: { kind: "comment", path: "src/state/review.ts", startLine: 13, endLine: 13, side: "old", source: "diff", base: "bbbbbbb^", code: "const value13 = 13", comment: "Same change, both sides" } },
      { label: "review.ts:12", detail: { kind: "comment", path: "src/state/review.ts", startLine: 12, endLine: 12, side: "new", source: "diff", base: "bbbbbbb^", code: "const value12 = twelve", comment: "Same change, both sides" } },
    ], "a commit's lines are compared against its parent")
    console.log("Commit diff: old 13 to new 12 across the split added the old line 13 and the new line 12")

    assert.equal(await evaluate("window.composed"), 0, "nothing replaced the draft")
    const payloads = await added()
    await writeFile(join(out, "payloads.json"), `${JSON.stringify(payloads, null, 2)}\n`)
    console.log(`Line comments: ${payloads.length} chips added through mako:add-context, none through mako:compose`)
  } finally {
    clearTimeout(timer)
    app.quit()
  }
}
