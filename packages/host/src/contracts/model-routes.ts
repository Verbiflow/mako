import type { ConnectionCredential, ModelConnectionKind } from "./model-connections.js"

/**
 * The model-route part of the layering contract: what a launch receives of
 * the person's model connections, the same for every harness. Each harness
 * declares what it takes (`ModelRoutesCapability`), and its adapter turns the
 * routes it takes into its own configuration; nothing outside an adapter
 * knows how a harness is configured.
 */

/** The API a route's endpoint speaks. */
export type ModelWire = "anthropic" | "openai-chat" | "openai-responses"

export const MODEL_WIRES: readonly ModelWire[] = ["anthropic", "openai-chat", "openai-responses"]

/** One model of one connection, as a launch receives it. */
export interface ModelRoute {
  connection: string
  /** The connection as the person named it ("OpenRouter"), for a harness's own picker. */
  connectionName: string
  kind: ModelConnectionKind
  wire: ModelWire
  /** Where the endpoint is; a subscription's harness knows its own. */
  baseUrl?: string
  model: string
  /** The model's name and context limit, as its endpoint listed them. */
  name?: string
  contextTokens?: number
  /** Where the key is kept, never the key: the host opens it for the adapter alone. */
  credential: ConnectionCredential | null
}

/**
 * Which routes a harness takes, declared in the style of `nativeRouting`:
 * `accepts` is implemented and put to work on every launch; `planned` names
 * the harness's own way in that no adapter uses yet; `absent` says why none
 * exists.
 */
export type ModelRoutesCapability =
  | { kind: "accepts"; wires: readonly ModelWire[]; kinds: readonly ModelConnectionKind[]; via: string }
  | { kind: "planned"; wires: readonly ModelWire[]; via: string }
  | { kind: "absent"; reason: string }

/** Whether `capability` puts a connection of `kind` speaking `wire` to work. */
export function routeAccepted(capability: ModelRoutesCapability, kind: ModelConnectionKind, wire: ModelWire): boolean {
  return capability.kind === "accepts" && capability.wires.includes(wire) && capability.kinds.includes(kind)
}

/** A harness's declaration, as Settings reads it beside the connections. */
export interface HarnessModelRoutes {
  harness: string
  routes: ModelRoutesCapability
}
