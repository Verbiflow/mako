import type { OpenCode } from "@opencode/client"

/** What the probe asks of a server's API: the sessions it has running. */
export interface OpenCodeServerApi {
  session: Pick<ReturnType<typeof OpenCode.make>["session"], "active">
}

/** A server's place among this host's, from its spawn. */
export interface OpenCodeServer {
  /** Its API is up, so it can say what it runs. */
  answers(api: OpenCodeServerApi): void
  exited(): void
}

/**
 * The `opencode serve --stdio` processes this host runs: one per open
 * conversation, and one while it reads the model catalog. They publish no
 * service registration, so the activity probe asks each what it is running
 * instead of counting it as an executor it can't see into, which would hold
 * every other OpenCode session from waking while any one is open.
 */
export class OpenCodeServers {
  private readonly running = new Map<number, OpenCodeServerApi | undefined>()

  /** A server from its spawn until it exits; it answers for itself once its API is up. */
  add(pid: number): OpenCodeServer {
    this.running.set(pid, undefined)
    return {
      answers: (api) => { if (this.running.has(pid)) this.running.set(pid, api) },
      exited: () => { this.running.delete(pid) },
    }
  }

  /**
   * The sessions each server is running, by its process. One whose API isn't
   * up yet has opened none, since Mako opens a session only through it. One
   * that doesn't say is left out, so the probe counts it as unknown.
   */
  async activity(signal: AbortSignal): Promise<Array<{ pid: number; sessions: string[] }>> {
    const servers = await Promise.all([...this.running].map(async ([pid, api]) => {
      if (!api) return { pid, sessions: [] }
      try {
        return { pid, sessions: Object.keys(await api.session.active({ signal })) }
      } catch {
        return undefined
      }
    }))
    return servers.filter((server) => server !== undefined)
  }
}
