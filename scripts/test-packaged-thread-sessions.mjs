/**
 * Installed-app evidence that related work is a Session in the same Thread,
 * on real harnesses: the `+` after the last Session tab, Fork from an
 * answer, Continue in a worktree, a running Session followed in a transcript
 * tab, and child tasks from the retired Delegate flow in journals written
 * before it went.
 *
 *   node scripts/test-packaged-thread-sessions.mjs <Mako.app> <harness...> [--out=dir] [--no-legacy] [--only=phase,...]
 *
 * Each harness runs in its own isolated standalone profile with a disposable
 * Git workspace, and its screenshots and phases are merged into
 * `<out>/result.json`. Fork and Continue in a worktree are tried on a live
 * Session first and then from the Session's saved history, because the live
 * controls act only on turns the native checkpoint has not covered yet.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { extractFile } from "@electron/asar"
import { answerText, PackagedApp } from "./lib/packaged-app.mjs"

const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
assert.ok(positional.length >= 2, "Use <Mako.app> <harness...> [--out=dir] [--no-legacy]")
const app = resolve(positional[0])
const harnesses = positional.slice(1)
const out = resolve(flag("out") ?? join(tmpdir(), "mako-thread-sessions-proof"))
const legacy = !process.argv.includes("--no-legacy")
/** Phases to run after the two every later phase needs; all when absent. */
const only = flag("only")?.split(",")
await mkdir(out, { recursive: true })
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" })

const TURN_MS = 240_000
const NO_TOOLS = "Do not use tools or modify files."
const hex = () => randomBytes(6).toString("hex").toUpperCase()
/** How each harness's row in the composer's agent menu begins, without spaces or case. */
const AGENT_NAMES = { claude: "claudecode", codex: "codex", cursor: "cursor", opencode: "opencode", devin: "devin", grok: "grok" }

async function runHarness(provider) {
  // Resolved, because the catalog reports native stores by their real path
  // and a journal records the one it was given: through macOS's /var symlink
  // the two differ, and Cursor's rows would not find their Sessions.
  const root = await realpath(await mkdtemp(join(tmpdir(), "mako-thread-sessions-")))
  const tag = basename(root)
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "README.md"), "Disposable Thread Sessions verification workspace.\n")
  const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", stdio: "pipe" }).trim()
  git("init", "-q", "-b", "main")
  git("add", "README.md")
  git("-c", "user.name=Mako fixture", "-c", "user.email=fixture@mako.invalid", "commit", "-q", "-m", "Fixture")

  const pkg = new PackagedApp({ executable: join(app, "Contents/MacOS/Mako"), root, workspace })
  const evaluate = (expression) => pkg.evaluate(expression)
  const bridge = (name, args) => pkg.bridge(name, args)
  const command = (method, params) => pkg.command(method, params)
  const waitFor = (read, predicate, label, timeout) => pkg.waitFor(read, predicate, label, timeout)
  const until = (expression, label, timeout) => waitFor(() => evaluate(`Boolean(${expression})`).catch(() => false), Boolean, label, timeout)
  const record = { harness: provider, root, outcome: "running", phases: [], screenshots: [] }
  const shot = async (name) => {
    await evaluate("document.fonts.ready.then(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve(true)), 400)))")
    const path = await pkg.screenshot(join(out, `${provider}-${name}.png`))
    record.screenshots.push(path)
    return path
  }

  /** A close-up of what `target` evaluates to, at twice the window's scale. */
  const detail = async (name, target, pad = 12) => {
    const clip = await evaluate(`(() => { const e = ${target}; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); const x = Math.max(0, r.x - ${pad}), y = Math.max(0, r.y - ${pad}); return { x, y, width: Math.min(innerWidth - x, r.width + ${pad * 2}), height: Math.min(innerHeight - y, r.height + ${pad * 2}), scale: 2 } })()`)
    if (!clip) return undefined
    const image = await command("Page.captureScreenshot", { format: "png", clip })
    const path = join(out, `${provider}-${name}.png`)
    await writeFile(path, Buffer.from(image.data, "base64"))
    record.screenshots.push(path)
    return path
  }
  const tabStrip = `document.querySelector('[role="tab"][data-session-tab]')?.closest('[role="tablist"]') ?? document.querySelector('[role="tab"][data-session-tab]')?.parentElement?.parentElement`
  /** This Thread's rail row with the rows around it. */
  const railRow = (count) => `${groupedRow(count)}?.parentElement`

  const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`
  const visible = (selector, within = "document") => `[...${within}.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.getClientRects().length)`
  const buttonWithText = (text) => `[...document.querySelectorAll('button')].find(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(text)})`
  /** This run's rows in the rail; the rail also lists the machine's other sessions, which are never touched. */
  const ourRows = `[...document.querySelectorAll('[data-thread-row]')].filter(r => (r.getAttribute('data-tip') ?? '').includes(${JSON.stringify(tag)}))`
  const groupedRow = (count) => `${ourRows}.find(r => r.querySelector(${JSON.stringify(count ? `[aria-label="${count} sessions"]` : '[aria-label$=" sessions"]')}))`
  const tabSelector = (session) => `[role="tab"][data-session-tab="${session}"]`
  /** The toasts on screen, each marked so `newToasts` passes over it; a repeat of the same words is still a new toast. */
  const toasts = () => evaluate(`[...document.querySelectorAll('[data-sonner-toast]')].map(e => { e.dataset.proofSeen = '1'; return e.innerText })`)
  const newToasts = () => evaluate(`[...document.querySelectorAll('[data-sonner-toast]:not([data-proof-seen])')].map(e => e.innerText)`)
  const sessionTabs = () => evaluate(`[...document.querySelectorAll('[role="tab"][data-session-tab]')].map(e => ({ id: e.getAttribute('data-session-tab'), title: e.textContent.trim(), selected: e.getAttribute('aria-selected') === 'true' }))`)
  const liveOnScreen = () => evaluate(`document.querySelector('[data-live-conversation]')?.getAttribute('data-live-conversation') ?? null`)
  const snapshot = (id) => bridge("liveSnapshot", [id])
  /** What a move or fork will act on: the live panel, and where each of this run's conversations says it lives. */
  const onScreenState = async () => ({
    livePanel: await liveOnScreen(),
    composer: await evaluate(`document.querySelector('.composer-input')?.getAttribute('placeholder') ?? null`),
    conversations: Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([name, id]) => {
      const snap = await snapshot(id).catch(() => null)
      return [name, snap && { id, status: snap.session.status, threadPath: snap.threadPath ?? null, baseRef: snap.base?.ref?.path ?? null, nativeId: snap.session.nativeId ?? null }]
    }))),
  })
  const requestFor = (snap, text) => snap?.requests.find((request) => request.text.includes(text))

  /**
   * Press and release a real mouse button over the element `target`
   * evaluates to, once it holds still and is what the pointer would hit.
   */
  async function click(target, { button = "left", label = target } = {}) {
    const measure = () => evaluate(`(() => { const e = ${target}; if (!e || e.disabled) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); if (!r.width || !r.height) return null; const x = r.x + r.width / 2, y = r.y + r.height / 2; return e.contains(document.elementFromPoint(x, y)) ? { x, y } : null })()`)
    const point = await waitFor(
      async () => {
        const first = await measure()
        await delay(150)
        const second = await measure()
        return first && second && first.x === second.x && first.y === second.y ? second : null
      },
      Boolean,
      `clickable ${label}`,
      30_000
    )
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    await delay(120)
    for (const type of ["mousePressed", "mouseReleased"])
      await command("Input.dispatchMouseEvent", { type, button, clickCount: 1, ...point })
  }
  /**
   * Waits for a rail row, pressing "More" under Other sessions while it is
   * folded away: this run's temp folder is not a project, and that list also
   * holds every other session on this Mac.
   */
  async function revealRow(row, label, timeout = 90_000) {
    const more = `[...document.querySelectorAll('button')].filter(b => b.getClientRects().length && b.getBoundingClientRect().x < 320 && /^More\\s*\\d+$/.test(b.textContent.trim())).at(-1)`
    await waitFor(async () => {
      if (await evaluate(`Boolean(${row})`)) return true
      if (await evaluate(`Boolean(${more})`)) await click(more, { label: "More under Other sessions" }).catch(() => {})
      return false
    }, Boolean, label, timeout)
  }
  const escape = async () => {
    for (const type of ["keyDown", "keyUp"])
      await command("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  }
  async function sendFromComposer(text) {
    await until(`document.querySelector('.composer-input:not([readonly])')`, "writable composer")
    await evaluate("document.querySelector('.composer-input').focus()")
    await command("Input.insertText", { text })
    await until(`document.querySelector('.composer-input')?.value === ${JSON.stringify(text)}`, "composer text")
    await click(q('button[aria-label="Send"]'), { label: "Send" })
  }
  /**
   * A new tab sends with the composer's agent, which starts as the profile's
   * default; choose this run's in the composer's agent menu, as a person would.
   */
  async function chooseAgent() {
    const picker = `${visible("button[data-model-picker]")}[0]`
    const on = `${picker}?.getAttribute('data-harness') === ${JSON.stringify(provider)}`
    if (await evaluate(on)) return { via: "already" }
    await click(picker, { label: "the composer's agent and model" })
    const name = JSON.stringify(AGENT_NAMES[provider] ?? provider)
    const row = `[...document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')].find(e => e.getClientRects().length && e.textContent.replace(/\\s+/g, '').toLowerCase().startsWith(${name}))`
    // The row names the harness, then the model it would run.
    const current = `${row}?.querySelector('.text-right')?.textContent.split(' · ')[0].trim()`
    await until(`${current} && ${current} !== 'Checking…'`, `${provider}'s model in the agent menu`, 60_000)
    const model = await evaluate(current)
    await click(row, { label: `${provider} in the agent menu` })
    // A click on the harness row alone does not switch agents under real mouse input; its model in the submenu does.
    if (await until(on, `the composer on ${provider}`, 2000).then(() => true, () => false)) return { via: "harness row", model }
    const item = `[...[...document.querySelectorAll('[role="menu"]')].at(-1).querySelectorAll('[role="menuitem"]')].find(e => e.getClientRects().length && e.textContent.trim().startsWith(${JSON.stringify(model)}))`
    const from = await evaluate(`(() => { const r = ${row}.getBoundingClientRect(); return { x: r.right - 4, y: r.y + r.height / 2 } })()`)
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...from })
    await click(item, { label: `${model} in ${provider}'s models` })
    await until(on, `the composer on ${provider}`)
    await escape()
    return { via: "model in the harness submenu", model }
  }
  async function openTab(session, id) {
    await click(q(tabSelector(session)), { label: `Session tab ${session}` })
    if (id) await until(q(`[data-live-conversation="${id}"]`), `live panel of ${id}`)
  }
  /** Conversation actions, End live session: the Session stays in its Thread, read from its saved history. */
  async function endLive(id) {
    await click(q('button[aria-label="Conversation actions"]'), { label: "Conversation actions" })
    await click(`[...document.querySelectorAll('button')].find(b => b.getClientRects().length && b.textContent.includes('End live session'))`, { label: "End live session" })
    await waitFor(() => snapshot(id), (snap) => snap?.session.status === "closed", "the live session ended")
  }
  async function openFromHistory(session) {
    await revealRow(groupedRow(), "this Thread's rail row")
    await click(groupedRow(), { label: "this Thread's rail row" })
    await click(q(tabSelector(session)), { label: `Session tab ${session}` })
    await until(`${visible('button[title^="Fork from this answer into a new tab in this Thread"]')}.length`, "the Session's saved history with Fork on its answers")
  }
  /**
   * Watches the live answer's Fork control from inside the renderer, which
   * sees it the moment it renders; with `press` it presses it then.
   */
  const watchFork = (id, press) => evaluate(`(() => {
    const watch = window.__forkWatch = { startedAt: performance.now(), appearedAt: null, goneAt: null, pressed: false }
    const find = () => [...(document.querySelector('[data-live-conversation="${id}"]')?.querySelectorAll('button[title^="Fork after this answer"]') ?? [])].find(b => b.getClientRects().length)
    const tick = () => {
      if (watch.goneAt !== null || watch.pressed || performance.now() - watch.startedAt > ${TURN_MS}) return stop()
      const button = find()
      if (button && watch.appearedAt === null) {
        watch.appearedAt = performance.now()
        if (${press}) { watch.pressed = true; button.click() }
      } else if (!button && watch.appearedAt !== null) watch.goneAt = performance.now()
    }
    const observer = new MutationObserver(tick)
    const timer = setInterval(tick, 10)
    const stop = () => { observer.disconnect(); clearInterval(timer) }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    return true
  })()`)
  const forkWatch = () => evaluate(`(() => { const w = window.__forkWatch; return w && { pressed: w.pressed, appeared: w.appearedAt !== null, visibleMs: w.appearedAt !== null && w.goneAt !== null ? Math.round(w.goneAt - w.appearedAt) : null } })()`)

  /**
   * A turn's answer from the live window or, once covered, from native
   * history, where a fork's first prompt also carries its context.
   */
  function answerOf(snap, requestId) {
    if (snap.blocks.some((block) => block.type === "user" && block.requestId === requestId)) return answerText(snap, requestId)
    const request = snap.requests.find((item) => item.id === requestId)
    const entries = snap.base?.entries ?? []
    const at = entries.findLastIndex((entry) => entry.kind === "user" && entry.text.includes(request.text))
    if (at < 0) return ""
    const following = entries.slice(at + 1)
    const next = following.findIndex((entry) => entry.kind === "user")
    return following.slice(0, next < 0 ? undefined : next).filter((entry) => entry.kind === "assistant")
      .flatMap((entry) => entry.blocks).filter((block) => block.type === "text").map((block) => block.text).join("\n")
  }
  const approvals = []
  /**
   * A turn to completion. Permissions are approved only for Mako's own
   * context file in this profile, which a fork's agent reads, and for what
   * `allow` names; the rest are declined.
   */
  /** When each approval was last answered, by conversation and permission; one still pending 10 s later is answered again. */
  const answeredAt = new Map()
  let pendingSeen = []
  async function approving(id, allow) {
    const allowed = [join(pkg.profile, "conversations", "context"), ...(allow ? [allow] : [])]
    const snap = await snapshot(id)
    pendingSeen = (snap?.permissions ?? []).map((permission) => ({ conversation: id, id: permission.id, title: permission.title }))
    for (const permission of snap?.permissions ?? []) {
      const key = `${id}:${permission.id}`
      if (Date.now() - (answeredAt.get(key) ?? 0) < 10_000) continue
      // Anything else, Mako's computer and browser control included, is declined and the turn goes on without it.
      const allow = allowed.some((text) => JSON.stringify(permission).includes(text)) && !/mako[-_](computer|browser)/.test(JSON.stringify(permission))
      const option = allow
        ? permission.options.find((item) => item.kind === "allow_once") ?? permission.options.find((item) => item.kind === "allow_always")
        : permission.options.find((item) => item.kind === "reject_once") ?? permission.options.find((item) => item.kind.startsWith("reject"))
      assert.ok(option, `The permission offers no ${allow ? "allow" : "decline"} option: ${permission.title}`)
      const retry = answeredAt.has(key)
      answeredAt.set(key, Date.now())
      const entry = { conversation: id, permission: permission.id, title: permission.title, option: option.kind, retry }
      approvals.push(entry)
      await bridge("livePermission", [id, permission.id, { kind: "choice", optionId: option.optionId }])
        .catch((error) => { entry.error = error instanceof Error ? error.message : String(error) })
    }
    return snap
  }
  /** `waitFor` that names the approvals still pending when it gives up. */
  const waitApproving = (read, predicate, label, timeout) =>
    waitFor(read, predicate, label, timeout).catch((error) => {
      throw new Error(`${error.message}; pending approvals: ${JSON.stringify(pendingSeen)}`)
    })
  async function completed(id, requestId, { allow } = {}) {
    return waitApproving(
      () => approving(id, allow),
      (snap) => {
        const request = snap?.requests.find((item) => item.id === requestId)
        if (request && ["failed", "uncertain", "interrupted"].includes(request.status))
          throw new Error(`The turn ended ${request.status}: ${request.error ?? ""}`)
        return request?.status === "completed"
      },
      `${provider} turn completion`,
      TURN_MS
    )
  }
  /** Sends from the composer to the conversation on screen and waits for its answer. */
  async function ask(id, text) {
    const sentAt = Date.now()
    await sendFromComposer(text)
    const request = await waitFor(async () => requestFor(await snapshot(id), text), Boolean, "the composer's request")
    const snap = await completed(id, request.id)
    return { snap, request, answer: answerOf(snap, request.id), answeredMs: Date.now() - sentAt }
  }

  async function phase(name, run) {
    if (only && !only.includes(name) && !["first-session", "new-session-from-plus"].includes(name)) return false
    const started = Date.now()
    const entry = { phase: name, passed: false }
    record.phases.push(entry)
    const approvedBefore = approvals.length
    try {
      await escape()
      Object.assign(entry, await run(entry))
      entry.passed = true
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
      entry.toasts = await toasts().catch(() => undefined)
      entry.railRows = await evaluate(`[...document.querySelectorAll('[data-thread-row]')].filter(r => (r.getAttribute('data-tip') ?? '').includes(${JSON.stringify(tag)}) || ${JSON.stringify(Object.values(ids))}.includes(r.getAttribute('data-conversation-id'))).map(r => ({ text: r.innerText.replace(/\\n/g, ' | '), conversation: r.getAttribute('data-conversation-id'), tip: r.getAttribute('data-tip') }))`).catch(() => undefined)
      entry.failureScreenshot = await shot(`${name}-failure`).catch(() => undefined)
      console.log(`${provider} ${name} failed: ${entry.error}`)
    } finally {
      if (approvals.length > approvedBefore) entry.approvals = approvals.slice(approvedBefore)
      entry.elapsedMs = Date.now() - started
    }
    if (entry.passed) console.log(`${provider} ${name} passed in ${Math.round(entry.elapsedMs / 1000)} s`)
    return entry.passed
  }

  const marker = `MARK_${hex()}`
  const reply2 = `SECOND_${hex()}`
  const READ_CONTEXT = "If the earlier conversation was given to you as a file, read that file by running cat on it with your own shell command tool, not through any MCP tool; otherwise do not use tools. Do not use computer or browser tools, and do not modify files."
  const recallMarker = `Reply only with the marker I asked you to remember in my first message. ${READ_CONTEXT}`
  const ids = {}
  const known = () => new Set(Object.values(ids))
  let thread, session1, session2

  try {
    record.launch = await pkg.start()

    const first = await phase("first-session", async () => {
      ids.s1 = randomUUID()
      const requestId = randomUUID()
      await bridge("liveStart", [provider, workspace, {
        conversationId: ids.s1,
        title: "Thread sessions proof",
        initialRequest: { id: requestId, text: `Remember this marker for later turns: ${marker}. Reply with just the marker. ${NO_TOOLS}`, attachments: [] },
      }])
      const snap = await completed(ids.s1, requestId)
      assert.ok(answerOf(snap, requestId).includes(marker), "The first answer holds the marker")
      thread = snap.threadId
      session1 = snap.sessionId
      assert.ok(thread && session1, "The first conversation is a Session of a Thread")
      await revealRow(q(`[data-conversation-id="${ids.s1}"]`), "the first Session's rail row")
      await click(q(`[data-conversation-id="${ids.s1}"]`), { label: "the first Session's rail row" })
      await until(`${q(`[data-live-conversation="${ids.s1}"]`)} && ${q(tabSelector(session1))}`, "the first Session on screen with its tab")
      return { thread, session: session1, model: snap.session.settings?.model, screenshot: await shot("1-first-session") }
    })
    if (!first) throw new Error("The first Session did not complete")

    const second = await phase("new-session-from-plus", async () => {
      await click(q('[data-add-session="new"]'), { label: "New session (+)" })
      await until(`!document.querySelector('[data-live-conversation]') && document.querySelectorAll('[role="tab"][data-session-tab]').length === 2`, "the new tab")
      const defaultAgent = await evaluate(`${visible("button[data-model-picker]")}[0]?.getAttribute('data-harness') ?? null`)
      const agentChoice = await chooseAgent()
      const sentAt = Date.now()
      await sendFromComposer(`Reply with just ${reply2}. ${NO_TOOLS}`)
      ids.s2 = await waitFor(liveOnScreen, (id) => id && id !== ids.s1, "the new tab's conversation on screen")
      await watchFork(ids.s2, false)
      const request = requestFor(await snapshot(ids.s2), reply2)
      assert.ok(request, "The new tab's message is its conversation's first request")
      const snap = await completed(ids.s2, request.id)
      assert.equal(snap.session.harness, provider, "The new Session runs on the same harness")
      assert.equal(snap.threadId, thread, "The new Session is in the same Thread")
      assert.notEqual(snap.sessionId, session1, "The new Session is a Session of its own")
      session2 = snap.sessionId
      assert.ok(answerOf(snap, request.id).includes(reply2))
      await until(`document.querySelector('[data-live-conversation="${ids.s2}"]')?.textContent.includes(${JSON.stringify(reply2)})`, "the second answer on screen")
      await until(`document.querySelectorAll('[role="tab"][data-session-tab]').length === 2`, "two Session tabs")
      await revealRow(groupedRow(2), "the grouped rail row counting two Sessions")
      const liveFork = await waitFor(forkWatch, (watch) => watch?.visibleMs !== null || !watch?.appeared, "the live Fork control settling", 20_000).catch(() => forkWatch())
      return { session: session2, newTabAgentBeforeChoosing: defaultAgent, agentChoice, answeredMs: Date.now() - sentAt, tabs: await sessionTabs(), liveForkOnAnswer: liveFork, screenshot: await shot("2-new-session-tabs-and-rail"), closeUps: [await detail("2b-session-tabs", tabStrip), await detail("2c-grouped-rail-row", railRow(2))] }
    })
    if (!second) throw new Error("The `+` Session did not complete")

    await phase("fork-live-answer", async () => {
      await openTab(session1, ids.s1)
      await toasts()
      await watchFork(ids.s1, true)
      const turn = await ask(ids.s1, `Reply with just the marker again. ${NO_TOOLS}`)
      assert.ok(turn.answer.includes(marker))
      const watch = await forkWatch()
      assert.ok(watch?.pressed, "The live answer's Fork control never rendered")
      const s3 = await waitFor(async () => {
        const id = await liveOnScreen()
        if (id && !known().has(id)) return id
        const refused = (await newToasts())[0]
        if (refused) throw new Error(`Fork refused: ${refused}`)
        return null
      }, Boolean, "the fork on screen", 30_000)
      ids.s3 = s3
      const forked = await snapshot(s3)
      assert.equal(forked.control?.ancestry?.kind, "fork")
      assert.equal(forked.control?.ancestry?.parentId, ids.s1, "The fork names the answer's conversation")
      assert.equal(forked.threadId, thread, "The fork joins the Thread")
      assert.ok(![session1, session2].includes(forked.sessionId), "The fork is its own Session")
      const recall = await ask(s3, recallMarker)
      assert.ok(recall.answer.includes(marker), `The fork recalls the marker from before the fork point; it said: ${recall.answer.slice(0, 300)}`)
      await until(`document.querySelectorAll('[role="tab"][data-session-tab]').length === 3`, "three Session tabs")
      await revealRow(groupedRow(3), "the grouped rail row counting three Sessions")
      return { session: forked.sessionId, liveFork: watch, recalledMarker: true, answeredMs: recall.answeredMs, tabs: await sessionTabs(), screenshot: await shot("3-fork-of-live-answer"), closeUps: [await detail("3b-session-tabs", tabStrip), await detail("3c-grouped-rail-row", railRow(3))] }
    })

    await phase("running-session-in-transcript-tab", async (entry) => {
      await openTab(session2, ids.s2)
      const before = await snapshot(ids.s2)
      const full = before.session.modes.find((mode) => mode.access === "full")
      // A hibernated Session takes no mode change; its sleep command is approved instead.
      if (full && before.session.currentMode !== full.id && before.session.connection === "connected") await bridge("liveSetMode", [ids.s2, full.id])
      const word = randomBytes(5).toString("hex").replace(/\d/g, (digit) => "ghijklmnop"[digit])
      const expected = word.toUpperCase()
      const sentAt = Date.now()
      const text = `Use your shell tool to run exactly this command once: sleep 20. When it has finished, reply with only the uppercase form of this word: ${word}. Do not run anything else or modify files.`
      await sendFromComposer(text)
      const request = await waitFor(async () => requestFor(await snapshot(ids.s2), word), Boolean, "the long turn's request")
      const done = completed(ids.s2, request.id, { allow: "sleep" })
      done.catch(() => {})
      await click(q(tabSelector(session2)), { button: "right", label: "Session tab menu" })
      await click(q('[data-session-action="open-transcript"]'), { label: "Open transcript" })
      const depth = `${visible('[aria-label="How much of the transcript to show"]')}[0]`
      const read = () => evaluate(`(() => {
        const depth = ${depth}
        const header = depth?.parentElement
        return depth ? { live: Boolean(header.querySelector('[title="Still running. This updates as it goes."]')), text: header.nextElementSibling?.innerText ?? "" } : null
      })()`)
      await waitFor(read, (view) => view && view.text.length > 0, "the transcript tab")
      await click(`[...${depth}.querySelectorAll('button')].find(b => b.textContent.includes('With tools'))`, { label: "With tools" })
      const samples = []
      entry.samples = samples
      let liveShot
      let status = "dispatching"
      const turnOf = (snap) => {
        const at = snap.blocks.findIndex((block) => block.type === "user" && block.requestId === request.id)
        return at < 0 ? [] : snap.blocks.slice(at + 1)
      }
      let liveShotConfirmed = false
      while ((status === "queued" || status === "dispatching") && Date.now() - sentAt < TURN_MS) {
        const view = await read()
        const snap = await snapshot(ids.s2)
        status = snap.requests.find((item) => item.id === request.id)?.status
        const turn = turnOf(snap)
        samples.push({
          atMs: Date.now() - sentAt, status, live: view?.live, length: view?.text.length ?? 0, answered: view?.text.includes(expected) ?? false,
          hostTurnBlocks: turn.length, hostTurnTools: turn.filter((block) => block.type === "tool").length,
          ...(samples.at(-1)?.length !== (view?.text.length ?? 0) ? { tail: view?.text.slice(-240) } : {}),
        })
        // The live picture is taken mid-turn, and counts only if the turn was still running once it was taken.
        if (!liveShotConfirmed && status === "dispatching" && view?.live && Date.now() - sentAt > 8000) {
          liveShot = await shot("4-transcript-tab-live")
          const after = await read()
          liveShotConfirmed = Boolean(after?.live) && (await snapshot(ids.s2)).requests.find((item) => item.id === request.id)?.status === "dispatching"
        }
        await delay(500)
      }
      const snap = await done
      const turnMs = Date.now() - sentAt
      assert.ok(answerOf(snap, request.id).includes(expected), "The long turn's reply arrived")
      const settled = await waitFor(read, (view) => view?.text.includes(expected) && !view.live, "the transcript tab showing the reply with the Live mark gone", 30_000)
      entry.samples = samples
      const running = samples.filter((sample) => sample.status === "dispatching")
      const assertions = {
        liveMarkWhileRunning: running.some((sample) => sample.live),
        replyArrivedWithoutReopening: settled.text.includes(expected),
        liveMarkGoneAfterwards: !settled.live,
        ranAtLeast15s: turnMs >= 15_000,
        liveScreenshotWhileRunning: liveShotConfirmed,
      }
      entry.assertions = assertions
      // Whether the tab showed the turn's work before its answer, and whether the host had any to show.
      entry.observations = {
        grewBeforeAnswer: running.some((sample) => !sample.answered && sample.length > samples[0].length),
        hostHadToolWhileRunning: running.some((sample) => sample.hostTurnTools > 0),
      }
      for (const [name, value] of Object.entries(assertions)) assert.ok(value, `Transcript follow: ${name}`)
      const doneShot = await shot("5-transcript-tab-completed")
      await openTab(session2, ids.s2)
      return { accessMode: (await snapshot(ids.s2)).session.currentMode, turnMs, samples, assertions, observations: entry.observations, screenshots: [liveShot, doneShot] }
    })

    /** Where the last answer sits against what the native checkpoint covers; a live move forks from that answer's live blocks. */
    const coverage = async (id) => {
      const snap = await snapshot(id)
      const last = snap.requests.findLast((item) => item.status === "completed")
      return {
        connection: snap.session.connection,
        blocks: snap.blocks.length,
        baseCoveredBlocks: snap.baseCoveredBlocks ?? 0,
        lastAnswerStartsAtBlock: snap.blocks.findIndex((block) => block.type === "user" && block.requestId === last?.id),
      }
    }
    /** Own branch from the composer, on the live Session on screen. */
    async function moveLive(name, entry) {
      await toasts()
      await click(`${visible('button[data-workspace="project-folder"]')}[0]`, { label: "Where this thread makes changes" })
      await until(`${visible('[data-workspace-option="own-branch"]')}[0] && !${visible('[data-workspace-option="own-branch"]')}[0].hasAttribute('data-disabled')`, "Own branch offered")
      entry.coverageAtClick = await coverage(ids.s1)
      await click(`${visible('[data-workspace-option="own-branch"]')}[0]`, { label: "Own branch" })
      const s4 = await waitFor(async () => {
        const id = await liveOnScreen()
        if (id && !known().has(id)) return id
        const refused = (await newToasts()).find((text) => !/Now on its own branch/.test(text))
        if (refused) {
          entry.refusedScreenshot = await shot(`${name}-refused`)
          throw new Error(`Continue in a worktree refused: ${refused}`)
        }
        return null
      }, Boolean, "the Session moved into a worktree", 120_000)
      ids.s4 = s4
      const moved = await snapshot(s4)
      const worktrees = await realpath(join(pkg.profile, "worktrees"))
      assert.ok((await realpath(moved.session.cwd)).startsWith(worktrees), `The moved Session works in a Mako worktree, not ${moved.session.cwd}`)
      assert.equal(moved.threadId, thread, "The move stays in the Thread")
      const branch = execFileSync("git", ["-C", moved.session.cwd, "branch", "--show-current"], { encoding: "utf8" }).trim()
      await until(`${visible('button[data-workspace="own-branch"]')}[0]`, "the composer naming its own branch")
      const announced = await toasts()
      const recall = await ask(s4, recallMarker)
      assert.ok(recall.answer.includes(marker), `The moved Session recalls the marker; it said: ${recall.answer.slice(0, 300)}`)
      await revealRow(`${ourRows}.find(r => r.querySelector('[data-thread-worktree]'))`, "the rail row's worktree mark", 10_000).catch(() => {})
      return { moved: s4, cwd: moved.session.cwd, branch, announced, recalledMarker: true, answeredMs: recall.answeredMs, tabs: await sessionTabs(), screenshot: await shot(name), closeUps: [await detail(`${name}-composer-branch`, `${visible('button[data-workspace="own-branch"]')}[0]?.parentElement`), await detail(`${name}-rail-row`, `${ourRows}.find(r => r.querySelector('[data-thread-worktree]')) ?? ${groupedRow()}`, 40)] }
    }

    // Session 1 has sat idle through three phases, long enough for the host to checkpoint it.
    await phase("continue-in-worktree-live-after-checkpoint", async (entry) => {
      await openTab(session1, ids.s1)
      return moveLive("6-continued-in-worktree-live-after-checkpoint", entry)
    })
    if (!ids.s4) await phase("continue-in-worktree-live-fresh-answer", async (entry) => {
      await openTab(session1, ids.s1)
      const turn = await ask(ids.s1, `Check ${hex()}: reply with just the marker. ${NO_TOOLS}`)
      assert.ok(turn.answer.includes(marker))
      return moveLive("6b-continued-in-worktree-live-fresh-answer", entry)
    })

    await phase("fork-from-saved-history", async () => {
      await openTab(session2, ids.s2)
      await endLive(ids.s2)
      await openFromHistory(session2)
      const historyShot = await shot("7-saved-history-with-fork")
      await click(`${visible('button[title^="Fork from this answer into a new tab in this Thread"]')}.at(-1)`, { label: "Fork on the last saved answer" })
      await click(`[...document.querySelectorAll('button')].find(b => b.getClientRects().length && b.textContent.includes('same agent'))`, { label: "Fork into the same agent" })
      const s5 = await waitFor(liveOnScreen, (id) => id && !known().has(id), "the fork from history on screen", 60_000)
      ids.s5 = s5
      const forked = await snapshot(s5)
      assert.equal(forked.control?.ancestry?.kind, "fork")
      assert.equal(forked.threadId, thread, "The fork from history joins the Thread")
      assert.equal(forked.session.harness, provider)
      const recall = await ask(s5, `Reply only with the SECOND_ code you replied with in your first answer. ${READ_CONTEXT}`)
      const forkShot = await shot("8-fork-from-saved-history")
      assert.ok(recall.answer.includes(reply2), `The fork from history recalls the source Session's first answer; it said: ${recall.answer.slice(0, 300)}`)
      const envelopeShown = await evaluate(`document.querySelector('[data-live-conversation="${s5}"]')?.innerText.includes('<mako-local-control>') ?? false`)
      return { session: forked.sessionId, recalled: reply2, answeredMs: recall.answeredMs, controlEnvelopeShownInPrompt: envelopeShown, tabs: await sessionTabs(), screenshots: [historyShot, forkShot] }
    })

    if (!ids.s4) await phase("continue-in-worktree-from-saved-history", async (entry) => {
      await openTab(session1, ids.s1)
      await endLive(ids.s1)
      await openFromHistory(session1)
      entry.onScreen = await onScreenState()
      await toasts()
      await click(`${visible('button[data-workspace="project-folder"]')}[0]`, { label: "Where this thread makes changes" })
      await until(`${visible('[data-workspace-option="own-branch"]')}[0] && !${visible('[data-workspace-option="own-branch"]')}[0].hasAttribute('data-disabled')`, "Own branch offered")
      await click(`${visible('[data-workspace-option="own-branch"]')}[0]`, { label: "Own branch" })
      const s6 = await waitFor(async () => {
        const id = await liveOnScreen()
        if (id && !known().has(id)) return id
        const refused = (await newToasts()).find((text) => !/Now on its own branch/.test(text))
        if (refused) throw new Error(`Continue in a worktree refused: ${refused}`)
        return null
      }, Boolean, "the Session moved into a worktree", 120_000)
      ids.s6 = s6
      const announced = await toasts()
      const moved = await snapshot(s6)
      const worktrees = await realpath(join(pkg.profile, "worktrees"))
      assert.ok((await realpath(moved.session.cwd)).startsWith(worktrees), `The moved Session works in a Mako worktree, not ${moved.session.cwd}`)
      assert.equal(moved.threadId, thread, "The move stays in the Thread")
      const branch = execFileSync("git", ["-C", moved.session.cwd, "branch", "--show-current"], { encoding: "utf8" }).trim()
      await until(`${visible('button[data-workspace="own-branch"]')}[0]`, "the composer naming its own branch")
      const recall = await ask(s6, recallMarker)
      assert.ok(recall.answer.includes(marker), `The moved Session recalls the marker; it said: ${recall.answer.slice(0, 300)}`)
      const railWorktreeMark = await revealRow(`${ourRows}.find(r => r.querySelector('[data-thread-worktree]'))`, "the rail row's worktree mark", 10_000).then(() => true, () => false)
      await revealRow(groupedRow(), "this Thread's rail row", 30_000).catch(() => {})
      return { cwd: moved.session.cwd, branch, announced, railWorktreeMark, recalledMarker: true, answeredMs: recall.answeredMs, tabs: await sessionTabs(), screenshot: await shot("9-continued-in-worktree"), closeUps: [await detail("9b-composer-branch", `${visible('button[data-workspace="own-branch"]')}[0]?.parentElement`), await detail("9c-rail-row", `${ourRows}.find(r => r.querySelector('[data-thread-worktree]')) ?? ${groupedRow()}`, 40)] }
    })

    if (legacy)
      await phase("old-delegated-work", async () => {
        const parent = [ids.s3, ids.s4, ids.s6, ids.s5, ids.s2].find(Boolean)
        assert.ok(parent, "A live Session to hold the old children")
        const parentSnap = await snapshot(parent)
        const parentSession = parentSnap.sessionId
        const parentRequest = parentSnap.requests.findLast((item) => item.status === "completed")?.id
        assert.ok(parentRequest)
        const answered = randomUUID()
        const cutShort = randomUUID()
        const children = [
          { id: answered, task: `Reply with just CHILD_${hex()}. ${NO_TOOLS}` },
          { id: cutShort, task: `Write the whole numbers from 1 to 3000 in English words, one per line, with no other text. ${NO_TOOLS}` },
        ]
        // As Delegate opened a child: titled by its task, whose text is the child's first request, under the child's own ID.
        const open = (child) => bridge("liveStart", [provider, workspace, { conversationId: child.id, title: child.task.slice(0, 120), initialRequest: { id: child.id, text: child.task, attachments: [] } }])
        await open(children[0])
        await completed(answered, answered)
        await open(children[1])
        const streamed = (snap) => {
          const at = snap?.blocks.findIndex((block) => block.type === "user" && block.requestId === cutShort) ?? -1
          return at < 0 ? "" : snap.blocks.slice(at + 1).filter((block) => block.type === "text").map((block) => block.text).join("")
        }
        await waitFor(() => snapshot(cutShort), (snap) => streamed(snap).length > 40, "the second child streaming", TURN_MS)
        // Quitting mid-turn is how an old child was cut short by Mako's exit.
        await pkg.stop({ graceful: true })
        const patch = (id, change) => {
          const path = join(pkg.profile, "conversations", `${id}.sqlite`)
          assert.ok(existsSync(path), `The journal ${path} exists`)
          const db = new DatabaseSync(path)
          try {
            const metadata = JSON.parse(db.prepare("SELECT value FROM metadata WHERE id=1").get().value)
            db.prepare("UPDATE metadata SET value=? WHERE id=1").run(JSON.stringify(change(metadata)))
          } finally {
            db.close()
          }
        }
        // The shape journals had when Delegate made these: ancestry on each child, the task list on the parent.
        for (const child of children)
          patch(child.id, (metadata) => ({ ...metadata, control: { ...metadata.control, ancestry: { kind: "delegation", parentId: parent, sourceRevision: parentSnap.revision, point: parentRequest } } }))
        // And the Thread store's record of them: a delegated Session of the parent's Session, each in a Thread of its own.
        const store = new DatabaseSync(join(pkg.profile, "threads.sqlite"))
        try {
          const sessionOf = (conversation) => store.prepare("SELECT session_id FROM journals WHERE conversation_id = ?").get(conversation)?.session_id
          for (const child of children) {
            const childSession = sessionOf(child.id)
            assert.ok(childSession && sessionOf(parent), "The store holds the parent and each child")
            const own = store.prepare("SELECT count(*) AS count FROM memberships WHERE thread_id = (SELECT thread_id FROM memberships WHERE session_id = ?)").get(childSession).count
            assert.equal(own, 1, "Each child is alone in its Thread, as a delegated child was")
            store.prepare("UPDATE sessions SET origin = 'delegation', parent_session = ? WHERE id = ?").run(sessionOf(parent), childSession)
          }
        } finally {
          store.close()
        }
        patch(parent, (metadata) => ({
          ...metadata,
          control: {
            ...metadata.control,
            children: children.map((child) => ({ id: child.id, parentRequestId: parentRequest, provider, task: child.task, status: "working", delivery: "pending", deliveryId: randomUUID() })),
          },
        }))
        const restartedAt = Date.now()
        record.relaunch = await pkg.start()
        const child = (snap, id) => snap?.control?.children.find((item) => item.id === id)
        const settled = await waitFor(() => snapshot(parent), (snap) => child(snap, answered)?.status === "completed" && child(snap, cutShort)?.status === "failed", "old children settled after restart", 60_000)
        await revealRow(groupedRow(), "this Thread's rail row after restart")
        await click(groupedRow(), { label: "this Thread's rail row after restart" })
        await click(q(tabSelector(parentSession)), { label: "the parent's Session tab" })
        await until(buttonWithText("2 delegated"), "the related-conversations control", 30_000)
        const restartTabs = await sessionTabs()
        const restartShot = await shot("10-after-restart-tabs")
        await click(buttonWithText("2 delegated"), { label: "2 delegated" })
        const dialogOf = `[...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent.includes('Related conversations'))`
        await until(`${dialogOf}?.textContent.includes('completed') && ${dialogOf}?.textContent.includes('failed')`, "Related conversations listing the old children")
        const dialog = await evaluate(`${dialogOf}.innerText`)
        const dialogShot = await shot("11-related-conversations-old-children")
        const dialogCloseUp = await detail("11b-related-conversations", dialogOf)
        await escape()
        const nudge = randomUUID()
        await bridge("livePrompt", [parent, nudge, `Reply with just OK. ${NO_TOOLS}`, []])
        await completed(parent, nudge)
        const delivered = await waitApproving(
          () => approving(parent),
          (snap) => children.every((item) => {
            const found = child(snap, item.id)
            return found?.delivery === "delivered" && snap.requests.find((request) => request.id === found.deliveryId)?.status === "completed"
          }),
          "each old child's result delivered to the parent",
          TURN_MS * 2
        )
        const deliveries = delivered.requests.filter((request) => children.some((item) => child(delivered, item.id).deliveryId === request.id))
        assert.equal(deliveries.length, 2, "One delivery per old child")
        assert.ok(deliveries.every((request) => request.text.includes("The delegated task")), "Each delivery names its delegated task")
        await until(`document.querySelector('[data-live-conversation="${parent}"]')?.textContent.includes('Result from delegated task')`, "the delivered results on screen", 30_000).catch(() => undefined)
        const deliveredShot = await shot("12-old-children-delivered")
        return {
          parent,
          children: settled.control.children.map(({ id, status, task }) => ({ id, status, task })),
          afterDelivery: delivered.control.children.map(({ id, status, delivery }) => ({ id, status, delivery })),
          deliveries: deliveries.map((request) => ({ id: request.id, status: request.status, displayText: request.displayText })),
          restartMs: Date.now() - restartedAt,
          restartTabs,
          dialog,
          screenshots: [restartShot, dialogShot, dialogCloseUp, deliveredShot],
        }
      })
    record.outcome = record.phases.every((entry) => entry.passed) ? "passed" : "failed"
  } catch (error) {
    record.outcome = "failed"
    record.error = error instanceof Error ? error.message : String(error)
    await shot("failure").catch(() => undefined)
  } finally {
    await pkg.stop()
  }
  return record
}

const resultPath = join(out, "result.json")
const build = JSON.parse(extractFile(join(app, "Contents/Resources/app.asar"), "package.json").toString("utf8")).makoBuild
const outcomes = {}
for (const provider of harnesses) {
  const startedAt = Date.now()
  console.log(`${provider}: starting`)
  const record = await runHarness(provider)
  record.elapsedMs = Date.now() - startedAt
  outcomes[provider] = record.outcome
  // Read again just before writing: runs for other harnesses may share this report.
  const result = existsSync(resultPath)
    ? JSON.parse(await readFile(resultPath, "utf8"))
    : { hostMode: "isolated-standalone", harnesses: {} }
  Object.assign(result, { app, build, updatedAt: new Date().toISOString() })
  result.harnesses[provider] = record
  await writeFile(resultPath, JSON.stringify(result, null, 2))
  console.log(`${provider}: ${record.outcome} in ${Math.round(record.elapsedMs / 1000)} s`)
}
console.log(`Verification report: ${resultPath}`)
if (Object.values(outcomes).some((outcome) => outcome !== "passed")) process.exitCode = 1
