import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Every event the transcript draws between messages, through production
 * components on the transcript fixture page's "Every event" tab, in Electron.
 * Each case is captured on its own, dark then light, into the printed
 * directory or the one given as the first argument; `--prefix=before` names
 * the files for a comparison. It also checks that no ambient event wraps onto
 * a second line at the pane's reading width and that no line uses the old
 * "continued on its own" boilerplate. `MAKO_EVENTS_URL` points it at a Vite
 * server already running; otherwise it starts one on port 20024.
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void captureEvents().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-transcript-events-"))
  const args = process.argv.slice(2)
  const prefix = args.find((arg) => arg.startsWith("--prefix="))?.slice("--prefix=".length) ?? ""
  const target = args.find((arg) => !arg.startsWith("--"))
  const evidence = target ? resolve(target) : root
  await mkdir(evidence, { recursive: true })
  const external = process.env.MAKO_EVENTS_URL
  const server = external ? undefined : await createServer({
    cacheDir: join(root, "cache"),
    server: { host: "127.0.0.1", port: 20024, strictPort: true, hmr: false, watch: null },
  })
  if (server) await server.listen()
  const url = external ?? server.resolvedUrls.local[0]
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-transcript-events-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_EVENTS_ROOT: root, MAKO_EVENTS_EVIDENCE: evidence, MAKO_EVENTS_PAGE: url, MAKO_EVENTS_PREFIX: prefix }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server?.close()
  }
  console.log(`Transcript events evidence: ${evidence}`)
}

async function captureEvents() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_EVENTS_ROOT
  const evidence = process.env.MAKO_EVENTS_EVIDENCE
  const prefix = process.env.MAKO_EVENTS_PREFIX ? `${process.env.MAKO_EVENTS_PREFIX}-` : ""
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 180_000)
  // 860 px is the centre pane at a common desk width: the transcript column
  // is `max-w-content` (800 px) less its padding.
  const window = new BrowserWindow({ width: 860, height: 1400, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.on("console-message", (details) => {
    if (details.level === "error" || process.env.MAKO_EVENTS_VERBOSE) console.error(`[ui] ${details.level} ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = (count = 3) => evaluate(`new Promise(resolve => { let left = ${count}; const step = () => --left > 0 ? requestAnimationFrame(step) : resolve(true); requestAnimationFrame(step) })`)
  const until = async (code, label = code) => {
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${await evaluate("document.body.innerText.slice(0, 2000)")}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const base = new URL("/scripts/transcript-browser.html", process.env.MAKO_EVENTS_PAGE)
  base.searchParams.set("mode", "Every event")
  await page.loadURL(base.href)
  await until("document.querySelectorAll('[data-event-case]').length > 0", "event cases")
  await evaluate("document.fonts.ready.then(() => true)")
  // The fixture page's sticky tab bar would sit over each case.
  await evaluate("document.querySelector('header').style.display = 'none'; true")
  const cases = await evaluate("[...document.querySelectorAll('[data-event-case]')].map(node => node.dataset.eventCase)")
  assert.ok(cases.length >= 20, `expected every event case, found ${cases.length}`)

  const shoot = async (theme) => {
    await evaluate(`document.documentElement.classList.toggle("light", ${theme === "light"}); true`)
    await frames()
    for (const name of cases) {
      const rect = await evaluate(`(() => {
        const node = document.querySelector('[data-event-case="${name}"]')
        node.scrollIntoView({ block: "start" })
        const box = node.getBoundingClientRect()
        return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.min(Math.ceil(box.height), innerHeight - Math.floor(box.y)) }
      })()`)
      await frames()
      const shot = await page.capturePage(rect)
      await writeFile(join(evidence, `${prefix}${name}-${theme}.png`), shot.toPNG())
    }
  }
  await shoot("dark")
  await shoot("light")

  // Lines opened onto what they hold: an agent's report, a command's output,
  // a monitor's event, a goal's spend, Mako's words, a setup group, a summary.
  // Each must show its body, and never the provider's sentence the line rewords.
  const OPENED = {
    "turn-claude-saved-agent": { shows: "the element tree with positions", hides: 'Agent "' },
    "marker-rate-limited-agents": { shows: "Audit footprints", hides: 'Agent "' },
    "turn-claude-live-agent": { shows: "Typecheck passes everywhere", hides: 'Agent "' },
    "turn-claude-saved-command": { shows: "All checks were successful", hides: "exit code 0" },
    "turn-claude-live-command-failed": { shows: "2 failed | 512 passed", hides: "failed with exit code" },
    "turn-claude-live-monitor": { shows: "conformance: pass", hides: "Monitor event:" },
    "turn-claude-saved-queued": { shows: "514 passed", hides: "exit code 0" },
    "turn-claude-live-monitor-midturn": { shows: "conformance: pass", hides: "Monitor event:" },
    "turn-claude-saved-kept-output": { shows: "Build finished in 4m12s", hides: "exit code 0" },
    "turn-codex-live-goal": { shows: "48,210 tokens used of a 200,000-token budget", hides: "took a turn toward" },
    "turn-grok-saved-finished": { shows: "BG-DONE", hides: "completed (exit code 0)" },
    "turn-grok-saved-subagents": { shows: "context window exceeded", hides: "=== Output ===" },
    "turn-grok-live-subagent": { shows: "CHILD_DONE_GROK_A", hides: 'Subagent "' },
    "turn-devin-saved-agent": { shows: "checks-done", hides: 'Subagent "' },
    "turn-cursor-saved-failed": { shows: "Found 1 error", hides: 'Background command "' },
    "turn-opencode-saved-agent": { shows: "slowest is", hides: 'Subagent "' },
    "turn-cursor-saved-plan": { shows: "Do NOT edit the plan file", hides: undefined },
    "setup-sign-in": { shows: "todoist", hides: undefined },
    "setup-group": { shows: "model_reasoning_summary_format", hides: undefined },
    "marker-compaction": { shows: "fixing variant matching", hides: undefined },
  }
  const opened = []
  for (const name of Object.keys(OPENED)) {
    const has = await evaluate(`(() => {
      const button = document.querySelector('[data-event-case="${name}"] button[data-event-line]')
      if (!button) return false
      button.click()
      return true
    })()`)
    if (!has) continue
    await new Promise((resolve) => setTimeout(resolve, 400))
    const rect = await evaluate(`(() => {
      const node = document.querySelector('[data-event-case="${name}"]')
      node.scrollIntoView({ block: "start" })
      const box = node.getBoundingClientRect()
      return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.min(Math.ceil(box.height), innerHeight - Math.floor(box.y)) }
    })()`)
    await frames()
    await writeFile(join(evidence, `${prefix}${name}-open-light.png`), (await page.capturePage(rect)).toPNG())
    const shown = await evaluate(`document.querySelector('[data-event-case="${name}"]').innerText`)
    opened.push({
      name,
      expanded: await evaluate(`document.querySelector('[data-event-case="${name}"] button[data-event-line]').getAttribute("aria-expanded")`),
      shows: shown.includes(OPENED[name].shows),
      repeats: OPENED[name].hides !== undefined && shown.includes(OPENED[name].hides),
    })
  }

  // With Diagnostics' originals on, the seam of a continued turn says why and who, and its words open under it.
  let diagnosed = null
  if (cases.includes("continued-live-mako")) {
    await evaluate(`import("/src/state/prefs.ts").then(({ setPref }) => { setPref("showOriginals", true); return true })`)
    await evaluate(`document.querySelector('[data-event-case="continued-live-mako"] [data-turn-fold] > button').click(); true`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    await evaluate(`document.querySelector('[data-event-case="continued-live-mako"] [data-turn-continued] button[data-event-line]')?.click(); true`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    for (const theme of ["dark", "light"]) {
      await evaluate(`document.documentElement.classList.toggle("light", ${theme === "light"}); true`)
      const rect = await evaluate(`(() => {
        const node = document.querySelector('[data-event-case="continued-live-mako"]')
        node.scrollIntoView({ block: "start" })
        const box = node.getBoundingClientRect()
        return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.min(Math.ceil(box.height), innerHeight - Math.floor(box.y)) }
      })()`)
      await frames()
      await writeFile(join(evidence, `${prefix}continued-live-mako-diagnostics-${theme}.png`), (await page.capturePage(rect)).toPNG())
    }
    diagnosed = await evaluate(`document.querySelector('[data-event-case="continued-live-mako"]').innerText`)
    await evaluate(`import("/src/state/prefs.ts").then(({ setPref }) => { setPref("showOriginals", false); return true })`)
  }

  // What a reader would object to, measured rather than eyeballed.
  const report = await evaluate(`(() => {
    const lines = [...document.querySelectorAll('[data-event-line]')]
    return {
      lines: lines.length,
      wrapped: lines.filter(line => line.getBoundingClientRect().height > 30).map(line => line.textContent),
      boilerplate: [...document.querySelectorAll('[data-event-case]')].map(node => node.textContent).filter(text => /continued on its own/i.test(text)),
      // A turn that was continued reads as one: nothing where the continuation was sent, and never its words.
      continuations: [...document.querySelectorAll('[data-event-case^="continued-"]')].filter(node => node.querySelector('[data-turn-continued]') || /Continue where you left off|continued the turn/.test(node.textContent)).map(node => node.dataset.eventCase),
      // A provider's turn or Mako's line where a prompt would stand, without its moment.
      untimed: [...document.querySelectorAll('[data-provider-turn], [data-turn-continued], [data-goal-step], [data-turn-moved]')]
        .filter(node => !node.querySelector('time'))
        .map(node => node.closest('[data-event-case]').dataset.eventCase),
    }
  })()`)
  await writeFile(join(evidence, `${prefix}report.json`), JSON.stringify({ cases, opened, ...report }, null, 2))
  if (!process.env.MAKO_EVENTS_PREFIX || process.env.MAKO_EVENTS_PREFIX === "after") {
    assert.ok(report.lines > 0, "event lines carry data-event-line")
    assert.deepEqual(report.wrapped, [], "every event is one line")
    assert.deepEqual(report.boilerplate, [], "no event says it continued on its own")
    assert.deepEqual(report.continuations, [], "a continued turn says nothing of its continuation")
    assert.match(diagnosed ?? "", /Mako restarted Claude Code and continued the turn[^]*Continue where you left off/, "with originals on, the seam says why and who, with the words")
    assert.ok(opened.length >= 4 && opened.every((line) => line.expanded === "true"), "a line with more to read opens")
    assert.deepEqual(opened.filter((line) => !line.shows).map((line) => line.name), [], "each opened line shows what it holds")
    assert.deepEqual(opened.filter((line) => line.repeats).map((line) => line.name), [], "no opened line repeats the provider's sentence")
    assert.deepEqual(report.untimed, [], "every line where a prompt would stand carries its time, live as saved")
  }
  clearTimeout(watchdog)
}
