import { hostLog, hostWarn } from "../base/host-log.js"
import type { McpSignIn, McpSignIns as McpSignInsReading } from "../contracts/mcp-sign-ins.js"
import type { McpLogin } from "./mcp-source.js"
import type { MethodTable } from "../base/methods.js"

/** What a session reported of one MCP server that didn't start (`mcpSetupFailures`). */
export interface McpSetupFailure {
  harness: string
  server: string
  /** The shared words (`mcpServerFailedEvent`): "sign-in required", "could not connect", … */
  reason: string
}

export interface McpSignInsDeps {
  /** How a harness signs one of its servers in, if it says. */
  login(harness: string, server: string): McpLogin | undefined
  /** Runs a harness's own command for it (`ProviderMcpSource.command` with the login's arguments); resolves once it exits 0. */
  run(harness: string, args: string[]): Promise<void>
  emit(reading: McpSignInsReading): void
  now?(): number
  /** Runs `run` after `ms` on an unreferenced timer, and returns its cancel; a test passes its own clock. */
  after?(ms: number, run: () => void): () => void
}

function after(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms)
  timer.unref()
  return () => clearTimeout(timer)
}

/** A line not reported again for this long goes: a harness says it at each session's start, so one still failing is back. */
export const MCP_SIGN_IN_KEPT_MS = 60 * 60_000

/**
 * Every MCP server a harness couldn't start, kept from what sessions report, each with the one thing that fixes it:
 * the harness's own sign-in where it has one, else Settings › MCP. Each is logged when first reported. A sign-in that
 * finishes clears its server; any line not reported again within `MCP_SIGN_IN_KEPT_MS` goes, and is back if the
 * harness reports it again.
 */
export class McpSignIns {
  readonly #servers = new Map<string, McpSignIn>()
  readonly #expiries = new Map<string, () => void>()
  readonly #deps: McpSignInsDeps

  constructor(deps: McpSignInsDeps) {
    this.#deps = deps
  }

  snapshot(): McpSignInsReading {
    return { servers: [...this.#servers.values()].sort((left, right) => left.server.localeCompare(right.server)) }
  }

  /** A session reported a server that didn't start. */
  reported(failure: McpSetupFailure): void {
    const key = `${failure.harness}\0${failure.server}`
    const login = failure.reason === "sign-in required" ? this.#deps.login(failure.harness, failure.server) : undefined
    const known = this.#servers.get(key)
    // One under way or that just failed keeps its state; a report says only that it's still needed.
    const next: McpSignIn = {
      harness: failure.harness,
      server: failure.server,
      reason: failure.reason,
      way: login?.kind ?? "settings",
      ...login?.kind === "page" && { url: login.url },
      ...known?.state && { state: known.state },
      reportedAt: this.#now(),
    }
    this.#servers.set(key, next)
    this.#expire(key)
    if (known?.reason === next.reason && known.way === next.way) return
    hostWarn("mcp", "a server didn't start", { harness: failure.harness, server: failure.server, reason: failure.reason, way: next.way })
    this.#emit()
  }

  /** Stops the lines' timers, with the host. */
  close(): void {
    for (const cancel of this.#expiries.values()) cancel()
    this.#expiries.clear()
  }

  /**
   * Signs a server in its harness's own way. A command runs here and the server clears once it exits 0; a page is
   * opened by the window, which says so, and the server clears then: if the harness still can't reach it, its next
   * session says so again.
   */
  async signIn(harness: string, server: string): Promise<McpSignInsReading> {
    const key = `${harness}\0${server}`
    const known = this.#servers.get(key)
    const login = known?.way === "settings" ? undefined : this.#deps.login(harness, server)
    if (!known || !login) return this.snapshot()
    if (login.kind === "page") {
      this.#servers.delete(key)
      this.#expiries.get(key)?.()
      this.#expiries.delete(key)
      hostLog("mcp", "a server's sign-in page was opened", { harness, server })
      this.#emit()
      return this.snapshot()
    }
    if (known.state?.kind === "signing-in") return this.snapshot()
    this.#servers.set(key, { ...known, state: { kind: "signing-in" } })
    this.#emit()
    void this.#deps.run(harness, login.args).then(
      () => {
        hostLog("mcp", "a server was signed in", { harness, server })
        this.#servers.delete(key)
        this.#expiries.get(key)?.()
        this.#expiries.delete(key)
        this.#emit()
      },
      (error: Error) => {
        hostWarn("mcp", "a server's sign-in didn't finish", { harness, server, error: error.message })
        const still = this.#servers.get(key)
        if (still) this.#servers.set(key, { ...still, state: { kind: "failed", reason: "The sign-in didn't finish." } })
        this.#emit()
      },
    )
    return this.snapshot()
  }

  #expire(key: string): void {
    this.#expiries.get(key)?.()
    const cancel = (this.#deps.after ?? after)(MCP_SIGN_IN_KEPT_MS, () => {
      this.#expiries.delete(key)
      if (this.#servers.delete(key)) this.#emit()
    })
    this.#expiries.set(key, cancel)
  }

  #emit(): void {
    this.#deps.emit(this.snapshot())
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }
}

/** `mako:mcp-sign-ins` reads the servers that didn't start; `mako:mcp-sign-in` signs one in its harness's way. */
export function declareMcpSignInMethods(methods: MethodTable, signIns: McpSignIns): void {
  methods.handle("mako:mcp-sign-ins", () => signIns.snapshot())
  methods.handle("mako:mcp-sign-in", (harness: string, server: string) => signIns.signIn(harness, server))
}
