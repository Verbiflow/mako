import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// A turn's work as the live app draws it (`scripts/live-workflow.html` with its mock bridge), in dark and light,
// written into <out> as <prefix><scene>-<theme>.png, each cropped to the turn:
//   quiet       one command done, the next running with no output for five minutes
//   several     reads, a search, edits and commands done, a test run running
//   parallel    three calls running at once under what the turn has done
//   agents      five agents started together with long prompts, one finished, as a window that opened the
//               running turn reads them: each call's input the host's preview of it
//   agents-open the same group opened onto each agent's row
//   finished    `several` settled, its work folded under one row
//   opened      the settled turn's fold opened
//   steps       `several` with its steps opened
//
//   node scripts/work-log-screenshots.mjs <out> [--prefix before-] [--port 20028] [--cut slice]
//
// `--cut slice` previews a long input as the host did before it kept the JSON whole (its first 2048 characters).
if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const out = resolve(args.find((arg, at) => !arg.startsWith("--") && !args[at - 1]?.startsWith("--")) ?? "work-log-screenshots")
  const port = Number(option("--port")) || 20028
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  await mkdir(join(out, "electron"), { recursive: true })
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true, hmr: false, watch: null } })
  await server.listen()
  await writeFile(join(out, "electron", "package.json"), JSON.stringify({ name: "mako-work-log-screenshots", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_WORK_SHOTS: out, MAKO_WORK_PREFIX: option("--prefix") ?? "", MAKO_WORK_CUT: option("--cut") ?? "json", MAKO_WORK_URL: `http://127.0.0.1:${port}/scripts/live-workflow.html` }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [join(out, "electron")], { env, stdio: "inherit" })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Work log screenshots: ${out}`)
}

const TURN = "77777777-7777-4777-8777-777777777777"

/** Applies scene `name` to the fixture's live conversation, as one snapshot the host would send. */
const PUBLISH = (name, cut) => `(async () => {
  const { acpStore } = await import("/src/state/acp-state.ts")
  const { applyLiveSnapshot } = await import("/src/state/live-recovery.ts")
  const state = acpStore.get()
  const live = state.conversations[state.activeKey]
  const now = Date.now()
  const scene = ${JSON.stringify(name)}
  const turn = ${JSON.stringify(TURN)}
  const cwd = live.session.cwd
  // A long input as the host previews it (\`previewInput\`): its JSON with each long string cut, or with \`slice\` its head.
  const preview = (text) => text.length <= 2048 ? text : ${JSON.stringify(cut)} === "slice" ? text.slice(0, 2048)
    : JSON.stringify(JSON.parse(text), (_key, value) => typeof value === "string" && value.length > 256 ? value.slice(0, 256) + "…" : value)
  const tool = (id, name, input, status, at, output = "") => ({ type: "tool", id, name, input: preview(JSON.stringify(input)), output, status, at, endedAt: status === "pending" ? undefined : at + 2_000, ...(JSON.stringify(input).length > 2048 ? { historyRest: { index: 0, length: output.length } } : {}) })
  const settled = scene === "finished" || scene === "opened"
  const prompt = { type: "user", text: "The expired-session redirect drops the deep link. Fix it, add a regression test and run the router suite.", requestId: turn, at: now - (settled ? 212_000 : scene === "quiet" ? 340_000 : 96_000) }
  const done = [
    { type: "thinking", text: "**Finding the guard**\\n\\nThe redirect is decided in the route guard; the refresh path is where returnTo gets lost.", at: now - 92_000 },
    tool("read-guard", "Read", { file_path: cwd + "/src/router/guard.ts" }, "completed", now - 90_000, "export function guard(route) { … }"),
    tool("grep-return", "Grep", { pattern: "returnTo", path: "src" }, "completed", now - 84_000, "src/router/guard.ts:14\\nsrc/session/refresh.ts:31"),
    tool("read-refresh", "Read", { file_path: cwd + "/src/session/refresh.ts" }, "completed", now - 80_000, "export async function refresh() { … }"),
    tool("git-log", "Bash", { command: "git log --oneline -5 -- src/router src/session" }, "completed", now - 76_000, "9a7a5c0 Keep the session alive across reloads"),
    tool("edit-guard", "Edit", { file_path: cwd + "/src/router/guard.ts", old_string: "redirect(signIn)", new_string: "redirect(signIn, { returnTo })" }, "completed", now - 60_000),
    tool("write-test", "Write", { file_path: cwd + "/src/router/guard.test.ts", content: "describe(\\"expired session\\", …)" }, "completed", now - 52_000),
    tool("typecheck", "Bash", { command: "npm run typecheck" }, "completed", now - 46_000, "> tsc -b\\n"),
    { type: "thinking", text: "Now the router suite, to see the expired-session case pass.", at: now - 31_000 },
  ]
  const request = (status) => ({ id: turn, text: prompt.text, attachments: [], status })
  const running = { ...live.session, status: "running", connection: "connected" }
  const blocks = (() => {
    switch (scene) {
      case "quiet":
        return [
          prompt,
          tool("prepare", "Bash", { command: "D=$MAKO_THREAD_DATA_DIR; T=$D/release-tree; rm -rf $T; mkdir -p $T; git archive origin/main | tar -x -C $T" }, "completed", now - 330_000, ""),
          tool("verify", "Bash", { command: "B=$(gh pr view 182 --json mergeCommit -q .mergeCommit.oid) && git -C $T log -1 --format=%H && npm --prefix $T run build && npm --prefix $T test" }, "pending", now - 320_000),
        ]
      case "several":
      case "steps":
        return [prompt, ...done, tool("test-router", "Bash", { command: "npm test -- src/router" }, "pending", now - 28_000)]
      case "parallel":
        return [
          prompt, ...done,
          tool("suite", "Bash", { command: "npm test -- src/router src/session --reporter=dot" }, "pending", now - 24_000),
          tool("read-tests", "Read", { file_path: cwd + "/src/router/guard.test.ts" }, "completed", now - 23_900, "describe(\\"guard\\", () => { … })"),
          tool("grep-expiry", "Grep", { pattern: "sessionExpired|expiresAt", path: "src" }, "pending", now - 23_800),
          tool("lint", "Bash", { command: "npm run lint -- src/router src/session" }, "pending", now - 23_700),
        ]
      case "agents":
      case "agents-open": {
        // Briefs as long as a model writes them: three run past the preview's 2048 characters.
        const brief = (words, times) => (words + " Report file paths and line numbers for everything you cite. ").repeat(times)
        const agent = (id, description, times, status, output = "") => tool(id, "Agent", { description, prompt: brief(description + ".", times), subagent_type: "Explore" }, status, now - 55_000, output)
        return [
          prompt,
          tool("read-routes", "Read", { file_path: cwd + "/src/router/routes.ts" }, "completed", now - 72_000, "export const routes = [ … ]"),
          agent("agent-routes", "Map every protected route", 2, "pending"),
          agent("agent-refresh", "Trace the session refresh", 3, "pending"),
          agent("agent-tests", "Find the redirect tests", 40, "completed", "guard.test.ts covers sign-in and sign-out; nothing expires a session."),
          agent("agent-links", "Check deep link parsing", 40, "pending"),
          agent("agent-expiry", "Audit session expiry handling", 40, "pending"),
        ]
      }
      case "finished":
      case "opened":
        return [
          prompt, ...done,
          tool("test-router", "Bash", { command: "npm test -- src/router" }, "completed", now - 28_000, "PASS src/router/guard.test.ts (13 tests)"),
          { type: "text", text: "The guard now keeps \`returnTo\` when the session refresh fails, so signing in returns to the deep link. I added an expired-session case to \`src/router/guard.test.ts\`; the router suite passes.", at: now },
        ]
    }
  })()
  const agents = scene.startsWith("agents") ? {
    limited: false,
    agents: [
      ["agent-routes", "Map every protected route", { kind: "working", activity: "Reading src/router/routes.ts" }],
      ["agent-refresh", "Trace the session refresh", { kind: "working", activity: "Reading src/session/refresh.ts" }],
      ["agent-tests", "Find the redirect tests", { kind: "completed", summary: "guard.test.ts covers sign-in and sign-out" }, now - 21_000],
      ["agent-links", "Check deep link parsing", { kind: "working", activity: "Searching for parseDeepLink" }],
      ["agent-expiry", "Audit session expiry handling", { kind: "working", activity: "Reading src/session/expiry.ts" }],
    ].map(([toolId, title, state, settledAt]) => ({ bindingId: live.session.id, provider: "claude", nativeId: "native-" + toolId, toolId, title, role: "Explore", work: "agent", observedAt: now, startedAt: now - 55_000, state, ...(settledAt ? { settledAt } : {}) })),
  } : undefined
  applyLiveSnapshot({
    epoch: "work-log-" + scene, revision: (live.revision ?? 0) + 1, createdAt: 1, base: null, permissions: [],
    control: live.control,
    session: settled ? { ...live.session, status: "ready", connection: "connected" } : running,
    // The quiet scene's command has said nothing for five minutes.
    activityAt: scene === "quiet" ? now - 300_000 : now,
    nativeActivity: undefined,
    nativeAgents: agents,
    blocks,
    requests: [request(settled ? "completed" : "dispatching")],
  })
  return true
})()`

const SCENES = ["quiet", "several", "parallel", "agents", "agents-open", "finished", "opened", "steps"]

async function shoot() {
  const { app, BrowserWindow, nativeTheme } = await import("electron")
  const out = process.env.MAKO_WORK_SHOTS
  const prefix = process.env.MAKO_WORK_PREFIX
  app.commandLine.appendSwitch("force-device-scale-factor", "2")
  app.setPath("userData", join(out, "electron", "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1180, height: 1200, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code) => {
    const end = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${code}`)
      await pause(50)
    }
  }
  const turn = `document.querySelector('[data-exchange="acp-request-${TURN}"]')`
  const settledAnimations = () => evaluate("Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))).then(() => true)")
  for (const theme of ["dark", "light"]) {
    nativeTheme.themeSource = theme
    await window.loadURL(process.env.MAKO_WORK_URL)
    await until("Boolean(document.querySelector('.composer-input'))")
    await evaluate(`import("/src/state/prefs.ts").then(({ setPref, bindTheme }) => (setPref("theme", ${JSON.stringify(theme)}), bindTheme(), true))`)
    for (const scene of SCENES) {
      await evaluate(PUBLISH(scene, process.env.MAKO_WORK_CUT))
      await until(`Boolean(${turn})`)
      await evaluate("document.fonts.ready.then(() => true)")
      if (scene === "steps") await evaluate(`(${turn}.querySelector('[data-live-step] button[aria-expanded], [data-work-summary]')).click(), true`)
      if (scene === "agents-open") await evaluate(`(${turn}.querySelector('[data-agent-group] > button')).click(), true`)
      if (scene === "opened") await evaluate(`(${turn}.querySelector('[data-turn-fold] > button')).click(), true`)
      await pause(700)
      await settledAnimations()
      await evaluate(`${turn}.scrollIntoView({ block: "end" }), true`)
      await pause(300)
      const box = await evaluate(`(() => { const r = ${turn}.getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.x) - 20), y: Math.max(0, Math.floor(r.y) - 16), width: Math.ceil(r.width) + 40, height: Math.min(window.innerHeight - Math.max(0, Math.floor(r.y) - 16), Math.ceil(r.height) + 32) } })()`)
      const words = await evaluate(`${turn}.innerText.replace(/\\s+/g, " ").slice(0, 400)`)
      console.log(`${scene}-${theme}: ${words}`)
      await writeFile(join(out, `${prefix}${scene}-${theme}.png`), (await page.capturePage(box)).toPNG())
    }
  }
  app.exit(0)
}
