import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { AGENT_VIEWS_ENV } from "./contracts/desktop-channel.js"
import type { DesktopChannel } from "./desktop-channel.js"
import { hostLog, hostWarn } from "./host-log.js"

/** Electron starts, loads the desktop's main process and attaches in about a second; this allows for a cold, busy machine. */
const ATTACH_TIMEOUT_MS = 30_000

export const NO_DESKTOP_WINDOWS = "Open Mako's desktop app to let agents open Mako's own windows."

/** How to start Mako's desktop executable for this host, or nothing on a machine without one. */
export interface AgentViewsLaunch {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Where the app writes its log, for a failure to name. */
  log: string
}

export interface AgentViewsOptions {
  channel: DesktopChannel
  launch(): AgentViewsLaunch | undefined
}

/**
 * The windows agents drive when no desktop app is open: a desk in a browser
 * tab, or a fixture desk a test started. The host starts Mako's own desktop
 * executable as the agent views app, with no Dock icon and no window of its
 * own. It attaches to `/desktop` as `agent-views` and makes the hidden desk
 * windows exactly as the desktop would, so the desk browser drives one kind
 * of page either way. It answers nothing about the person's Mac.
 *
 * It ends itself when it has had no window for a minute, when the host
 * leaves, and when a person's desktop opens and takes the channel; the host
 * stops it as it closes. With no desktop executable, as on a cloud machine
 * whose image has none, agents read that Mako's own windows need one.
 */
export class AgentViewsApp {
  private readonly channel: DesktopChannel
  private readonly launch: () => AgentViewsLaunch | undefined
  private child: ChildProcess | undefined
  private starting: Promise<void> | undefined
  private closed = false

  constructor({ channel, launch }: AgentViewsOptions) {
    this.channel = channel
    this.launch = launch
  }

  /** A desktop answers for desk windows: the one attached, or this app once it has attached. */
  ready(): Promise<void> {
    if (this.channel.answers("desk-page-create")) return Promise.resolve()
    if (this.closed) return Promise.reject(new Error("The host is closing."))
    this.starting ??= this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  close(): void {
    this.closed = true
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM")
  }

  private async start(): Promise<void> {
    const launch = this.launch()
    if (!launch) throw new Error(NO_DESKTOP_WINDOWS)
    // One still starting after an earlier attempt gave up waiting gets the new deadline, not a twin; it ends itself if it never attaches.
    const child = this.child && this.child.exitCode === null && this.child.signalCode === null ? this.child : this.spawn(launch)
    this.child = child
    const deadline = Date.now() + ATTACH_TIMEOUT_MS
    while (!this.channel.answers("desk-page-create")) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Mako's agent views app quit before it could open a window (${child.signalCode ?? `exit ${child.exitCode}`}). See ${launch.log}.`)
      if (Date.now() > deadline) throw new Error(`Mako's agent views app didn't attach to the host in 30 seconds. See ${launch.log}.`)
      await delay(50)
    }
  }

  private spawn(launch: AgentViewsLaunch): ChildProcess {
    const child = spawn(launch.executable, launch.args, { env: { ...launch.env, [AGENT_VIEWS_ENV]: "1" }, stdio: "ignore" })
    hostLog("desktop", "agent views app started", { pid: child.pid ?? 0 })
    child.once("error", (error) => hostWarn("desktop", "agent views app didn't start", { reason: error.message }))
    child.once("exit", (code, signal) => hostLog("desktop", "agent views app left", { pid: child.pid ?? 0, exit: signal ?? `exit ${code}` }))
    return child
  }
}
