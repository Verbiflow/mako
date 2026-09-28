import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import type { ThreadEnvironment } from "./contracts/thread-environments.js"
import { git } from "./worktree-git.js"

/** Committed with the project, so each branch carries its own. */
export const RECIPE_PATH = join(".mako", "environment.json")

const RECIPE_MAX_BYTES = 64 * 1024
/** Changing any of these in the agent's shell would break the agent itself. */
const SHELL_OWNED = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "PWD"])
const PLACEHOLDER = /\{([a-z][a-z0-9 +]*)\}/g

const template = z.string().max(2_000)
const command = z.string().trim().min(1).max(4_000)

/** Keys checked here rather than by the record's key schema, whose failures lose their reason. */
function named<T extends z.ZodType>(value: T, problem: (name: string) => string | undefined) {
  return z.record(z.string(), value).superRefine((entries, context) => {
    for (const name of Object.keys(entries)) {
      const message = problem(name)
      if (message) context.addIssue({ code: "custom", path: [name], message })
    }
  })
}

function variableProblem(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "a variable name is letters, digits and underscores"
  if (name.startsWith("MAKO_")) return "MAKO_ names are Mako's own"
  return undefined
}

const processSchema = z.object({
  command,
  /** Relative to the checkout. */
  cwd: z.string().min(1).optional(),
  /** Which of the Thread's ports it listens on, such as `{port+1}`; it's running once that port answers. */
  port: z.string().regex(/^\{port(\+\d+)?\}$/, "a process's port is {port} or {port+N}").optional(),
  /** Only for this process, so it can also set HOME, TMPDIR or XDG_* for an app with no data-folder setting. */
  values: named(template, (name) => variableProblem(name) ?? (name === "PATH" ? "PATH stays the machine's" : undefined)).optional(),
}).strict()

export const RecipeSchema = z.object({
  $schema: z.string().optional(),
  /** Mako's values under the names the app reads, in the agent's shell and in every process below. */
  values: named(template, (name) => variableProblem(name) ?? (SHELL_OWNED.has(name) ? "the agent's own shell needs this one; set it on a process instead" : undefined)).default({}),
  processes: named(processSchema, (name) => /^[a-z][a-z0-9-]{0,31}$/.test(name) ? undefined : "a process name is lowercase letters, digits and hyphens").default({}),
  checks: z.object({
    /** No running app: typecheck, lint, unit tests. */
    quick: command.optional(),
    /** With the app running: end-to-end and integration tests. */
    full: command.optional(),
  }).strict().default({}),
}).strict()

export type Recipe = z.infer<typeof RecipeSchema>
export type RecipeProcess = z.infer<typeof processSchema>
export type CheckTier = keyof Recipe["checks"]

export type RecipeRead =
  | { kind: "none"; checkout: string }
  | { kind: "ready"; checkout: string; recipe: Recipe }
  | { kind: "invalid"; checkout: string; message: string }

/** The Git checkout a folder is in; the folder itself outside Git. */
export async function checkoutOf(cwd: string): Promise<string> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")
  return top || cwd
}

/** The recipe in a checkout, checked against the Thread's values so a bad port offset fails here rather than in a process. */
export async function readRecipe(checkout: string, environment: ThreadEnvironment): Promise<RecipeRead> {
  const path = join(checkout, RECIPE_PATH)
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return { kind: "none", checkout }
    throw error
  }
  const invalid = (message: string): RecipeRead => ({ kind: "invalid", checkout, message: `${RECIPE_PATH}: ${message}` })
  if (Buffer.byteLength(text) > RECIPE_MAX_BYTES) return invalid(`larger than ${RECIPE_MAX_BYTES / 1024} KB`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return invalid(`not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const parsed = RecipeSchema.safeParse(json)
  if (!parsed.success) return invalid(parsed.error.issues.map((issue) => `${issue.path.join(".") || "the file"}: ${issue.message}`).join("; "))
  try {
    recipeValues(parsed.data, environment)
    for (const [name, spec] of Object.entries(parsed.data.processes)) {
      processPort(spec, environment)
      processValues(parsed.data, spec, environment)
      await processCwd(checkout, name, spec)
    }
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error))
  }
  return { kind: "ready", checkout, recipe: parsed.data }
}

/** `{port}`, `{port+N}`, `{host}`, `{url}`, `{data}` and `{thread}`; other braces are left as written. */
export function expandTemplate(text: string, environment: ThreadEnvironment): string {
  return text.replace(PLACEHOLDER, (whole, inner: string) => {
    const name = inner.replace(/ /g, "")
    const offset = /^port(?:\+(\d+))?$/.exec(name)
    if (offset) {
      const plus = Number(offset[1] ?? 0)
      if (plus >= environment.ports) throw new Error(`${whole} is past this Thread's ${environment.ports} ports ({port} to {port+${environment.ports - 1}})`)
      return String(environment.port + plus)
    }
    if (name === "host") return environment.host
    if (name === "url") return `http://${environment.host}:${environment.port}`
    if (name === "data") return environment.dataDir
    if (name === "thread") return environment.thread
    throw new Error(`${whole} isn't one of Mako's values: {port}, {port+N}, {host}, {url}, {data}, {thread}`)
  })
}

export function recipeValues(recipe: Recipe, environment: ThreadEnvironment): Record<string, string> {
  return Object.fromEntries(Object.entries(recipe.values).map(([name, text]) => [name, expandTemplate(text, environment)]))
}

export function processValues(recipe: Recipe, spec: RecipeProcess, environment: ThreadEnvironment) {
  const own = Object.entries(spec.values ?? {}).map(([name, text]) => [name, expandTemplate(text, environment)])
  return { ...recipeValues(recipe, environment), ...Object.fromEntries(own) }
}

export function processPort(spec: RecipeProcess, environment: ThreadEnvironment): number | undefined {
  return spec.port === undefined ? undefined : Number(expandTemplate(spec.port, environment))
}

/** Inside the checkout, following links, so a recipe can't run a process elsewhere. */
export async function processCwd(checkout: string, name: string, spec: RecipeProcess): Promise<string> {
  if (!spec.cwd) return checkout
  if (isAbsolute(spec.cwd)) throw new Error(`processes.${name}.cwd: relative to the checkout, not ${spec.cwd}`)
  const root = await realpath(checkout)
  const folder = await realpath(resolve(root, spec.cwd)).catch(() => {
    throw new Error(`processes.${name}.cwd: ${spec.cwd} doesn't exist in this checkout`)
  })
  const inside = relative(root, folder)
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`processes.${name}.cwd: ${spec.cwd} is outside the checkout`)
  return folder
}
