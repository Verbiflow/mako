import { z } from "zod"

/**
 * A project's recipe versions as one authority keeps them: the account, for a project it knows by its repository.
 * Every version, a draft or published, is numbered there, so a laptop and every machine of the account name the same
 * version by the same number; publishing is a compare-and-swap on the version the draft was made from, so two
 * places can't each publish over the other; and each place's proof of a version is kept with it. A store that works
 * with the authority mirrors it (`changes`), so it reads its recipe at once and while offline.
 *
 * The recipe itself is the host's to read: it travels as JSON, at most `RECIPE_WIRE_BYTES`.
 */

export const RECIPE_WIRE_BYTES = 64 * 1024

export const RecipeProofStepSchema = z.object({
  /** Such as `install`, `start`, `verify` or `verify web`. */
  name: z.string().max(100),
  passed: z.boolean(),
  ms: z.number().nonnegative().optional(),
  /** For a step Mako ran. */
  command: z.string().max(4_000).optional(),
  /** For a check the agent made: what it did and saw. */
  how: z.string().max(4_000).optional(),
}).strict()

export const RecipeProofSchema = z.object({
  at: z.number(),
  /** Where it ran, in words: `this Mac`, or `a cloud machine`. */
  on: z.string(),
  /** Which place it proved the version in; none in a proof from before places, which ran on this computer. */
  place: z.enum(["local", "cloud"]).optional(),
  checkout: z.string(),
  by: z.string().max(300).optional(),
  steps: z.array(RecipeProofStepSchema).max(50),
}).strict()
export type RecipeProof = z.infer<typeof RecipeProofSchema>

/** The longest reason a version keeps; a longer one makes the version unreadable. */
export const RECIPE_REASON_MAX = 500

export const RecipeVersionRecordSchema = z.object({
  version: z.number().int().positive(),
  /** The published version it was made from; none for a project's first. */
  parent: z.number().int().positive().optional(),
  state: z.enum(["draft", "published"]),
  savedAt: z.number(),
  /** Who saved it, such as `the Thread "Fix login" (codex)`. */
  by: z.string().max(300).optional(),
  reason: z.string().max(RECIPE_REASON_MAX).optional(),
  /** The app that saved it, the only one that runs it while it's a draft. */
  app: z.string().max(200).optional(),
  recipe: z.unknown(),
  /** The last proof run of it, passed or not, wherever it ran. */
  proof: RecipeProofSchema.optional(),
  /** The last proof in each place: a version proved on this computer and on a cloud machine has both. */
  proofs: z.object({ local: RecipeProofSchema.optional(), cloud: RecipeProofSchema.optional() }).strict().optional(),
  publishedAt: z.number().optional(),
}).strict()
export type RecipeVersionRecord = z.infer<typeof RecipeVersionRecordSchema>

/** What changed at the authority past a store's cursor: the versions saved, published or proved since, oldest first. */
export const RecipeChangesSchema = z.object({
  /** The authority's count of changes; a store asks past it next time. */
  change: z.number().int().nonnegative(),
  published: z.number().int().positive().nullable(),
  versions: z.array(RecipeVersionRecordSchema),
  /** More changed than one answer carries: ask again past `change`. */
  more: z.boolean(),
})
export type RecipeChanges = z.infer<typeof RecipeChangesSchema>

export const RecipeSaveSchema = z.object({
  /** The caller's own id for this save: a repeat of it answers with the version the first made. */
  id: z.uuid(),
  parent: z.number().int().positive().optional(),
  app: z.string().max(200).optional(),
  by: z.string().max(300).optional(),
  reason: z.string().max(RECIPE_REASON_MAX).optional(),
  savedAt: z.number(),
  recipe: z.unknown(),
}).strict()
export type RecipeSave = z.infer<typeof RecipeSaveSchema>

export const RecipePublishSchema = z.object({ version: z.number().int().positive(), proof: RecipeProofSchema, publishedAt: z.number() }).strict()
export type RecipePublish = z.infer<typeof RecipePublishSchema>

/** A publish's answer: the version, now published, or the one published since the draft was made from its parent. */
export const RecipePublishedSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), record: RecipeVersionRecordSchema }),
  z.object({ ok: z.literal(false), published: RecipeVersionRecordSchema.nullable(), reason: z.string() }),
])
export type RecipePublished = z.infer<typeof RecipePublishedSchema>

export const RecipeProveSchema = z.object({ version: z.number().int().positive(), proof: RecipeProofSchema }).strict()
export type RecipeProve = z.infer<typeof RecipeProveSchema>

/** A store's history, taken by an authority that has none yet, as the project's own; refused once it has any. */
export const RecipeAdoptSchema = z.object({ versions: z.array(RecipeVersionRecordSchema).max(2_000), published: z.number().int().positive().nullable() }).strict()
export type RecipeAdopt = z.infer<typeof RecipeAdoptSchema>

/** The authority for one project's recipe versions, as a store reaches it. Every call is safe to repeat. */
export interface RecipeAuthority {
  /** Names the authority in a store's cursor. */
  readonly id: string
  changes(after: number): Promise<RecipeChanges>
  save(save: RecipeSave): Promise<RecipeVersionRecord>
  publish(publish: RecipePublish): Promise<RecipePublished>
  prove(prove: RecipeProve): Promise<RecipeVersionRecord>
  adopt(adopt: RecipeAdopt): Promise<{ adopted: boolean }>
}

/** Whether a recipe's JSON text (`JSON.stringify(recipe)`) fits what the authority keeps. */
export function recipeFits(json: string): boolean {
  return new TextEncoder().encode(json).length <= RECIPE_WIRE_BYTES
}
