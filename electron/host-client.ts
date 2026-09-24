import { AsyncLocalStorage } from "node:async_hooks"

const clients = new AsyncLocalStorage<{ id: string; history: boolean }>()

export function hostClient(): string {
  return clients.getStore()?.id ?? "app"
}

export function hostHistoryPaging(): boolean { return clients.getStore()?.history ?? false }

export function withHostClient<Result>(id: string, run: () => Result, history = false): Result {
  return clients.run({ id, history }, run)
}
