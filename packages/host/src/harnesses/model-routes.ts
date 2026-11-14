import type { ModelRoute, ModelRoutesCapability } from "../contracts/model-routes.js"

/** The routes a launch takes, and each one's key, opened by the host for this launch alone. */
export interface RoutedLaunch {
  routes: readonly ModelRoute[]
  /** The key `route.credential` names, or undefined for a route with none. */
  key(route: ModelRoute): string | undefined
}

/**
 * A harness's model routes as its driver declares them: an `accepts` adapter
 * turns a launch's routes into the harness's own configuration, in the
 * environment it launches with, on every start and discovery.
 */
export type ModelRouteAdapter =
  | (Extract<ModelRoutesCapability, { kind: "accepts" }> & {
    apply(env: NodeJS.ProcessEnv, launch: RoutedLaunch): NodeJS.ProcessEnv
    /** The id the harness lists a connection's model under, so a Fin can be moved onto it (`contracts/fin-fallback.ts`). */
    model?(connection: string, model: string): string
  })
  | Exclude<ModelRoutesCapability, { kind: "accepts" }>

/** The declaration alone, as a window reads it. */
export function declaredModelRoutes(adapter: ModelRouteAdapter): ModelRoutesCapability {
  if (adapter.kind !== "accepts") return adapter
  const { kind, wires, kinds, via } = adapter
  return { kind, wires, kinds, via }
}
