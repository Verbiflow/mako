import { TerminalDaemonClient } from "./terminal-client.js"
import type { TerminalEvent } from "./contracts/terminal.js"

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

  release(owner: string): void {
    this.#clients.get(owner)?.dispose()
    this.#clients.delete(owner)
  }

  dispose(): void {
    for (const owner of this.#clients.keys()) this.release(owner)
  }
}
