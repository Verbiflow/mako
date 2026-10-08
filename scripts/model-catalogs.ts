import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { SessionModelSchema, type ModelOption, type SessionModel } from "@mako/sessions/settings"

/**
 * Each harness's model catalog as Mako discovered it, one file per harness:
 * what its defaults are held to (`test-model-defaults.ts`) and what the
 * capability audit reports. `npm run harness:catalogs` records them.
 */
export const MODEL_CATALOG_ROOT = join(import.meta.dirname, "fixtures", "model-catalogs")

export const RecordedCatalogSchema = z.object({
  harness: z.string(),
  /** The day it was recorded. */
  recorded: z.string(),
  /** The harness's version when it was recorded, when it reports one. */
  version: z.string().optional(),
  models: z.array(SessionModelSchema),
})
export type RecordedCatalog = z.infer<typeof RecordedCatalogSchema>

export function catalogPath(harness: string): string {
  return join(MODEL_CATALOG_ROOT, `${harness}.json`)
}

export function recordedCatalog(harness: string): RecordedCatalog | undefined {
  const path = catalogPath(harness)
  if (!existsSync(path)) return undefined
  return RecordedCatalogSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

/** A catalog without the values an account or session has chosen, which differ per machine. */
export function recordable(models: readonly SessionModel[]): SessionModel[] {
  return models.map((model) => ({ ...model, options: model.options.map(unchosen) }))
}

function unchosen(option: ModelOption): ModelOption {
  const { current: _current, ...rest } = option
  return rest.kind === "select" ? { ...rest, values: rest.values.map(({ default: _default, ...value }) => value) } : rest
}
