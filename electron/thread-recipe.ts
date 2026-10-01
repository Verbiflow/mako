import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import type { ThreadEnvironment } from "./contracts/thread-environments.js"
import { git } from "./worktree-git.js"

/**
 * A recipe committed with the project, for a team that shares one through
 * Git. The one Mako keeps for the project (`recipePath`) comes first.
 */
export const RECIPE_PATH = join(".mako", "environment.json")

const RECIPE_MAX_BYTES = 64 * 1024
/** Earlier versions of a project's saved recipe kept beside it. */
const RECIPE_HISTORY = 20
/** Changing any of these in the agent's shell would break the agent itself. */
const SHELL_OWNED = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "PWD"])
const PLACEHOLDER = /\{([a-z][a-z0-9 +]*)\}/g
/** What Mako itself sets on agents and processes; a project's own MAKO_ names, such as Mako's `MAKO_PROFILE`, are the project's. */
const MAKO_OWNED = ["MAKO_THREAD_", "MAKO_CONTROL_", "MAKO_CONVERSATIONS_TOKEN"]

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
  if (MAKO_OWNED.some((prefix) => name.startsWith(prefix))) return `${name} is Mako's own; it sets these for every Thread`
  return undefined
}

/** A path in the checkout, or a pattern: `*` stays within one folder, `**` crosses any number of them. */
const checkoutPattern = z.string().trim().min(1).max(300).refine(
  (pattern) => !isAbsolute(pattern) && !pattern.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git"),
  "a path in the checkout, such as .env or **/node_modules",
)

const processSchema = z.object({
  command,
  /** Relative to the checkout. */
  cwd: z.string().min(1).optional(),
  /** Which of the Thread's ports it listens on, such as `{port+1}`; it's running once that port answers. A fixed port needs `oneAtATime`. */
  port: z.string().regex(/^(\{port(\+\d+)?\}|[1-9]\d{0,4})$/, "a process's port is {port}, {port+N}, or a fixed number when the recipe is oneAtATime").optional(),
  /** Only for this process, so it can also set HOME, TMPDIR or XDG_* for an app with no data-folder setting. */
  values: named(template, (name) => variableProblem(name) ?? (name === "PATH" ? "PATH stays the machine's" : undefined)).optional(),
}).strict()

const prepareSchema = z.object({
  command,
  /** Files or folders in the checkout; the step runs in a fresh copy and again whenever one of them changes. */
  inputs: z.array(z.string().min(1).max(500)).min(1).max(20),
  /**
   * What the step writes, such as `**\/node_modules`. A new checkout gets them
   * cloned from the main checkout when the inputs are the same there, so its
   * first run only catches up.
   */
  outputs: z.array(checkoutPattern).min(1).max(10).optional(),
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
  /** Install in a fresh copy, and catch up after the branch moves: each step only when its inputs changed. */
  prepare: z.array(prepareSchema).max(10).default([]),
  /** Files Git ignores that a new checkout gets from the main checkout as they are, such as a local settings file. Never credentials. */
  carry: z.array(checkoutPattern).max(20).optional(),
  /**
   * Files Git ignores that hold credentials, such as `.env` files. A new
   * checkout gets them from the main checkout only once the person has
   * allowed it in Mako; nobody reads them.
   */
  secrets: z.array(checkoutPattern).max(20).optional(),
  /**
   * One copy on this Mac at a time: for an app with a fixed port, one local
   * database or one Docker stack that copies can't split. A start is refused
   * while another checkout of the project runs it.
   */
  oneAtATime: z.boolean().optional(),
}).strict()

export type Recipe = z.infer<typeof RecipeSchema>
export type RecipeProcess = z.infer<typeof processSchema>
export type CheckTier = keyof Recipe["checks"]

export type PrepareStep = z.infer<typeof prepareSchema>

/**
 * `saved` is where Mako keeps this project's recipe, whether or not one is
 * there yet. `from` is the file in use; `ignored` is a committed file that
 * isn't, because the saved one comes first.
 */
export type RecipeRead =
  | { kind: "none"; checkout: string; saved?: string }
  | { kind: "ready"; checkout: string; recipe: Recipe; from: string; ignored?: string; saved?: string }
  | { kind: "invalid"; checkout: string; message: string; from?: string; saved?: string }

/** The Git checkout a folder is in, or the folder itself outside Git; resolved, so one folder has one name. */
export async function checkoutOf(cwd: string): Promise<string> {
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")) || cwd
  return realpath(top).catch(() => top)
}

/** The project a checkout belongs to: its main checkout, which every worktree of it shares. */
export async function projectRoot(checkout: string): Promise<string> {
  const common = await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")
  return common ? realpath(dirname(common)).catch(() => dirname(common)) : checkout
}

/**
 * Where Mako keeps a project's recipe: one file for the main checkout and
 * all its worktrees, so saving it reaches every Thread and branch at once.
 * Named so a person can find it.
 */
export async function recipePath(root: string, checkout: string): Promise<string> {
  const common = await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")
  const identity = await realpath(common || checkout).catch(() => common || checkout)
  const project = common ? basename(dirname(identity)) : basename(identity)
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 8)
  return join(root, `${project.replace(/[^A-Za-z0-9._-]+/g, "-")}-${digest}.json`)
}

type JsonRead = { kind: "absent" } | { kind: "json"; value: unknown } | { kind: "invalid"; message: string }

async function readJson(path: string): Promise<JsonRead> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return { kind: "absent" }
    throw error
  }
  if (Buffer.byteLength(text) > RECIPE_MAX_BYTES) return { kind: "invalid", message: `larger than ${RECIPE_MAX_BYTES / 1024} KB` }
  try {
    return { kind: "json", value: JSON.parse(text) }
  } catch (error) {
    return { kind: "invalid", message: `not JSON (${error instanceof Error ? error.message : String(error)})` }
  }
}

export function recipeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "the file"}: ${issue.message}`).join("; ")
}

/**
 * The recipe for a checkout: the one Mako keeps for the project under
 * `recipesRoot` when there is one, otherwise one committed in the checkout.
 * Checked against the Thread's values and the checkout's folders, so a bad
 * port offset or a folder this branch lacks fails here rather than in a
 * process.
 */
export async function readRecipe(checkout: string, environment: ThreadEnvironment, recipesRoot?: string): Promise<RecipeRead> {
  const saved = recipesRoot ? await recipePath(recipesRoot, checkout) : undefined
  const at = saved ? { saved } : {}
  const committed = join(checkout, RECIPE_PATH)
  const own = saved ? await readJson(saved) : { kind: "absent" as const }
  const team = await readJson(committed)
  const useSaved = saved !== undefined && own.kind !== "absent"
  const from = useSaved ? saved : committed
  const read = useSaved ? own : team
  if (read.kind === "absent") return { kind: "none", checkout, ...at }
  if (read.kind === "invalid") return { kind: "invalid", checkout, message: `${from}: ${read.message}`, from, ...at }
  const parsed = RecipeSchema.safeParse(read.value)
  const problem = parsed.success ? await recipeProblem(parsed.data, checkout, environment) : recipeIssues(parsed.error)
  if (!parsed.success || problem) return { kind: "invalid", checkout, message: `${from}: ${problem}`, from, ...at }
  const ready: RecipeRead = { kind: "ready", checkout, recipe: parsed.data, from, ...at }
  if (from === saved && team.kind !== "absent") ready.ignored = committed
  return ready
}

/** Why this checkout and Thread can't run `recipe`, if they can't. */
export async function recipeProblem(recipe: Recipe, checkout: string, environment: ThreadEnvironment): Promise<string | undefined> {
  try {
    recipeValues(recipe, environment)
    for (const [name, spec] of Object.entries(recipe.processes)) {
      if (spec.port && !spec.port.startsWith("{")) {
        if (Number(spec.port) > 65_535) throw new Error(`processes.${name}.port: ${spec.port} isn't a port`)
        if (!recipe.oneAtATime)
          throw new Error(`processes.${name}.port: ${spec.port} is fixed, so two Threads' copies would fight over it. Use {port} or {port+N}; if the app can't move off it, set "oneAtATime": true so one copy runs at a time`)
      }
      processPort(spec, environment)
      processValues(recipe, spec, environment)
      await processCwd(checkout, name, spec)
    }
    recipe.prepare.forEach((step, index) => {
      for (const input of step.inputs)
        if (isAbsolute(input) || relative(checkout, resolve(checkout, input)).startsWith(".."))
          throw new Error(`prepare.${index}.inputs: ${input} is outside the checkout`)
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

export interface SavedRecipe {
  file: string
  /** The version this one replaced, kept in the project's history folder. */
  previous?: string
}

/**
 * Saves the recipe Mako keeps for `checkout`'s project, for every Thread
 * and branch of it. The version it replaces is kept, the last
 * `RECIPE_HISTORY` of them. Refuses a recipe this checkout can't run.
 */
export async function saveRecipe(recipesRoot: string, checkout: string, recipe: Recipe, environment: ThreadEnvironment, now = new Date()): Promise<SavedRecipe> {
  const problem = await recipeProblem(recipe, checkout, environment)
  if (problem) throw new Error(`Not saved: ${problem}`)
  const file = await recipePath(recipesRoot, checkout)
  const text = `${JSON.stringify(recipe, null, 2)}\n`
  if (Buffer.byteLength(text) > RECIPE_MAX_BYTES) throw new Error(`Not saved: larger than ${RECIPE_MAX_BYTES / 1024} KB`)
  await mkdir(recipesRoot, { recursive: true, mode: 0o700 })
  const saved: SavedRecipe = { file }
  const before = await readFile(file, "utf8").catch(() => undefined)
  if (before !== undefined && before !== text) {
    const history = recipeHistory(file)
    await mkdir(history, { recursive: true, mode: 0o700 })
    saved.previous = join(history, `${now.toISOString().replace(/[:.]/g, "-")}.json`)
    await writeFile(saved.previous, before, { mode: 0o600 })
    const kept = (await readdir(history)).filter((name) => name.endsWith(".json")).sort()
    await Promise.all(kept.slice(0, Math.max(0, kept.length - RECIPE_HISTORY)).map((name) => rm(join(history, name), { force: true })))
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return saved
}

/** The folder of a saved recipe's earlier versions. */
export function recipeHistory(file: string): string {
  return join(dirname(file), "history", basename(file, ".json"))
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
    if (name === "thread") return environment.app
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

const DIGEST_MAX_FILES = 10_000

/**
 * A folder's files as inputs: what Git tracks or would track there, so what
 * a step writes (anything the project ignores) never counts. Outside Git,
 * every file but Git's own.
 */
async function inputFiles(checkout: string, folder: string): Promise<string[]> {
  const listed = await git(checkout, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", folder]).then(
    (output) => output.split("\0").filter(Boolean),
    () => undefined,
  )
  if (listed) return [...new Set(listed)].sort()
  const found: string[] = []
  const visit = async (relativePath: string): Promise<void> => {
    for (const entry of await readdir(join(checkout, relativePath), { withFileTypes: true })) {
      if (entry.name === ".git") continue
      const inside = join(relativePath, entry.name)
      if (entry.isDirectory()) await visit(inside)
      else if (entry.isFile()) found.push(inside)
      if (found.length > DIGEST_MAX_FILES) return
    }
  }
  await visit(folder)
  return found.sort()
}

/**
 * One digest of a step's inputs, by content, so a branch switch that
 * changes the lockfile back and forth is seen, and a touched file isn't.
 * A file named outright counts even when Git ignores it.
 */
export async function inputsDigest(checkout: string, inputs: string[]): Promise<string> {
  const hash = createHash("sha256")
  let files = 0
  const add = async (relativePath: string) => {
    const bytes = await readFile(join(checkout, relativePath)).catch(() => undefined)
    if (!bytes) {
      hash.update(`missing ${relativePath}\n`)
      return
    }
    files += 1
    if (files > DIGEST_MAX_FILES) throw new Error(`prepare inputs cover more than ${DIGEST_MAX_FILES} files; name the lockfiles or migration folders themselves`)
    hash.update(`file ${relativePath}\n`)
    hash.update(bytes)
  }
  for (const input of [...inputs].sort()) {
    const entry = await lstat(resolve(checkout, input)).catch(() => undefined)
    if (!entry) hash.update(`missing ${input}\n`)
    else if (entry.isDirectory()) for (const file of await inputFiles(checkout, relative(checkout, resolve(checkout, input)) || ".")) await add(file)
    else if (entry.isFile()) await add(relative(checkout, resolve(checkout, input)))
  }
  return hash.digest("hex")
}

/**
 * The project's recipe as written, saved in Mako or committed, without
 * checking it against a Thread: what a new checkout takes from the main one
 * needs no ports. Undefined when there is none, or it doesn't parse.
 */
export async function projectRecipe(checkout: string, recipesRoot: string | undefined): Promise<Recipe | undefined> {
  const saved = recipesRoot ? await readJson(await recipePath(recipesRoot, checkout)).catch((): JsonRead => ({ kind: "absent" })) : { kind: "absent" as const }
  const read = saved.kind === "absent" ? await readJson(join(checkout, RECIPE_PATH)).catch((): JsonRead => ({ kind: "absent" })) : saved
  if (read.kind !== "json") return undefined
  const parsed = RecipeSchema.safeParse(read.value)
  return parsed.success ? parsed.data : undefined
}
