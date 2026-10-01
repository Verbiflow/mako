// The fixture desk's stand-in for a Thread's app: `?mock&app=<scenario>`.
// Scenarios: none, invalid, setting-up, stopped, first-run (no ports yet),
// installing, install-failed, running, crashed, check-failed, waiting,
// elsewhere (one copy at a time, running in another Thread: it reads as
// stopped, and Run asks first), and
// demo (a start that installs and runs, then crashes soon after its log is
// opened, as when the agent's edit lands),
// setup (not set up; Set up starts a scripted setup Thread, and the strip
// follows it to a running app), and
// setup-fallback (the same, with Codex chosen for setting up but signed out).
import { toast } from "sonner"
import { setPref } from "@/state/prefs"
import { threadsStore } from "@/state/thread-store"
import type { SetupProgress } from "../../electron/contracts/thread-app"
import {
  installThreadAppDriver,
  putThreadApp,
  threadAppStore,
  type AppOutputKey,
  type ThreadAppView,
} from "@/state/thread-app"

const CWD = "/Users/you/mako"
const HOST = "rail-re-render-audit.thread.localhost"
const PORT = 20140
const MB = 1024 ** 2

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`
const green = (text: string) => `\x1b[32m${text}\x1b[0m`
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`
const red = (text: string) => `\x1b[31m${text}\x1b[0m`
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`
const clock = (offsetMinutes = 0) =>
  dim(new Date(Date.now() - offsetMinutes * 60_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }))

const INSTALL = [
  dim("$ npm install"),
  "npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.",
  "npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported",
  "",
  "added 1412 packages, and audited 1413 packages in 38s",
  "",
  "231 packages are looking for funding",
  `  run ${bold("npm fund")} for details`,
  "",
  `found ${bold(green("0"))} vulnerabilities`,
  "",
]

const START = [
  dim("$ npm run web"),
  "",
  "> mako@0.0.1 web",
  "> node electron/start.mjs --web",
  "",
  `${dim("[electron]")} tsgo -b tsconfig.electron.json`,
  `${dim("[electron]")} built in 3.1 s`,
  "",
  `  ${green(bold("VITE"))} ${green("v7.1.4")}  ready in ${bold("812")} ms`,
  "",
  `  ${green("➜")}  ${bold("Local")}:   ${cyan(`http://${HOST}:${bold(String(PORT))}/`)}`,
  `  ${green("➜")}  ${bold("Data")}:    ${dim("this Thread's own, in ~/.mako/threads/rail-re-render-audit/app")}`,
  "",
]

const EDITS = [
  `${clock(3)} ${cyan("[vite]")} ${green("hmr update")} ${dim("/src/components/rail/session-rail.tsx")}`,
  `${clock(2)} ${cyan("[vite]")} ${green("hmr update")} ${dim("/src/state/session.ts")}`,
  `${clock(1)} ${cyan("[vite]")} ${green("hmr update")} ${dim("/src/components/rail/session-rail.tsx")} ${dim("(x2)")}`,
]

const CRASH = [
  `${clock()} ${cyan("[vite]")} ${green("page reload")} ${dim("electron/dev-renderer-registration.ts")}`,
  `${dim("[electron]")} restarting the host`,
  "file:///Users/you/mako/dist-electron/dev-renderer-registration.js:34",
  '    throw new Error("The development renderer must use a loopback URL");',
  "    ^",
  "",
  red(bold("Error: The development renderer must use a loopback URL")),
  red("    at validate (file:///Users/you/mako/dist-electron/dev-renderer-registration.js:34:11)"),
  red("    at publishDevRendererRegistration (file:///Users/you/mako/dist-electron/dev-renderer-registration.js:52:5)"),
  red("    at file:///Users/you/mako/dist-electron/main.js:1187:3"),
  "",
  "Node.js v24.19.0",
]

const INSTALL_FAIL = [
  dim("$ npm install"),
  `npm ${red("error")} code ERESOLVE`,
  `npm ${red("error")} ERESOLVE unable to resolve dependency tree`,
  `npm ${red("error")}`,
  `npm ${red("error")} While resolving: mako@0.0.1`,
  `npm ${red("error")} Found: react@19.2.0`,
  `npm ${red("error")} Could not resolve dependency:`,
  `npm ${red("error")} peer react@"^18" from @xterm/addon-webgl@0.18.0`,
  "",
]

const QUICK_PASS = [
  dim("$ npm run typecheck && npm run lint"),
  "",
  "> mako@0.0.1 typecheck",
  "> tsgo -b",
  "",
  "> mako@0.0.1 lint",
  "> eslint . && oxlint",
  "",
  `Found ${bold(green("0"))} warnings and ${bold(green("0"))} errors.`,
  green("✓ Quick check passed in 41 s"),
]

const QUICK_FAIL = [
  dim("$ npm run typecheck && npm run lint"),
  "",
  "> mako@0.0.1 typecheck",
  "> tsgo -b",
  "",
  `${cyan("src/components/rail/session-rail.tsx")}:${bold("41")}:${bold("9")} - ${red("error")} ${dim("TS2322:")} Type 'string | undefined' is not assignable to type 'string'.`,
  "",
  `${dim("41")}   const title: string = session.name`,
  `${dim("  ")}           ${red("~~~~~")}`,
  "",
  "",
  `Found 1 error in src/components/rail/session-rail.tsx${dim(":41")}`,
  "",
]

const FULL_PASS = [
  dim("$ npm run test:dev-live"),
  "",
  `${green("✓")} the Thread's address answers ${dim(`http://${HOST}:${PORT}/`)}`,
  `${green("✓")} its host is this Thread's, not the installed app's`,
  `${green("✓")} its Thread store is private ${dim("(~/.mako/threads/rail-re-render-audit/app)")}`,
  `${green("✓")} port 5173 is left alone`,
  "",
  green("✓ Full check passed in 1 min 12 s"),
]

type Ready = Extract<ThreadAppView, { kind: "ready" }>

/** Where the scripted setup Thread has got to, as the host would learn it from Mako's tools. */
export type MockSetupMoment =
  | { at: "started"; conversation: string; title: string; harness: string; cwd: string }
  | { at: "progress"; progress: Partial<SetupProgress> }
  | { at: "done" }

let setupMoment: ((moment: MockSetupMoment) => void) | undefined

export function mockSetupMoment(moment: MockSetupMoment): void {
  setupMoment?.(moment)
}

export function installMockThreadApp(): void {
  const scenario = new URLSearchParams(location.search).get("app")
  if (!scenario) return
  const outputs = new Map<AppOutputKey, string>()
  const listeners = new Map<AppOutputKey, Set<(text: string, reset: boolean) => void>>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let installed = scenario !== "demo"
  let crashes = scenario === "demo"
  let roomMade = false

  const emit = (key: AppOutputKey, lines: string[]) => {
    const chunk = lines.map((line) => `${line}\r\n`).join("")
    outputs.set(key, (outputs.get(key) ?? "") + chunk)
    for (const listener of listeners.get(key) ?? []) listener(chunk, false)
  }
  const reset = (key: AppOutputKey) => {
    outputs.delete(key)
    for (const listener of listeners.get(key) ?? []) listener("", true)
  }
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, ms)
    timers.add(timer)
  }
  const stream = (key: AppOutputKey, lines: string[], ms: number, done: () => void) => {
    lines.forEach((line, index) => later((ms / lines.length) * index, () => emit(key, [line])))
    later(ms, done)
  }
  const cancel = () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  const current = (): Ready => {
    const view = threadAppStore.get().byCwd[CWD]
    return view?.kind === "ready" ? view : ready("stopped")
  }
  const put = (patch: Partial<Ready>) => putThreadApp(CWD, { ...current(), ...patch })

  const running = () =>
    put({ phase: "running", startedAt: Date.now(), prepare: undefined, processes: [{ name: "web", state: "running", port: PORT, memoryBytes: 642 * MB }] })

  const start = () => {
    cancel()
    if (scenario === "waiting" && !roomMade) {
      put({ phase: "waiting", room: { apps: 2, bytes: 2.0 * 1024 ** 3 } })
      return
    }
    if (!installed) {
      reset("prepare")
      put({ phase: "preparing", prepare: { command: "npm install", reason: "package-lock.json changed" }, room: undefined })
      stream("prepare", INSTALL, 2600, () => {
        installed = true
        start()
      })
      return
    }
    reset("process:web")
    put({ phase: "starting", room: undefined, prepare: undefined, processes: [{ name: "web", state: "starting", port: PORT }] })
    stream("process:web", START, 1800, () => {
      running()
      if (crashes) stream("process:web", EDITS, 2400, () => {})
    })
  }

  // The demo's crash lands a moment after someone starts watching the log, as the agent's edit would.
  const crash = () => {
    if (!crashes) return
    crashes = false
    emit("process:web", CRASH)
    put({ phase: "crashed", processes: [{ name: "web", state: "exited", port: PORT, exit: { code: 1, afterMs: 9_000, at: Date.now() } }] })
  }

  const runCheck = (tier: "quick" | "full") => {
    const key = `check:${tier}` as const
    reset(key)
    const lines = tier === "full" ? FULL_PASS : scenario === "check-failed" ? QUICK_FAIL : QUICK_PASS
    const set = (state: "running" | "passed" | "failed") =>
      put({ checks: current().checks.map((check) => (check.tier === tier ? { ...check, state, at: Date.now() } : check)) })
    set("running")
    stream(key, lines, tier === "full" ? 3200 : 2200, () => set(lines === QUICK_FAIL ? "failed" : "passed"))
  }

  installThreadAppDriver({
    start,
    restart: start,
    stop: () => {
      cancel()
      put({ phase: "stopped", processes: [{ name: "web", state: "stopped", port: PORT }] })
    },
    runCheck: (_cwd, tier) => runCheck(tier),
    makeRoom: () => {
      roomMade = true
      toast("Stopped the apps of “Migrate billing to v2” and “Old experiment”. Their files and data stay.")
      start()
    },
    takeTurn: () => {
      put({ elsewhere: undefined })
      start()
    },
    readOutput: async (_cwd, key) => outputs.get(key) ?? "",
    subscribeOutput: (_cwd, key, listener) => {
      if (key === "process:web" && crashes && current().phase === "running") later(3500, crash)
      listener(outputs.get(key) ?? "", true)
      const set = listeners.get(key) ?? new Set()
      set.add(listener)
      listeners.set(key, set)
      return () => set.delete(listener)
    },
  })

  // The project folder's Threads and the setup Thread's worktree see the same setup; once it's done,
  // the worktree's copy runs and the folder's is ready to run.
  let setupCwd: string | undefined
  setupMoment = (moment) => {
    const view = threadAppStore.get().byCwd[CWD]
    const both = (next: ThreadAppView) => {
      putThreadApp(CWD, next)
      if (setupCwd) putThreadApp(setupCwd, next)
    }
    if (moment.at === "started") {
      setupCwd = moment.cwd
      both({
        kind: "setting-up",
        project: "mako",
        root: CWD,
        thread: { title: moment.title, harness: moment.harness, conversation: moment.conversation },
        progress: { recipe: "waiting", app: "waiting", checks: "waiting" },
      })
    } else if (moment.at === "progress" && view?.kind === "setting-up" && view.progress) {
      both({ ...view, progress: { ...view.progress, ...moment.progress } })
    } else if (moment.at === "done") {
      emit("process:web", START)
      emit("check:quick", QUICK_PASS)
      emit("check:full", FULL_PASS)
      const checks: Ready["checks"] = [
        { tier: "quick", command: "npm run typecheck && npm run lint", state: "passed", at: Date.now() },
        { tier: "full", command: "npm run test:dev-live", state: "passed", at: Date.now() },
      ]
      putThreadApp(CWD, { ...ready("stopped"), checks: checks.map((check) => ({ tier: check.tier, command: check.command, state: "never" as const })) })
      const inPlace = setupCwd === CWD
      const port = inPlace ? PORT : PORT + 10
      if (setupCwd)
        putThreadApp(setupCwd, {
          ...ready("running"),
          address: inPlace ? ready("running").address : { host: "mako-set-up.thread.localhost", port },
          startedAt: Date.now(),
          processes: [{ name: "web", state: "running", port, memoryBytes: 642 * MB }],
          checks,
        })
    }
  }

  const minutes = (count: number) => Date.now() - count * 60_000
  switch (scenario) {
    case "setup":
    case "setup-here":
      putThreadApp(CWD, { kind: "none", project: "mako", root: CWD })
      break
    case "setup-fallback":
      setPref("composerHarness", "codex")
      threadsStore.set({ composerHarness: "codex" })
      putThreadApp(CWD, { kind: "none", project: "mako", root: CWD })
      break
    case "none":
      putThreadApp(CWD, { kind: "none", project: "mako", root: CWD })
      break
    case "invalid":
      putThreadApp(CWD, {
        kind: "invalid",
        project: "mako",
        root: CWD,
        message: 'processes.web.port: "{port:12}" is outside the Thread\'s ten ports (0 to 9).',
      })
      break
    case "setting-up":
      putThreadApp(CWD, {
        kind: "setting-up",
        project: "mako",
        root: CWD,
        thread: { title: "Set up the app", harness: "codex", conversation: "mock-setup" },
      })
      break
    case "first-run": {
      const fresh = ready("stopped")
      delete fresh.address
      putThreadApp(CWD, { ...fresh, checks: fresh.checks.map((check) => ({ tier: check.tier, command: check.command, state: "never" as const })) })
      break
    }
    case "install-failed":
      emit("prepare", INSTALL_FAIL)
      putThreadApp(CWD, {
        ...ready("crashed"),
        prepare: { command: "npm install", reason: "package-lock.json changed", exit: { code: 1, at: minutes(0) } },
      })
      break
    case "elsewhere":
      putThreadApp(CWD, { ...ready("stopped"), elsewhere: "the Thread “Migrate billing to v2”" })
      emit("check:quick", QUICK_PASS)
      break
    case "installing":
      emit("prepare", INSTALL.slice(0, 3))
      emit("check:quick", QUICK_PASS)
      putThreadApp(CWD, { ...ready("preparing"), prepare: { command: "npm install", reason: "package-lock.json changed" } })
      break
    case "running":
    case "check-failed":
      emit("process:web", [...START, ...EDITS])
      putThreadApp(CWD, {
        ...ready("running"),
        startedAt: minutes(12),
        processes: [{ name: "web", state: "running", port: PORT, memoryBytes: 642 * MB }],
      })
      if (scenario === "check-failed") {
        emit("check:quick", QUICK_FAIL)
        put({ checks: [{ tier: "quick", command: "npm run typecheck && npm run lint", state: "failed", at: minutes(1) }, { tier: "full", command: "npm run test:dev-live", state: "never" }] })
      } else {
        emit("check:quick", QUICK_PASS)
      }
      break
    case "crashed":
      emit("process:web", [...START, ...EDITS, ...CRASH])
      putThreadApp(CWD, { ...ready("crashed"), processes: [{ name: "web", state: "exited", port: PORT, exit: { code: 1, afterMs: 9_000, at: minutes(0) } }] })
      emit("check:quick", QUICK_PASS)
      break
    default:
      putThreadApp(CWD, ready("stopped"))
      emit("check:quick", QUICK_PASS)
  }

  function ready(phase: Ready["phase"]): Ready {
    return {
      kind: "ready",
      project: "mako",
      phase,
      address: { host: HOST, port: PORT },
      processes: [{ name: "web", state: "stopped", port: PORT }],
      checks: [
        { tier: "quick", command: "npm run typecheck && npm run lint", state: scenario === "demo" ? "never" : "passed", at: minutes(4) },
        { tier: "full", command: "npm run test:dev-live", state: "never" },
      ],
    }
  }
}
