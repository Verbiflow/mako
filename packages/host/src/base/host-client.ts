import { AsyncLocalStorage } from "node:async_hooks"

const clients = new AsyncLocalStorage<{ id: string; history: boolean; correlationId?: string }>()

export function hostClient(): string {
  return clients.getStore()?.id ?? "app"
}

/** What `gatewayClientId` names a machine runtime's call through the gateway, and what follows `gateway:` in it. */
export const MACHINE_CLIENT = "gateway:runtime:"

/**
 * Whether this call is a machine runtime's, as the gateway stamped it: that is a Thread's work there, never the person,
 * whatever its payload says. Who calls is decided only from that provenance.
 */
export function machineCall(client = hostClient()): boolean {
  return client.startsWith(MACHINE_CLIENT)
}

/** A person-only call's refusal for a machine: its words, the same at every door that refuses it. */
export const NOT_THE_PERSON = "A machine calls as its Thread's agent, never as the person."

export function hostHistoryPaging(): boolean { return clients.getStore()?.history ?? false }

/** The call this code runs for, as its caller and every hop between logged it; absent outside a call. */
export function hostCorrelation(): string | undefined { return clients.getStore()?.correlationId }

export function withHostClient<Result>(id: string, run: () => Result, history = false, correlationId?: string): Result {
  return clients.run({ id, history, correlationId }, run)
}
