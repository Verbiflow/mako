import { AsyncLocalStorage } from "node:async_hooks"

const clients = new AsyncLocalStorage<{ id: string; history: boolean; correlationId?: string }>()

export function hostClient(): string {
  return clients.getStore()?.id ?? "app"
}

export function hostHistoryPaging(): boolean { return clients.getStore()?.history ?? false }

/** The call this code runs for, as its caller and every hop between logged it; absent outside a call. */
export function hostCorrelation(): string | undefined { return clients.getStore()?.correlationId }

export function withHostClient<Result>(id: string, run: () => Result, history = false, correlationId?: string): Result {
  return clients.run({ id, history, correlationId }, run)
}
