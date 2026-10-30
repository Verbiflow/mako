import type { GatewayCallLog } from "@mako/host/contracts/gateway-host-calls"
import { z } from "zod"
import { createHook, createStore } from "@/state/store"

/**
 * What this browser last heard reaching each place it asks: Mako Cloud itself (`CLOUD`), each Mac by its runtime
 * (`d-<device>`), each cloud Thread (`thread:<id>`). A call that went through says the place answers; one refused as
 * not connected, lost on the way, or unanswered in time says it didn't, with the correlation ID its hops logged it
 * under. Nothing heard yet is unknown, never off. The diagnosis reads it (`diagnosis.ts`).
 */
export interface Reached {
  at: number
  ok: boolean
  /** The gateway's word for why not (`owner-unavailable`, `timeout`, …). */
  outcome?: string
  correlationId?: string
  message?: string
}

export const CLOUD = "cloud"

export const reachStore = createStore<{ places: ReadonlyMap<string, Reached> }>({ places: new Map() })
export const useReach = createHook(reachStore)

function note(place: string, reached: Reached): void {
  const places = new Map(reachStore.get().places)
  places.set(place, reached)
  reachStore.set({ places })
}

/** A place answered. */
export function answered(place: string, at = Date.now()): void {
  const held = reachStore.get().places.get(place)
  if (held?.ok) return
  note(place, { at, ok: true })
}

/** A place didn't answer: why, in the gateway's word, and under which correlation ID. */
export function unanswered(place: string, failure: Omit<Reached, "ok" | "at">, at = Date.now()): void {
  note(place, { at, ok: false, ...failure })
}

/** What a call's log line says of it (`gatewayHostCalls`), as far as a place's reach reads it. */
const CallFieldsSchema = z.object({ outcome: z.string().optional(), correlationId: z.string().optional(), error: z.string().optional() }).loose()

/** The key a Mac's runtime is kept under. */
export const macPlace = (deviceId: string) => `d-${deviceId}`
/** The key a cloud Thread is kept under. */
export const threadPlace = (threadId: string) => `thread:${threadId}`

/**
 * The log one place's host calls go through (`gatewayHostCalls`): the console's, and each call the gateway refused or
 * lost kept as that place's last word, with its correlation ID, until a call answers.
 */
export function reachLog(place: string): GatewayCallLog {
  return {
    warn(message, fields) {
      console.warn(`[mako] ${message}`, fields)
      if (message !== "operation failed" && message !== "operation lost") return
      const said = CallFieldsSchema.parse(fields)
      const outcome = message === "operation lost" ? "lost" : said.outcome
      // A refusal of the call itself ("failed", a harness's own error) says the place answered.
      if (outcome === "failed") return answered(place)
      unanswered(place, { ...(outcome && { outcome }), ...(said.correlationId && { correlationId: said.correlationId }), message: said.error ?? message })
    },
    info: (message, fields) => console.info(`[mako] ${message}`, fields),
  }
}

/** A call's answer, or `undefined` once `ms` went by without one: a place that never answers is said to, in time. */
export async function within<Value>(call: Promise<Value>, ms: number): Promise<{ value: Value } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([call.then((value) => ({ value })), late])
  } finally {
    clearTimeout(timer)
  }
}
