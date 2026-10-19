import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Code review in the window, against the mock bridge: `/review` in the `/`
// menu, the picker's targets and keys, a review on each kind of harness —
// Claude Code's findings, Codex's own review, Mako's prompt on Grok and
// OpenCode's prose — the card's findings, links and Ask to fix, a refusal
// for a conversation on another harness, and the picker beside a running
// turn. Writes screenshots and a recording of the whole run.
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = process.env.MAKO_REVIEW_CHECK_OUT ?? await mkdtemp(join(tmpdir(), "mako-review-ui-"))
  await mkdir(root, { recursive: true })
  const threadUrl = process.env.MAKO_THREAD_URL
  const server = threadUrl ? undefined : await createServer({
    cacheDir: join(root, "cache"),
    server: { host: "127.0.0.1", port: 0, watch: null },
  })
  if (server) await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-review-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = {
    ...process.env,
    MAKO_REVIEW_CHECK_ROOT: root,
    MAKO_REVIEW_CHECK_URL: `${threadUrl ?? server.resolvedUrls.local[0]}/`.replace(/\/\/$/, "/"),
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    if (server) await server.close()
  }
  if (process.exitCode === 0) encode(root)
  console.log(`Code review UI evidence: ${root}`)
}

/** The screencast's frames, each held for as long as it was on screen, as one video. */
function encode(root) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(root, "frames", "list.txt"),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-fps_mode", "vfr", "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", join(root, "code-review.mp4")], { stdio: "inherit" })
  if (made.status !== 0) throw new Error("ffmpeg could not encode the recording")
  const gif = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(root, "code-review.mp4"),
    "-vf", "fps=15,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", join(root, "code-review.gif")], { stdio: "inherit" })
  if (gif.status !== 0) throw new Error("ffmpeg could not write the GIF")
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_REVIEW_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const timer = setTimeout(() => app.exit(1), 180000)
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const frame = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const shots = []
  const capture = async (name, selector, { settle = true } = {}) => {
    if (settle) {
      const end = Date.now() + 2000
      while (Date.now() < end && !(await evaluate("document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)")))
        await pause(25)
    }
    await evaluate("document.fonts.ready")
    await frame()
    const bounds = selector
      ? await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); const pad = 12; return {x:Math.max(0,Math.round(r.x)-pad),y:Math.max(0,Math.round(r.y)-pad),width:Math.round(r.width)+pad*2,height:Math.round(r.height)+pad*2} })()`)
      : undefined
    await writeFile(join(root, name), (await page.capturePage(bounds)).toPNG())
    shots.push(name)
  }
  const until = async (code, what = code, ms = 15000) => {
    const end = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png", undefined, { settle: false })
        throw new Error(`Timed out: ${what}`)
      }
      await pause(25)
    }
  }
  const press = async (key, code = key, keyCode = 13) => {
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
  }
  const down = () => press("ArrowDown", "ArrowDown", 40)
  const clickAt = async (point) => {
    for (const type of ["mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  const centre = (expression) => `(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`
  const clickOn = async (expression, what) => {
    await frame()
    const point = await evaluate(centre(expression))
    assert.ok(point, `Missing ${what}`)
    await clickAt(point)
  }
  const click = (selector) => clickOn(`document.querySelector(${JSON.stringify(selector)})`, selector)
  const draft = () => evaluate("document.querySelector('[data-composer] textarea').value")
  const typeInto = async (selector, text, perKey = 16) => {
    await click(selector)
    for (const glyph of text) {
      await page.debugger.sendCommand("Input.insertText", { text: glyph })
      await pause(perKey)
    }
  }
  const field = "[data-composer] textarea"
  const picker = "document.querySelector('[data-review-picker]')"
  const active = () => evaluate(`${picker}?.querySelector('[role=option][aria-selected=true]')?.dataset.reviewChoice ?? null`)
  const toast = (text) => until(`[...document.querySelectorAll('[data-sonner-toast]')].some(t => t.textContent.includes(${JSON.stringify(text)}))`, `a toast saying ${text}`)
  const dismissToasts = async () => {
    await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")
    await until("!document.querySelector('[data-sonner-toast]')", "the toasts dismissed")
  }
  const useHarness = (id) => evaluate(`import('/src/state/threads.ts').then(m => m.setComposerHarness(${JSON.stringify(id)}))`)
  const cards = "[...document.querySelectorAll('[data-exchange] [data-review-card]')]"
  /** `/review` typed and picked from the `/` menu, which opens the picker. */
  const openPicker = async () => {
    await typeInto(field, "/rev", 80)
    await until("[...document.querySelectorAll('[role=option]')].some(o => o.textContent.startsWith('review'))", "the review row in the / menu")
    await pause(250)
    await press("Enter")
    await until(`Boolean(${picker}) && document.activeElement === ${picker}.querySelector('[role=listbox]')`, "the review picker, focused")
    await until(`${picker}.querySelectorAll('[data-review-choice]').length > 2`, "the recent commits")
  }
  const newThread = async () => {
    await click("button[aria-label='New thread']")
    await until("!document.querySelector('[data-exchange]')", "an empty conversation")
    await pause(400)
  }

  await mkdir(join(root, "frames"), { recursive: true })
  const frames = []
  let recording = false
  page.debugger.on("message", (_event, method, params) => {
    if (method !== "Page.screencastFrame") return
    void page.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {})
    if (!recording) return
    const name = `frame-${String(frames.length).padStart(5, "0")}.jpg`
    frames.push({ name, at: params.metadata.timestamp })
    void writeFile(join(root, "frames", name), Buffer.from(params.data, "base64"))
  })
  const startRecording = async () => {
    recording = true
    await page.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 })
  }
  const stopRecording = async () => {
    await pause(600)
    await page.debugger.sendCommand("Page.stopScreencast")
    recording = false
    assert.ok(frames.length > 30, `The recording caught ${frames.length} frames`)
    const lines = frames.flatMap((entry, index) => {
      const next = frames[index + 1]?.at ?? entry.at + 1
      return [`file '${join(root, "frames", entry.name)}'`, `duration ${Math.max(0.016, next - entry.at).toFixed(3)}`]
    })
    lines.push(`file '${join(root, "frames", frames.at(-1).name)}'`)
    await writeFile(join(root, "frames", "list.txt"), `${lines.join("\n")}\n`)
  }

  try {
    await window.loadURL(`${process.env.MAKO_REVIEW_CHECK_URL}?mock`)
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false })
    await until("Boolean(document.querySelector('[data-composer] textarea'))", "the composer")
    await until("Boolean(document.querySelector('[data-sonner-toast]'))", "the fixture's plugin toast", 8000).catch(() => {})
    await dismissToasts()
    await evaluate("document.querySelector(\"button[aria-label='Hide the right sidebar']\").click()")
    await until("Boolean(document.querySelector(\"button[aria-label='Show the right sidebar']\"))", "the right sidebar hidden")
    await startRecording()
    await pause(600)

    // `/review` is Mako's row; the git menu no longer stages a review message of its own.
    await typeInto(field, "/rev", 90)
    await until("[...document.querySelectorAll('[role=option]')].some(o => o.textContent.startsWith('review'))", "the review row")
    assert.equal(await evaluate("[...document.querySelectorAll('[role=option]')].filter(o => /^review/.test(o.textContent)).length"), 1, "one review row")
    assert.match(await evaluate("[...document.querySelectorAll('[role=option]')].find(o => o.textContent.startsWith('review')).textContent"), /Review changes, a branch or a commit, without editing anything/)
    await pause(500)
    await capture("menu.png")
    await press("Enter")

    // The picker: what each target covers, the recent commits, and the keys.
    await until(`Boolean(${picker}) && document.activeElement === ${picker}.querySelector('[role=listbox]')`, "the review picker, focused")
    assert.equal(await draft(), "", "picking /review leaves nothing in the draft")
    await until(`${picker}.querySelectorAll('[data-review-choice]').length === 5`, "two targets and the mock's three commits")
    const text = await evaluate(`${picker}.textContent`)
    assert.match(text, /Code reviewClaude Code runs its own review, without editing anything/)
    assert.match(text, /Uncommitted changes\d+ files, staged or not/)
    assert.match(text, /Changes against mainEverything since this branch left main, committed or not/)
    assert.match(text, /a1b2c3dReconcile message identity across host updates/)
    assert.equal(await active(), "changes", "the uncommitted changes come first")
    await pause(700)
    await capture("picker.png", "[data-review-picker]")
    await down()
    assert.equal(await active(), "branch")
    await pause(350)
    await down()
    assert.equal(await active(), "a1", "past the branch, the newest commit")
    await pause(350)
    await capture("picker-commit.png", "[data-review-picker]")
    await press("End", "End", 35)
    assert.equal(await active(), "c3")
    await down()
    assert.equal(await active(), "changes", "the list wraps")
    await pause(400)

    // Esc closes it and gives the composer back its focus.
    await press("Escape", "Escape", 27)
    await until(`!${picker}`, "the picker closed")
    await until("document.activeElement?.matches('[data-composer] textarea')", "focus back in the composer")
    await pause(400)

    // Claude Code: `/review` sent alone opens the picker too; Enter starts its own review in a new conversation.
    await typeInto(field, "/review", 60)
    await evaluate("document.querySelectorAll('[role=option]').length") // the menu is open; Escape it so Enter sends
    await press("Escape", "Escape", 27)
    await press("Enter")
    await until(`Boolean(${picker})`, "the picker from a sent /review")
    await pause(500)
    await press("Enter")
    await until(`!${picker}`, "the picker closes once the review starts")
    await until("Boolean(document.querySelector('[data-review-request=changes]'))", "the review request in the transcript")
    assert.match(await evaluate("document.querySelector('[data-review-request]').closest('[data-exchange]').textContent"), /Review uncommitted changesClaude Code runs its own review/)
    assert.equal(await evaluate("[...document.querySelectorAll('[data-exchange]')].some(e => e.textContent.includes('/review uncommitted'))"), false, "the command's words stay out of the transcript")
    await until(`${cards}.length === 1`, "Claude Code's findings card")
    const claude = await evaluate(`${cards}[0].textContent`)
    assert.match(claude, /Code review3 findings/)
    assert.match(claude, /The retry policy is sound/)
    assert.deepEqual(await evaluate(`[...${cards}[0].querySelectorAll('[data-finding]')].map(f => f.dataset.priority)`), ["1", "2", "3"], "most serious first")
    assert.match(claude, /src\/net\/retry\.ts:42–48/)
    assert.equal(await evaluate(`[...${cards}[0].querySelectorAll('.review-body[data-open]')].length`), 3, "up to three findings start open")
    await pause(1200)
    await capture("claude-window.png")
    await capture("claude-card.png", "[data-exchange] [data-review-card]")

    // A finding folds; Ask to fix stages the fixes in the composer without sending them.
    await clickOn(`${cards}[0].querySelector('[data-finding] button[aria-expanded]')`, "the first finding's title")
    await until(`${cards}[0].querySelectorAll('.review-body[data-open]').length === 2`, "the first finding folded")
    await pause(500)
    await clickOn(`[...${cards}[0].querySelectorAll('button')].find(b => b.textContent === 'Ask to fix these')`, "Ask to fix these")
    await until("document.querySelector('[data-composer] textarea').value.includes('Fix what the review found')", "the fixes in the composer")
    const staged = await draft()
    assert.match(staged, /1\. \[P1\] Retries ignore the server's Retry-After header \(src\/net\/retry\.ts:42\)/)
    assert.match(staged, /3\. \[P3\] No test covers the last retry/)
    await pause(900)
    await capture("ask-to-fix.png", "[data-composer]")
    await evaluate("(() => { const t = document.querySelector('[data-composer] textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })) })()")
    await until("document.querySelector('[data-composer] textarea').value === ''", "the draft cleared")

    // The mock's Codex predates its own review: the picker names the version it needs in place of
    // its choices, and Update brings the choices back with the keys in them.
    await useHarness("codex")
    await typeInto(field, "/rev", 80)
    await until("[...document.querySelectorAll('[role=option]')].some(o => o.textContent.startsWith('review'))", "the review row in the / menu")
    await pause(250)
    await press("Enter")
    await until(`Boolean(${picker}?.querySelector('[data-feature-floor=review]'))`, "Codex's review floor in the picker")
    assert.equal(await evaluate(`Boolean(${picker}.querySelector('[role=listbox]'))`), false, "no choices below the floor")
    assert.match(await evaluate(`${picker}.textContent`), /Code review needs Codex 0\.155\.0 or newer; this one is 0\.140\.0\./)
    await pause(600)
    await capture("picker-floor.png", "[data-review-picker]")
    await clickOn(`[...${picker}.querySelectorAll('button')].find(b => b.textContent === 'Update')`, "Update")
    await until(`!${picker}.querySelector('[data-feature-floor]') && document.activeElement === ${picker}.querySelector('[role=listbox]')`, "the choices after the update, focused")
    await press("Escape", "Escape", 27)
    await until(`!${picker}`, "the picker closed")

    // A conversation on Claude Code can't be reviewed by Codex; the refusal says what to do.
    await openPicker()
    await press("Enter")
    await toast("This conversation runs in Claude Code. Pick Claude Code again to start the review")
    assert.ok(await evaluate(`Boolean(${picker})`), "the picker stays open after a refusal")
    await pause(600)
    await press("Escape", "Escape", 27)
    await dismissToasts()

    // Codex: its own review of the branch, its absolute paths shown relative to the project.
    await newThread()
    await useHarness("codex")
    await openPicker()
    assert.match(await evaluate(`${picker}.textContent`), /Codex runs its own review/)
    await down()
    await pause(300)
    await press("Enter")
    await until("Boolean(document.querySelector('[data-review-request=branch]'))", "the branch review request")
    assert.match(await evaluate("document.querySelector('[data-review-request]').textContent"), /Review changes against main/)
    await until(`${cards}.length === 1`, "Codex's findings card")
    assert.match(await evaluate(`${cards}[0].textContent`), /src\/net\/retry\.ts:42–48/)
    assert.doesNotMatch(await evaluate(`${cards}[0].textContent`), /Users|\/repo\//, "no absolute paths in the card")
    await pause(1200)
    await capture("codex-window.png")

    // Grok answers Mako's prompt; its fenced findings render as the same card, not as code.
    await newThread()
    await useHarness("grok")
    await openPicker()
    assert.match(await evaluate(`${picker}.textContent`), /Mako asks Grok to review/)
    await down()
    await down()
    await pause(300)
    await press("Enter")
    await until("Boolean(document.querySelector('[data-review-request=commit]'))", "the commit review request")
    assert.match(await evaluate("document.querySelector('[data-review-request]').textContent"), /Review commit a1Reconcile message identity/)
    await until(`${cards}.length === 1`, "Grok's findings card")
    assert.equal(await evaluate("Boolean(document.querySelector('[data-exchange] [data-inline-code=\"mako-review\"]'))"), false, "the fence renders as the card")
    assert.match(await evaluate("document.querySelector('[data-exchange]:last-of-type').textContent"), /I read the diff and the code around it/)
    await pause(1200)
    await capture("grok-window.png")

    // OpenCode's review is prose; there is no card to draw.
    await newThread()
    await useHarness("opencode")
    await openPicker()
    await press("Enter")
    await until("document.body.textContent.includes('A canceled upload is sent again')", "OpenCode's prose review")
    await pause(400)
    assert.equal(await evaluate(`${cards}.length`), 0, "prose stays prose")
    await pause(800)
    await capture("opencode-window.png")

    // Beside a running turn, the picker says the review waits for it.
    await typeInto(field, "Run the rail tests", 30)
    await press("Enter")
    await until("document.body.textContent.includes('npm test -- rail')", "the turn running its tool")
    await openPicker()
    assert.match(await evaluate(`${picker}.textContent`), /It starts once the current turn ends\./)
    await pause(900)
    await capture("picker-running.png", "[data-composer]")
    await press("Escape", "Escape", 27)
    await until(`!${picker}`, "the picker closed")
    await pause(1200)
    await stopRecording()

    console.log(`Code review UI: the / menu, the picker's targets and keys, Claude Code's, Codex's, Grok's and OpenCode's reviews, folding, Ask to fix, a refusal and a running turn. ${shots.length} screenshots, ${frames.length} recorded frames.`)
  } finally {
    clearTimeout(timer)
    app.exit(process.exitCode ?? 0)
  }
}
