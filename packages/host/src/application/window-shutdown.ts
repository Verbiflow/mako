import { randomUUID } from "node:crypto"

interface PendingShutdown {
  id: string
  clients: Set<string>
  promise: Promise<void>
  complete(): void
}

export class WindowShutdown {
  private pending: PendingShutdown | null = null
  private completed: { id: string; clients: Set<string> } | null = null
  private readonly timeoutMs: number
  constructor(timeoutMs = 15_000) {
    this.timeoutMs = timeoutMs
  }

  request(clients: string[], send: (id: string) => void): Promise<void> {
    if (this.pending) return this.pending.promise
    if (!clients.length) return Promise.resolve()
    const id = randomUUID()
    let complete = () => {}
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(
          new Error(
            "A Mako window could not save and close safely. Nothing was installed. Check the other windows and try again."
          )
        )
      }, this.timeoutMs)
      complete = () => {
        clearTimeout(timer)
        this.completed = { id, clients: new Set(clients) }
        this.pending = null
        resolve()
      }
    })
    this.pending = { id, clients: new Set(clients), promise, complete }
    send(id)
    return promise
  }

  acknowledge(id: string, client: string): boolean {
    if (this.completed?.id === id) return this.completed.clients.has(client)
    if (this.pending?.id !== id || !this.pending.clients.has(client))
      return false
    this.pending.clients.delete(client)
    if (!this.pending.clients.size) this.pending.complete()
    return true
  }
}
