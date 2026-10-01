import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { z } from "zod"
import { recipePath, type Recipe } from "./thread-recipe.js"

/** Committed, value-free templates of an env file. */
const TEMPLATE = /^\.env\.(example|sample|template|defaults|dist)$/

/**
 * Whether a file holds credentials by its name: env files, key files and
 * the dotfiles that keep registry or database passwords. A recipe lists
 * these under `secrets`, never `carry`.
 */
export function holdsCredentials(entry: string): boolean {
  const name = basename(entry).toLowerCase()
  if (TEMPLATE.test(name)) return false
  return name === ".env" || name.startsWith(".env.") || [".envrc", ".npmrc", ".netrc", ".pgpass"].includes(name)
    || /\.(pem|key|p12|pfx|jks|keystore)$/.test(name) || /credential|secret/.test(name)
}

const AllowedSchema = z.object({ patterns: z.array(z.string()), at: z.number() }).strict()

/** The recipe's `secrets` patterns the person let new checkouts have, and when. */
export type AllowedSecrets = z.infer<typeof AllowedSchema>

/** Beside the project's saved recipe, so saving a recipe never grants it. */
async function allowedFile(recipesRoot: string, checkout: string): Promise<string> {
  return (await recipePath(recipesRoot, checkout)).replace(/\.json$/, ".allowed.json")
}

export async function readAllowedSecrets(recipesRoot: string, checkout: string): Promise<AllowedSecrets | undefined> {
  const text = await readFile(await allowedFile(recipesRoot, checkout), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const parsed = AllowedSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Records the person's answer; none allowed removes the record. */
export async function writeAllowedSecrets(recipesRoot: string, checkout: string, patterns: readonly string[], at = Date.now()): Promise<AllowedSecrets | undefined> {
  const file = await allowedFile(recipesRoot, checkout)
  if (!patterns.length) {
    await rm(file, { force: true })
    return undefined
  }
  const allowed: AllowedSecrets = { patterns: [...new Set(patterns)], at }
  await mkdir(recipesRoot, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(allowed, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return allowed
}

/** The recipe's credentials files a new checkout may have: those the person allowed, as the recipe names them now. */
export function grantedSecrets(recipe: Pick<Recipe, "secrets"> | undefined, allowed: AllowedSecrets | undefined): string[] {
  const granted = new Set(allowed?.patterns ?? [])
  return (recipe?.secrets ?? []).filter((pattern) => granted.has(pattern))
}
