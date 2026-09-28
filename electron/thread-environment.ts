import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { connect } from "node:net"
import { basename, join } from "node:path"
import type { ThreadId } from "./contracts/thread-identity.js"
import { worktreeSlug } from "./contracts/thread-worktrees.js"
import {
  THREAD_HOST_SUFFIX,
  THREAD_PORT_COUNT,
  THREAD_PORT_FIRST,
  THREAD_PORT_LAST,
  type ThreadEnvironment,
  type ThreadEnvironmentValues,
} from "./contracts/thread-environments.js"
import type { ThreadStore } from "./thread-store.js"

const VARIABLES = ["MAKO_THREAD_ID", "MAKO_THREAD_HOST", "MAKO_THREAD_PORT", "MAKO_THREAD_PORTS", "MAKO_THREAD_URL", "MAKO_THREAD_DATA_DIR"] as const
/** A Thread unused this long gives its ports to a new one when every block is held. */
const RECLAIM_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const CLAIM_ATTEMPTS = 3
const PROBE_TIMEOUT_MS = 250
const HOST_LABEL_LENGTH = 40

/**
 * Sets a Thread's values on an agent process's environment, and clears ones
 * inherited from a Mako that was itself started from a Thread.
 */
export function applyThreadEnvironment(env: NodeJS.ProcessEnv, environment?: ThreadEnvironment): void {
  for (const name of VARIABLES) delete env[name]
  if (!environment) return
  env.MAKO_THREAD_ID = environment.thread
  env.MAKO_THREAD_HOST = environment.host
  env.MAKO_THREAD_PORT = String(environment.port)
  env.MAKO_THREAD_PORTS = String(environment.ports)
  env.MAKO_THREAD_URL = threadUrl(environment)
  env.MAKO_THREAD_DATA_DIR = environment.dataDir
}

/** One line for the note sent with each prompt; it names only what the process was started with. */
export function threadEnvironmentInstructions(environment: ThreadEnvironment): string {
  const last = environment.port + environment.ports - 1
  return `This Thread's own values, already in your shell's environment: ports ${environment.port}-${last} (MAKO_THREAD_PORT, MAKO_THREAD_PORTS), host ${environment.host} (${threadUrl(environment)} is MAKO_THREAD_URL; the name keeps this Thread's cookies apart), and a private data folder (MAKO_THREAD_DATA_DIR). Run anything you start for this Thread on those ports. Other Threads' agents share this machine: never stop a process you didn't start, and if the project needs a fixed port that is taken, say so instead.`
}

function threadUrl(environment: ThreadEnvironment): string {
  return `http://${environment.host}:${environment.port}`
}

export interface ThreadEnvironmentDependencies {
  store: ThreadStore
  /** Threads' data folders, one per Thread ID. */
  dataRoot: string
  /** Whether anything accepts connections on a local port. */
  listening?: (port: number) => Promise<boolean>
  now?: () => number
}

/**
 * Hands each Thread the values that keep its running app apart from other
 * Threads' on this device, and keeps them for the Thread's life.
 */
export class ThreadEnvironments {
  private readonly launched = new Map<string, ThreadEnvironment>()
  private readonly dependencies: ThreadEnvironmentDependencies
  private readonly listening: (port: number) => Promise<boolean>
  private readonly now: () => number

  constructor(dependencies: ThreadEnvironmentDependencies) {
    this.dependencies = dependencies
    this.listening = dependencies.listening ?? portListening
    this.now = dependencies.now ?? Date.now
  }

  /** The values a conversation's agent process starts with. `title` names the host of a Thread that has no title yet. */
  async forLaunch(conversationId: string, title?: string): Promise<ThreadEnvironment | undefined> {
    const { store } = this.dependencies
    const placed = store.journalPlacement(conversationId)
    if (!placed) {
      this.launched.delete(conversationId)
      return undefined
    }
    const values = store.useEnvironment(placed.thread) ?? await this.claim(placed.thread, title)
    const environment: ThreadEnvironment = {
      thread: values.thread,
      host: values.host,
      port: values.port,
      ports: THREAD_PORT_COUNT,
      dataDir: join(this.dependencies.dataRoot, values.thread),
    }
    await mkdir(environment.dataDir, { recursive: true, mode: 0o700 })
    this.launched.set(conversationId, environment)
    return environment
  }

  /** What the conversation's running agent process was started with. */
  launchedWith(conversationId: string): ThreadEnvironment | undefined {
    return this.launched.get(conversationId)
  }

  private async claim(thread: ThreadId, title: string | undefined): Promise<ThreadEnvironmentValues> {
    const { store } = this.dependencies
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const held = store.heldEnvironments()
      const host = this.chooseHost(thread, title, new Set(held.map((values) => values.host)))
      const heldPorts = new Set(held.map((values) => values.port))
      let port: number | undefined
      for (let base = THREAD_PORT_FIRST; base + THREAD_PORT_COUNT - 1 <= THREAD_PORT_LAST && port === undefined; base += THREAD_PORT_COUNT)
        if (!heldPorts.has(base) && !(await this.blockBusy(base))) port = base
      let reclaim: ThreadId | undefined
      if (port === undefined) {
        const cutoff = this.now() - RECLAIM_AFTER_MS
        for (const stale of held) {
          if (stale.usedAt >= cutoff) break
          if (await this.blockBusy(stale.port)) continue
          port = stale.port
          reclaim = stale.thread
          break
        }
      }
      if (port === undefined)
        throw new Error("Every block of ports for Threads on this Mac is held by a Thread used in the last week")
      const claimed = store.claimEnvironment({ thread, host, port, reclaim })
      if (claimed) return claimed
    }
    throw new Error("Other Mako hosts kept taking the ports chosen for this Thread")
  }

  private chooseHost(thread: ThreadId, title: string | undefined, held: ReadonlySet<string>): string {
    const { store } = this.dependencies
    const worktree = store.worktrees().find((candidate) => candidate.thread === thread)
    const named = worktree ? hostLabel(basename(worktree.path)) : hostLabel(worktreeSlug(store.thread(thread)?.title ?? title))
    const label = named && named !== "thread" ? named : `t-${thread.slice(0, 8)}`
    const candidates = Array.from({ length: 50 }, (_, index) => index === 0 ? label : `${label}-${index + 1}`)
    candidates.push(`${label}-${randomUUID().slice(0, 6)}`)
    const free = candidates.find((candidate) => !held.has(`${candidate}${THREAD_HOST_SUFFIX}`))
    if (!free) throw new Error(`Every hostname for this Thread is taken: ${label}${THREAD_HOST_SUFFIX}`)
    return `${free}${THREAD_HOST_SUFFIX}`
  }

  private async blockBusy(base: number): Promise<boolean> {
    const ports = Array.from({ length: THREAD_PORT_COUNT }, (_, index) => base + index)
    return (await Promise.all(ports.map((port) => this.listening(port)))).some(Boolean)
  }
}

/** A DNS label: lowercase letters, digits and inner hyphens. */
function hostLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, HOST_LABEL_LENGTH).replace(/^-+|-+$/g, "")
}

/** Something listening on either loopback address counts. Loopback refuses at once when nothing listens, so a probe with no answer counts as busy. */
async function portListening(port: number): Promise<boolean> {
  const answers = await Promise.all(["127.0.0.1", "::1"].map((host) => new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    const done = (listening: boolean) => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(true))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })))
  return answers.some(Boolean)
}
