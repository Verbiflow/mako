import { HostPool } from "./pool.js"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"

export class WorkspaceClients {
  private readonly pools = new Map<string, HostPool>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly emit: (event: HostEvent, client?: string) => void

  constructor(emit: (event: HostEvent, client?: string) => void) {
    this.emit = emit
  }

  async ready(id: string): Promise<HostPool> {
    let pool = this.pools.get(id)
    if (!pool) {
      if (this.pools.size >= 128) throw new Error("Too many workspace clients are open")
      pool = new HostPool((event) => this.emit(event, id))
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
