import { stat } from "node:fs/promises"
import type { AgentHost, TabServices } from "./agent-host.js"
import { HostPool } from "./pool.js"
import type { HostEvent } from "../contracts/host-events-boot.js"

export class WorkspaceClients {
  private readonly pools = new Map<string, HostPool>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly emit: (event: HostEvent, client?: string) => void
  private readonly services: TabServices
  private homeFolder: string | undefined

  constructor(emit: (event: HostEvent, client?: string) => void, services: TabServices) {
    this.emit = emit
    this.services = services
  }

  async ready(id: string): Promise<HostPool> {
    let pool = this.pools.get(id)
    if (!pool) {
      if (this.pools.size >= 128) throw new Error("Too many workspace clients are open")
      pool = new HostPool((event) => this.emit(event, id), this.services, () => this.homeFolder)
      this.pools.set(id, pool)
    }
    let starting = this.starting.get(id)
    if (!starting) {
      starting = pool.ensure().then(() => {}).finally(() => this.starting.delete(id))
      this.starting.set(id, starting)
    }
    await starting
    return pool
  }

  /**
   * The folder every client works in from now on: a client's first tab opens there, and a client
   * already open gets a tab there in front. A cloud machine's is its Thread's repository, so every
   * caller through the gateway, each a client of its own, starts in it.
   */
  async home(path: string): Promise<void> {
    if (!(await stat(path)).isDirectory()) throw new Error(`${path} isn't a folder`)
    this.homeFolder = path
    await Promise.all([...this.pools.keys()].map(async (id) => {
      const pool = await this.ready(id)
      if (pool.active.workspace !== path) await pool.open({ cwd: path })
    }))
  }

  /** The folder every client works in, once one was given (`home`). */
  homePath(): string | undefined {
    return this.homeFolder
  }

  /** A client's tabs, if it opened any; asking opens none. */
  opened(id: string): HostPool | undefined {
    return this.starting.has(id) ? undefined : this.pools.get(id)
  }

  /** Every client's every tab. */
  everyTab(): AgentHost[] {
    return [...this.pools.values()].flatMap((pool) => [...pool.tabs])
  }

  async release(id: string): Promise<void> {
    await this.starting.get(id)
    const pool = this.pools.get(id)
    this.pools.delete(id)
    await pool?.dispose()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.pools.keys()].map((id) => this.release(id)))
  }
}
