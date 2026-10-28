import "./lib/scratch-git.mjs"
/**
 * Whether every "in progress" mark of a packaged Mako keeps moving for as
 * long as its work runs: a real turn on a real harness (in a home of its
 * own) runs three long commands at once beside two agents, and the window
 * is watched over its DevTools protocol while it is focused, left for
 * another window, covered whole, uncovered, scrolled away from the work and
 * back, and minutes in. Each sample reads every mark's computed
 * animation (its name, play state and clock, and the visibility gate's
 * word, `--visible-animation-state`) and photographs it a few times; a mark
 * on screen whose clock stands still or whose pixels never change is frozen.
 *
 *   node scripts/test-packaged-animations.mjs <Mako.app> [--out=dir] [--prefix=name-] [--harness=claude]
 *
 * The window behaves as the installed app's does (`paintCovered: false`):
 * where macOS reports it occluded, it stops painting and reads hidden, and
 * must move again once uncovered; each phase records the visibility the
 * page read. `<out>/<prefix>result.json` holds every sample; frames of the
 * running rows over five seconds are written beside it.
 */
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"


/**
 * Run under Electron: a plain window another process places, shows and
 * hides on command (one JSON line each on stdin), to take the packaged
 * window's focus and to cover it, as another app's window would.
 */
async function cover() {
  const { app, BrowserWindow } = await import("electron")
  await app.whenReady()
  app.dock?.hide()
  const window = new BrowserWindow({ show: false, frame: false, hasShadow: false, backgroundColor: "#202020" })
  // Above every other window, so covering one leaves none of it in view.
  window.setAlwaysOnTop(true, "screen-saver")
  await window.loadURL("data:text/html,<body style='background:#202020'></body>")
  createInterface({ input: process.stdin }).on("line", (line) => {
    const command = JSON.parse(line)
    if (command.type === "bounds") window.setBounds(command.bounds)
    else if (command.type === "show") window.show()
    else if (command.type === "hide") window.hide()
    else if (command.type === "quit") return void app.exit(0)
    process.stdout.write(`${JSON.stringify({ done: command.type })}\n`)
  })
  process.stdout.write(`${JSON.stringify({ done: "ready" })}\n`)
}

async function check() {
  const { PackagedApp } = await import("./lib/packaged-app.mjs")
  const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  assert.ok(positional.length === 1, "Use <Mako.app> [--out=dir] [--prefix=name-] [--harness=claude]")
  const appPath = resolve(positional[0])
  const out = resolve(flag("out") ?? join(tmpdir(), "mako-animations-proof"))
  const prefix = flag("prefix") ?? ""
  const harness = flag("harness") ?? "claude"
  await mkdir(join(out, `${prefix}frames`), { recursive: true })

  const root = await realpath(await mkdtemp(join(tmpdir(), "mako-animations-")))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "README.md"), "Disposable workspace for the animation check.\n")
  const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { stdio: "pipe" })
  git("init", "-q", "-b", "main")
  git("add", "README.md")
  git("-c", "user.name=Mako fixture", "-c", "user.email=fixture@mako.invalid", "commit", "-q", "-m", "Fixture")

  const pkg = new PackagedApp({ executable: join(appPath, "Contents/MacOS/Mako"), root, workspace, paintCovered: false })
  const evaluate = (expression) => pkg.evaluate(expression)
  const bridge = (name, args) => pkg.bridge(name, args)
  const command = (method, params) => pkg.command(method, params)
  const until = (expression, label, timeout) => pkg.waitFor(() => evaluate(`Boolean(${expression})`).catch(() => false), Boolean, label, timeout)
  /** A screenshot, or nothing when the window draws no frame for it (covered or hidden). */
  const capture = (params) => Promise.race([command("Page.captureScreenshot", { format: "png", ...params }), delay(2_000).then(() => undefined)])

  // Electron runs this file as an app's main script, named by a package of its own.
  const coverApp = join(root, "cover")
  await mkdir(coverApp)
  await writeFile(join(coverApp, "package.json"), JSON.stringify({ name: "mako-animations-cover", main: fileURLToPath(import.meta.url) }))
  const { default: electronPath } = await import("electron")
  const coverWindow = spawn(electronPath, [coverApp], {
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
    stdio: ["pipe", "pipe", "inherit"],
  })
  const coverLines = createInterface({ input: coverWindow.stdout })
  const coverDone = (type) => new Promise((done) => coverLines.on("line", function heard(line) {
    if (JSON.parse(line).done !== type) return
    coverLines.off("line", heard)
    done()
  }))
  const coverReady = coverDone("ready")
  const tell = async (message) => {
    const done = coverDone(message.type)
    coverWindow.stdin.write(`${JSON.stringify(message)}\n`)
    await done
  }

  const result = { app: appPath, harness, root, phases: [], verdicts: [] }
  const conversationId = randomUUID()
  try {
    await coverReady
    result.launch = await pkg.start()
    await command("Page.bringToFront")

    // A first turn writes enough above the work for the running rows to be scrolled out of view.
    const first = randomUUID()
    await bridge("liveStart", [harness, workspace, {
      conversationId,
      title: "Animation check",
      modeId: harness === "claude" ? "bypassPermissions" : undefined,
      initialRequest: { id: first, text: "Reply with the whole numbers from 1 to 80, one per line, and nothing else. Do not use tools.", attachments: [] },
    }])
    await pkg.waitFor(() => bridge("liveSnapshot", [conversationId]), (snap) => snap?.requests.find((request) => request.id === first)?.status === "completed", "the first turn", 180_000)
    await until(`document.querySelector('[data-conversation-id="${conversationId}"]')`, "the Thread's rail row", 60_000)
    await evaluate(`document.querySelector('[data-conversation-id="${conversationId}"]').click()`)
    await until(`document.querySelector('[data-live-conversation="${conversationId}"]')`, "the conversation on screen")

    const second = randomUUID()
    await bridge("livePrompt", [conversationId, second, [
      "In a single message, make these five tool calls at once, all in the foreground, none in the background:",
      // A command that starts with `sleep` is refused by Claude Code's own guard, so the waits are Python's.
      "three Bash calls, each with its timeout set to 300000: `python3 -c \"import time; time.sleep(200); print('one')\"`, the same with 210 and 'two', and the same with 220 and 'three';",
      "and two Agent (Task) calls, each asking a general-purpose agent to run `python3 -c \"import time; time.sleep(180); print('agent')\"` with Bash (timeout 300000) and report what it printed.",
      "When every one has finished, reply with the single word finished. Do not modify files.",
    ].join(" "), []])
    const running = `document.querySelectorAll('[data-live-conversation="${conversationId}"] [data-live-step] .shimmer-text').length`
    await pkg.waitFor(() => evaluate(running), (count) => count >= 3, "three running rows", 180_000)
    // Let the calls that were still being written settle into their rows.
    await delay(4_000)

    const sample = async (pixels) => {
      const state = await evaluate(PROBE)
      if (!pixels || state.visibility !== "visible") return { at: Date.now(), ...state, frames: {} }
      const frames = {}
      for (let shot = 0; shot < 3; shot++) {
        for (const mark of state.marks.filter((each) => each.inView)) {
          const image = await capture({ clip: { ...mark.clip, scale: 1 } })
          if (image) (frames[mark.id] ??= []).push(createHash("sha1").update(image.data).digest("hex").slice(0, 12))
        }
        await delay(110)
      }
      return { at: Date.now(), ...state, frames }
    }
    const phase = async (name, { seconds = 20, samples = 10, pixels = true } = {}) => {
      const rows = []
      const started = Date.now()
      for (let index = 0; index < samples; index++) {
        rows.push(await sample(pixels))
        const next = started + ((index + 1) * seconds * 1000) / samples
        await delay(Math.max(0, next - Date.now()))
      }
      const frames = await evaluate(FRAME_RATE)
      const entry = { name, frames, rows, marks: summarize(rows) }
      result.phases.push(entry)
      console.log(`${name}: ${frames} frames/s, visibility ${[...new Set(rows.map((row) => row.visibility))].join("/")}`)
      for (const mark of entry.marks) console.log(`  ${mark.verdict.padEnd(7)} ${mark.kind.padEnd(7)} ${mark.where.padEnd(10)} ${(mark.kind === "orb" ? `orb ${mark.state ?? ""}` : mark.name).padEnd(16)} ${mark.states.join("/").padEnd(14)} gate=${mark.gates.join("/") || "-"} clock+${mark.advanced}ms frames=${mark.distinct}/${mark.shots} ${mark.text}`)
      return entry
    }
    const bounds = await evaluate("({ x: screenX, y: screenY, width: outerWidth, height: outerHeight })")
    const scroller = `document.querySelector('[data-live-conversation="${conversationId}"]').closest('.scroll-fade-scroller') ?? document.querySelector('[data-live-conversation="${conversationId}"] .scroll-fade-scroller')`
    const wheel = async (deltaY) => {
      const point = await evaluate(`(() => { const r = (${scroller}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      for (let step = 0; step < 12; step++) {
        await command("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: deltaY / 12 })
        await delay(30)
      }
    }

    // What the packaged stylesheet does to a spinner: the app's own class, and Tailwind's.
    result.spinners = await evaluate(`(() => {
      const turns = (className) => { const element = document.createElementNS("http://www.w3.org/2000/svg", "svg"); element.setAttribute("class", className); document.body.append(element); const name = getComputedStyle(element).animationName; element.remove(); return name }
      return { "animate-spin": turns("animate-spin"), spinner: turns("spinner") }
    })()`)
    console.log(`spinners: ${JSON.stringify(result.spinners)}`)
    await phase("focused")
    await gif("running-rows")
    // Another window takes focus beside this one: this window is still in view.
    await tell({ type: "bounds", bounds: { x: bounds.x, y: bounds.y, width: 240, height: 120 } })
    await tell({ type: "show" })
    await phase("unfocused")
    // The same window over the whole of this one.
    await tell({ type: "bounds", bounds: { x: bounds.x - 20, y: bounds.y - 20, width: bounds.width + 40, height: bounds.height + 40 } })
    await phase("covered", { seconds: 10, samples: 5, pixels: false })
    await tell({ type: "hide" })
    await command("Page.bringToFront")
    await phase("uncovered")
    await wheel(-6000)
    await phase("scrolled away", { seconds: 6, samples: 3 })
    await wheel(12000)
    await phase("scrolled back")
    await phase("minutes in")
    result.verdicts = verdicts(result.phases)
  } finally {
    await bridge("liveCancel", [conversationId]).catch(() => {})
    await writeFile(join(out, `${prefix}result.json`), JSON.stringify(result, null, 2))
    coverWindow.stdin.write(`${JSON.stringify({ type: "quit" })}\n`)
    await pkg.stop().catch((error) => console.error(error))
    coverWindow.kill()
    await rm(root, { recursive: true, force: true })
  }
  console.log(`Result: ${join(out, `${prefix}result.json`)}`)
  const frozen = result.verdicts.filter((verdict) => verdict.verdict === "frozen")
  for (const verdict of frozen) console.error(`FROZEN in ${verdict.phase}: ${verdict.kind} ${verdict.where} ${verdict.name} "${verdict.text}"`)
  process.exitCode = frozen.length ? 1 : 0

  /** Frames of the running rows over five seconds, at ten a second (`ffmpeg -framerate 10 -i <name>-%03d.png` makes a GIF of them). */
  async function gif(name) {
    const clip = await evaluate(`(() => { const rows = [...document.querySelectorAll('[data-live-conversation="${conversationId}"] [data-live-step]')]; if (!rows.length) return null; const top = Math.min(...rows.map(r => r.getBoundingClientRect().top)), bottom = Math.max(...rows.map(r => r.getBoundingClientRect().bottom)), left = Math.min(...rows.map(r => r.getBoundingClientRect().left)); return { x: Math.max(0, left - 16), y: Math.max(0, top - 12), width: 760, height: bottom - top + 24 } })()`)
    if (!clip) return
    const folder = join(out, `${prefix}frames`)
    for (let index = 0; index < 50; index++) {
      const image = await capture({ clip: { ...clip, scale: 2 } })
      if (image) await writeFile(join(folder, `${name}-${String(index).padStart(3, "0")}.png`), Buffer.from(image.data, "base64"))
      await delay(100)
    }
  }
}

/**
 * Every mark on the page that says work is in progress: the sweep over
 * words, spinners, orbs, and any loop CSS runs; with where it is, whether
 * it is in view (inside every scrolling ancestor), and its animation as
 * computed and as the document's animations report it.
 */
const PROBE = `(() => {
  let next = Number(document.documentElement.dataset.animationProbe ?? 0)
  const marks = []
  const seen = new Set()
  const visibleRect = (element) => {
    let rect = element.getBoundingClientRect()
    let box = { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right }
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (style.overflowX === "visible" && style.overflowY === "visible") continue
      const outer = parent.getBoundingClientRect()
      box = { top: Math.max(box.top, outer.top), left: Math.max(box.left, outer.left), bottom: Math.min(box.bottom, outer.bottom), right: Math.min(box.right, outer.right) }
    }
    box = { top: Math.max(box.top, 0), left: Math.max(box.left, 0), bottom: Math.min(box.bottom, innerHeight), right: Math.min(box.right, innerWidth) }
    return box.bottom - box.top >= 2 && box.right - box.left >= 2 ? box : null
  }
  const add = (kind, element) => {
    if (!element || seen.has(element) || !element.isConnected) return
    seen.add(element)
    element.dataset.animationProbe ??= String(++next)
    const style = getComputedStyle(element)
    const box = visibleRect(element)
    const where = element.closest("[data-thread-row], [data-conversation-id]") ? "rail" : element.closest("[data-live-step]") ? "live step" : element.closest("[data-live-conversation]") ? "transcript" : element.closest("[data-sonner-toast]") ? "toast" : "window"
    marks.push({
      id: element.dataset.animationProbe,
      kind,
      where,
      text: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 70),
      state: element.getAttribute("data-state") ?? undefined,
      // An orb drawn at rest on purpose (Generate's mark while nothing is drafted).
      resting: element.hasAttribute("data-paused") || Boolean(element.closest("[data-commit-box]")),
      inView: Boolean(box),
      clip: box ? { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top } : undefined,
      animationName: style.animationName,
      playState: style.animationPlayState,
      gate: style.getPropertyValue("--visible-animation-state").trim(),
      animations: element.getAnimations().map((animation) => ({ name: animation.animationName ?? animation.id, playState: animation.playState, time: Math.round(Number(animation.currentTime ?? -1)) })),
    })
  }
  document.querySelectorAll(".shimmer-text").forEach((element) => add("sweep", element))
  document.querySelectorAll(".animate-spin, [data-spinner]").forEach((element) => add("spinner", element))
  document.querySelectorAll(".activity-orb").forEach((element) => add("orb", element))
  for (const animation of document.getAnimations())
    if (animation.effect?.getTiming().iterations === Infinity) add("loop", animation.effect.target)
  document.documentElement.dataset.animationProbe = String(next)
  return { visibility: document.visibilityState, focused: document.hasFocus(), marks }
})()`

/** How many frames the page painted in a second; none while hidden. */
const FRAME_RATE = `new Promise((done) => {
  let frames = 0
  const start = performance.now()
  const tick = () => { frames++; if (performance.now() - start < 1000) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  setTimeout(() => done(frames), 1100)
})`

/** Each mark over a phase: its play states, how far its clock ran, and how many different pictures it made. */
function summarize(rows) {
  const marks = new Map()
  for (const row of rows)
    for (const mark of row.marks) {
      const entry = marks.get(mark.id) ?? { id: mark.id, kind: mark.kind, where: mark.where, text: mark.text, state: mark.state, resting: mark.resting, name: mark.animationName, states: new Set(), gates: new Set(), times: [], inView: 0, seen: 0, hashes: [] }
      entry.seen++
      if (mark.inView) entry.inView++
      entry.states.add(mark.playState)
      if (mark.gate) entry.gates.add(mark.gate)
      const time = mark.animations[0]?.time
      if (time !== undefined && time >= 0) entry.times.push(time)
      entry.hashes.push(...row.frames[mark.id] ?? [])
      marks.set(mark.id, entry)
    }
  return [...marks.values()].map((entry) => {
    const advanced = entry.times.length > 1 ? Math.max(...entry.times) - Math.min(...entry.times) : 0
    const distinct = new Set(entry.hashes).size
    const visible = rows.every((row) => row.visibility === "visible")
    // A mark in view on a visible page must move: its clock must run, or (an orb, painted by its worker) its pixels must change.
    const moving = entry.kind === "orb" ? distinct > 1 : advanced > 0 && (entry.hashes.length < 2 || distinct > 1)
    // An orb's motion is read only from its pixels: none taken (the window drew no frame) says nothing.
    const verdict = !visible || entry.inView < entry.seen || entry.resting ? "resting" : entry.kind === "orb" && entry.hashes.length === 0 ? "unread" : moving ? "moving" : "frozen"
    return { ...entry, states: [...entry.states], gates: [...entry.gates], advanced, distinct, shots: entry.hashes.length, hashes: undefined, times: undefined, verdict }
  })
}

function verdicts(phases) {
  return phases.flatMap((phase) => phase.marks.map((mark) => ({ phase: phase.name, ...mark })))
}

// Electron's ready waits for its main script to finish evaluating, so the cover is not awaited.
if (process.versions.electron) void cover()
else await check()
