import { createHash } from "node:crypto"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import type { ThreadEnvironment } from "./contracts/thread-environments.js"
import { git } from "./worktree-git.js"

/** Committed with the project, so each branch carries its own. */
export const RECIPE_PATH = join(".mako", "environment.json")

const RECIPE_MAX_BYTES = 64 * 1024
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

const processSchema = z.object({
  command,
  /** Relative to the checkout. */
  cwd: z.string().min(1).optional(),
  /** Which of the Thread's ports it listens on, such as `{port+1}`; it's running once that port answers. */
  port: z.string().regex(/^\{port(\+\d+)?\}$/, "a process's port is {port} or {port+N}").optional(),
  /** Only for this process, so it can also set HOME, TMPDIR or XDG_* for an app with no data-folder setting. */
  values: named(template, (name) => variableProblem(name) ?? (name === "PATH" ? "PATH stays the machine's" : undefined)).optional(),
}).strict()

const prepareSchema = z.object({
  command,
  /** Files or folders in the checkout; the step runs in a fresh copy and again whenever one of them changes. */
  inputs: z.array(z.string().min(1).max(500)).min(1).max(20),
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
}).strict()

/** A person's own changes, kept by Mako outside the repository: any field, merged over the team's file. */
const OverrideSchema = z.object({
  $schema: z.string().optional(),
  values: z.record(z.string(), template).optional(),
  processes: z.record(z.string(), processSchema.partial()).optional(),
  checks: z.object({ quick: command.optional(), full: command.optional() }).strict().optional(),
  prepare: z.array(prepareSchema).max(10).optional(),
}).strict()

export type Recipe = z.infer<typeof RecipeSchema>
export type RecipeProcess = z.infer<typeof processSchema>
export type CheckTier = keyof Recipe["checks"]

export type PrepareStep = z.infer<typeof prepareSchema>

export type RecipeRead =
  | { kind: "none"; checkout: string; overrides?: string }
  | { kind: "ready"; checkout: string; recipe: Recipe; sources: string[]; overrides?: string }
  | { kind: "invalid"; checkout: string; message: string; overrides?: string }

/** The Git checkout a folder is in; the folder itself outside Git. */
export async function checkoutOf(cwd: string): Promise<string> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")
  return top || cwd
}

/**
 * Where a person's overrides for a repository live: one file for the main
 * checkout and all its worktrees, named so a person can find it.
 */
export async function overridePath(root: string, checkout: string): Promise<string> {
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

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "the file"}: ${issue.message}`).join("; ")
}

/**
 * The recipe in a checkout, with the person's overrides from `overridesRoot`
 * merged over it, checked against the Thread's values so a bad port offset
 * fails here rather than in a process. Overrides alone are a recipe too.
 */
export async function readRecipe(checkout: string, environment: ThreadEnvironment, overridesRoot?: string): Promise<RecipeRead> {
  const overrides = overridesRoot ? await overridePath(overridesRoot, checkout) : undefined
  const at = overrides ? { overrides } : {}
  const team = await readJson(join(checkout, RECIPE_PATH))
  const own = overrides ? await readJson(overrides) : { kind: "absent" as const }
  if (team.kind === "invalid") return { kind: "invalid", checkout, message: `${RECIPE_PATH}: ${team.message}`, ...at }
  if (own.kind === "invalid") return { kind: "invalid", checkout, message: `${overrides}: ${own.message}`, ...at }
  if (team.kind === "absent" && own.kind === "absent") return { kind: "none", checkout, ...at }
  const base = team.kind === "json" ? RecipeSchema.safeParse(team.value) : RecipeSchema.safeParse({})
  if (!base.success) return { kind: "invalid", checkout, message: `${RECIPE_PATH}: ${issues(base.error)}`, ...at }
  const sources = team.kind === "json" ? [join(checkout, RECIPE_PATH)] : []
  const personal = own.kind === "json" ? OverrideSchema.safeParse(own.value) : undefined
  if (personal && !personal.success) return { kind: "invalid", checkout, message: `${overrides}: ${issues(personal.error)}`, ...at }
  const processes = new Map<string, Partial<RecipeProcess>>(Object.entries(base.data.processes))
  for (const [name, spec] of Object.entries(personal?.data?.processes ?? {})) processes.set(name, { ...processes.get(name), ...spec })
  const merged = personal?.data ? {
    ...base.data,
    values: { ...base.data.values, ...personal.data.values },
    processes: Object.fromEntries(processes),
    checks: { ...base.data.checks, ...personal.data.checks },
    prepare: personal.data.prepare ?? base.data.prepare,
  } : base.data
  if (personal && overrides) sources.push(overrides)
  const label = sources.length > 1 ? `${RECIPE_PATH} with ${overrides}` : sources[0] === overrides ? String(overrides) : RECIPE_PATH
  const invalid = (message: string): RecipeRead => ({ kind: "invalid", checkout, message: `${label}: ${message}`, ...at })
  const parsed = RecipeSchema.safeParse(merged)
  if (!parsed.success) return invalid(issues(parsed.error))
  try {
    recipeValues(parsed.data, environment)
    for (const [name, spec] of Object.entries(parsed.data.processes)) {
      processPort(spec, environment)
      processValues(parsed.data, spec, environment)
      await processCwd(checkout, name, spec)
    }
    parsed.data.prepare.forEach((step, index) => {
      for (const input of step.inputs)
        if (isAbsolute(input) || relative(checkout, resolve(checkout, input)).startsWith(".."))
          throw new Error(`prepare.${index}.inputs: ${input} is outside the checkout`)
    })
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error))
  }
  return { kind: "ready", checkout, recipe: parsed.data, sources, ...at }
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

/** Folders a prepare step's inputs never reach into: they're its outputs, or Git's own. */
const DIGEST_SKIPPED = new Set([".git", "node_modules"])
const DIGEST_MAX_FILES = 10_000

/**
 * One digest of a step's inputs, by content, so a branch switch that
 * changes the lockfile back and forth is seen, and a touched file isn't.
 */
export async function inputsDigest(checkout: string, inputs: string[]): Promise<string> {
  const hash = createHash("sha256")
  let files = 0
  const visit = async (path: string, shown: string): Promise<void> => {
    const entry = await lstat(path).catch(() => undefined)
    if (!entry) {
      hash.update(`missing ${shown}\n`)
      return
    }
    if (entry.isDirectory()) {
      const names = (await readdir(path)).filter((name) => !DIGEST_SKIPPED.has(name)).sort()
      for (const name of names) await visit(join(path, name), `${shown}/${name}`)
      return
    }
    if (!entry.isFile()) return
    files += 1
    if (files > DIGEST_MAX_FILES) throw new Error(`prepare inputs cover more than ${DIGEST_MAX_FILES} files; name the lockfiles or migration folders themselves`)
    hash.update(`file ${shown}\n`)
    hash.update(await readFile(path))
  }
  for (const input of [...inputs].sort()) await visit(resolve(checkout, input), input)
  return hash.digest("hex")
}
