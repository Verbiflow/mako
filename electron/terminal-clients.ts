import { TerminalDaemonClient } from "./terminal-client.js"
import type { TerminalEvent, TerminalSession } from "./contracts/terminal.js"

/** Each window owns its attachments and acknowledgements; shells belong to the daemon. */
export class TerminalClients {
  readonly #clients = new Map<string, TerminalDaemonClient>()
  readonly #entry: string
  readonly #stateDir: string
  readonly #emit: (event: TerminalEvent, owner: string) => void
  readonly #build: string | undefined

  constructor(
    entry: string,
    stateDir: string,
    emit: (event: TerminalEvent, owner: string) => void,
    build?: string
  ) {
    this.#entry = entry
    this.#stateDir = stateDir
    this.#emit = emit
    this.#build = build
  }

  forOwner(owner: string): TerminalDaemonClient {
    let client = this.#clients.get(owner)
    if (!client) {
      client = new TerminalDaemonClient(
        this.#entry,
        this.#stateDir,
        (event) => this.#emit(event, owner),
        this.#build
      )
      this.#clients.set(owner, client)
    }
    return client
  }

  /** The daemon's running shells, read through any window's connection; none while no window has one. */
  async runningShells(): Promise<TerminalSession[]> {
    const client = this.#clients.values().next().value
    if (!client) return []
    return (await client.list()).filter((session) => session.status === "running")
  }

  release(owner: string): void {
    this.#clients.get(owner)?.dispose()
    this.#clients.delete(owner)
  }

  dispose(): void {
    for (const owner of this.#clients.keys()) this.release(owner)
  }
}
