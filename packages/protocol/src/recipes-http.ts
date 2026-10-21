import { z } from "zod"
import { gatewayCalls, type GatewayHttpOptions } from "./gateway-http.js"
import {
  RecipeChangesSchema,
  RecipePublishedSchema,
  RecipeVersionRecordSchema,
  type RecipeAuthority,
} from "./recipes.js"

/**
 * A project's recipe authority over a gateway's routes: a device's `/v1/recipes?repository=<url>` (its account's
 * project for that repository), or a machine's `/v1/machines/<name>/recipes` (its Thread's). Every call is safe to
 * repeat: a save carries its own id, a publish names the version it publishes, and the rest read or record.
 */
export function recipesOverHttp(options: GatewayHttpOptions & { repository?: string }): RecipeAuthority {
  const call = gatewayCalls(options)
  const at = (path: string) => (options.repository ? `${path}?${new URLSearchParams({ repository: options.repository }).toString()}` : path)
  return {
    id: options.id,
    async changes(after) {
      const query = new URLSearchParams({ after: String(after) })
      if (options.repository) query.set("repository", options.repository)
      return RecipeChangesSchema.parse(await (await call(`/changes?${query.toString()}`)).json())
    },
    async save(save) {
      return RecipeVersionRecordSchema.parse(await (await call(at("/save"), { method: "POST", json: save })).json())
    },
    async publish(publish) {
      return RecipePublishedSchema.parse(await (await call(at("/publish"), { method: "POST", json: publish })).json())
    },
    async prove(prove) {
      return RecipeVersionRecordSchema.parse(await (await call(at("/prove"), { method: "POST", json: prove })).json())
    },
    async adopt(adopt) {
      return z.object({ adopted: z.boolean() }).parse(await (await call(at("/adopt"), { method: "POST", json: adopt })).json())
    },
  }
}
