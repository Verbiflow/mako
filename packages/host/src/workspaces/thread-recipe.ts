import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { STEPS_FOLDER_VARIABLE, type CheckStep } from "./check-steps.js"
import type { RecipeProofSummary, RecipeVersionView } from "../contracts/project-app.js"
import { AppKeySchema, type AppKey, type ThreadEnvironment } from "../contracts/thread-environments.js"
import { PROJECT_CHECKOUT_FILE } from "../contracts/thread-worktrees.js"
import type { Git } from "@mako/git"
import { RECIPE_REASON_MAX, RecipeProofSchema, RecipeProofStepSchema, RecipeVersionRecordSchema, type RecipeAuthority, type RecipeSave, type RecipeVersionRecord } from "@mako/protocol/recipes"

/**
 * A recipe committed with the project, for a team that shares one through
 * Git. The one Mako keeps for the project (`recipePath`) comes first.
 */
export const RECIPE_PATH = join(".mako", "recipe.json")

const RECIPE_MAX_BYTES = 64 * 1024
/** Changing any of these in the agent's shell would break the agent itself. */
const SHELL_OWNED = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "PWD"])
const PLACEHOLDER = /\{([a-z][a-z0-9 +]*)\}/g
/** What Mako itself sets on agents and processes; a project's own MAKO_ names, such as Mako's `MAKO_PROFILE`, are the project's. */
const MAKO_OWNED = ["MAKO_THREAD_", "MAKO_CONTROL_", "MAKO_CONVERSATIONS_TOKEN", STEPS_FOLDER_VARIABLE]

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
export const checkoutPattern = z.string().trim().min(1).max(300).refine(
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
  /**
   * A command that succeeds once the process can serve, such as a database's
   * own readiness command; Mako runs it every half second while the process
   * starts, and the process counts as running only once it passes, whatever
   * its port says.
   */
  ready: command.optional(),
  /**
   * What it runs on: any computer (the default), Linux, or a Mac with its screen, such as a desktop app. A process a
   * place can't run isn't started there, and a target that needs one says so instead of starting part of itself.
   */
  platform: z.enum(["any", "linux", "mac"]).optional(),
}).strict()

const processName = /^[a-z][a-z0-9-]{0,31}$/

/** A process as one place changes it: only the fields that differ there, patched onto the shared process. */
const processPatchSchema = processSchema.partial().strict()

const stepSchema = z.object({
  /** Such as `typecheck` or `lint`: what the step's result is reported as, and how a rerun names it. */
  name: z.string().regex(processName, "a step name is lowercase letters, digits and hyphens, such as typecheck"),
  command,
  /** Runs at the same time as the steps next to it that also say so; any other step waits for those before it. */
  parallel: z.boolean().optional(),
}).strict()

const stepsSchema = z.array(stepSchema).min(1).max(20).superRefine((steps, context) => {
  const seen = new Set<string>()
  steps.forEach((step, index) => {
    if (seen.has(step.name)) context.addIssue({ code: "custom", path: [index, "name"], message: `${step.name} names two steps; each step needs its own name` })
    seen.add(step.name)
  })
})

/**
 * A check: one command, or named steps Mako runs, times and reports one by
 * one. Read by its shape first, so a refusal names what's wrong inside the
 * shape that was meant rather than saying it matches neither.
 */
const checkSchema = z.unknown().transform((value, context): string | CheckStep[] => {
  const parsed = Array.isArray(value) ? stepsSchema.safeParse(value) : command.safeParse(value)
  if (parsed.success) return parsed.data
  for (const issue of parsed.error.issues)
    context.addIssue({ code: "custom", path: issue.path, message: Array.isArray(value) || z.string().safeParse(value).success ? issue.message : "a command, or a list of named steps such as [{ \"name\": \"lint\", \"command\": \"npm run lint\" }]" })
  return z.NEVER
})
export type RecipeCheck = z.infer<typeof checkSchema>

/**
 * How Mako proves a new version of the recipe before it reaches every
 * Thread: `run` is a command (or steps) Mako runs against the started app,
 * passing on exit 0; `check` is what the agent publishing it goes and sees
 * for itself, by any means (the app, its logs, Mako's computer control),
 * and reports.
 */
const verifySchema = z.union([
  z.object({ run: checkSchema }).strict(),
  z.object({ check: z.string().trim().min(1).max(2_000) }).strict(),
])
export type RecipeVerify = z.infer<typeof verifySchema>

const targetSchema = z.object({
  /** The recipe's processes this target runs, such as the API and the desktop app. */
  processes: z.array(z.string().regex(processName, "a process name")).min(1).max(20),
  /** Its own full check, in place of the recipe's. */
  full: checkSchema.optional(),
  verify: verifySchema.optional(),
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
  /**
   * A new checkout's outputs link each entry to the main checkout's, in a
   * second, instead of cloning them, so nothing may write into them: an
   * install would write through the links into the main checkout, so Mako
   * gives the checkout its own copy first. Left out, a recipe written before
   * linking was the default clones them; `recipe_save` writes `true` for a
   * step with outputs that doesn't say (`withLinkDefault`).
   */
  link: z.boolean().optional(),
  /**
   * When it runs: `base` (the default), with no secrets and no Thread values, so a cloud project base can be built
   * from it ahead of any Thread; or `thread`, once the Thread's checkout exists, for what needs them, such as
   * migrations and seeding.
   */
  phase: z.enum(["base", "thread"]).optional(),
}).strict().refine(
  (step) => step.link === undefined || step.outputs?.length,
  { message: "link is for a step's outputs: name them in outputs, or leave link out", path: ["link"] },
)

/** A path a recipe names alone is copied. */
const copiedPath = checkoutPattern.transform((path) => ({ path, link: false }))

/** One of the files Git ignores that a new checkout gets from the main checkout: copied, or linked to the main checkout's. */
const carryEntrySchema = z.union([
  copiedPath,
  z.object({
    path: checkoutPattern,
    /** Shared with the main checkout instead of copied, for a large folder nothing writes into. */
    link: z.boolean().default(false),
  }).strict(),
])
export type CarryEntry = z.infer<typeof carryEntrySchema>

/** What one place changes of the recipe: its own values, and fields of shared processes; never a process of its own. */
const placeSchema = z.object({
  /** Values for this place only, such as an `APP_URL` or a database's address; each replaces the shared value of its name. */
  values: named(template, (name) => variableProblem(name) ?? (SHELL_OWNED.has(name) ? "the agent's own shell needs this one; set it on a process instead" : undefined)).optional(),
  /** Fields of the recipe's processes for this place, such as `web`'s command under `xvfb-run`: a patch, never a copy. */
  processes: z.record(z.string(), processPatchSchema).optional(),
}).strict()

export const RecipeSchema = z.object({
  $schema: z.string().optional(),
  /** Mako's values under the names the app reads, in the agent's shell and in every process below. */
  values: named(template, (name) => variableProblem(name) ?? (SHELL_OWNED.has(name) ? "the agent's own shell needs this one; set it on a process instead" : undefined)).default({}),
  processes: named(processSchema, (name) => processName.test(name) ? undefined : "a process name is lowercase letters, digits and hyphens").default({}),
  /**
   * The things the project builds that run differently, such as web, desktop
   * and ios, each with the processes it needs. The first is what a start
   * with no target runs.
   */
  targets: named(targetSchema, (name) => processName.test(name) ? undefined : "a target name is lowercase letters, digits and hyphens").optional(),
  checks: z.object({
    /** No running app: typecheck, lint, unit tests. */
    quick: checkSchema.optional(),
    /** With the app running: end-to-end and integration tests. */
    full: checkSchema.optional(),
  }).strict().default({}),
  /** Install in a fresh copy, and catch up after the branch moves: each step only when its inputs changed. */
  prepare: z.array(prepareSchema).max(10).default([]),
  /**
   * Files Git ignores that a new checkout gets from the main checkout as
   * they are, such as a local settings file or `.env.local`: copied, or with
   * `link`, shared with the main checkout's.
   */
  carry: z.array(carryEntrySchema).max(20).optional(),
  /**
   * Credentials and dependency folders Git ignores that a new checkout
   * leaves to the main checkout on purpose, such as production keys: Mako
   * stops pointing them out as missing.
   */
  leave: z.array(checkoutPattern).max(20).optional(),
  /** Read into `carry`: recipes saved before credentials files were carried like any other listed them here. */
  secrets: z.array(copiedPath).max(20).optional(),
  /**
   * One copy on this Mac at a time: for an app with a fixed port, one local
   * database or one Docker stack that copies can't split. A start is refused
   * while another checkout of the project runs it.
   */
  oneAtATime: z.boolean().optional(),
  /** How a new version is proven before it's published; with no `verify`, a version that installs and starts is published. */
  verify: verifySchema.optional(),
  /**
   * Undoes what a Thread's app leaves outside its checkout, such as its
   * containers' volumes or its database, when its worktree is removed.
   */
  cleanup: command.optional(),
  /**
   * The secrets the app reads from its environment, by name, such as `E2B_API_KEY`; never their values. On this
   * computer the files `carry` copies meet them; in the cloud the account's secret store does, and a start that
   * would lack one says which before it starts.
   */
  secretNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "a secret's name, such as E2B_API_KEY")).max(50).optional(),
  /**
   * What differs by place, written inside the one recipe: `local` for this computer, `cloud` for a cloud machine.
   * Every place keeps the same processes, checks and version; a place only changes values and patches processes.
   */
  places: z.object({ local: placeSchema.optional(), cloud: placeSchema.optional() }).strict().optional(),
}).strict().superRefine((recipe, context) => {
  for (const place of ["local", "cloud"] as const)
    for (const name of Object.keys(recipe.places?.[place]?.processes ?? {}))
      if (!(name in recipe.processes)) context.addIssue({ code: "custom", path: ["places", place, "processes", name], message: `${name} isn't one of the recipe's processes: a place patches a process, it never adds one` })
  recipe.prepare.forEach((step, index) => {
    if ((step.phase ?? "base") === "base" && /\{(thread|port)/.test(step.command))
      context.addIssue({ code: "custom", path: ["prepare", index, "command"], message: "a base step gets no Thread values, so a project base can be built from it: mark it phase \"thread\", or leave the Thread's values out" })
  })
  const seen = new Set<string>()
  for (const [index, { path }] of [...(recipe.carry ?? []), ...(recipe.secrets ?? [])].entries()) {
    if (seen.has(path)) context.addIssue({ code: "custom", path: ["carry", index], message: `${path} is listed twice; list it once, with link or without` })
    seen.add(path)
  }
}).transform(({ secrets, ...recipe }) => (secrets?.length ? { ...recipe, carry: [...(recipe.carry ?? []), ...secrets] } : recipe))

export type Recipe = z.infer<typeof RecipeSchema>

/** Where a recipe runs: this computer or a cloud machine, and what that computer is. */
export type RecipePlace = "local" | "cloud"
export type RecipeWhere = { place: RecipePlace; platform: "mac" | "linux" | "other" }
/** What a place can't run of a recipe: each process with what it needs, and the targets that need one of them. */
export type RecipeAbsent = { processes: Array<{ name: string; needs: "linux" | "mac" }>; targets: string[] }

/** Whether a process that runs on `platform` runs where `where` is. */
function runsOn(platform: RecipeProcess["platform"], where: RecipeWhere): boolean {
  return platform === undefined || platform === "any" || platform === where.platform
}

/**
 * The recipe as it runs in one place: the place's values over the shared ones, its patches applied to the shared
 * processes, and the processes and targets it can't run left out, each named in `absent`. The processes, checks and
 * version are the recipe's in every place, so a check passes or fails for the same reasons on the laptop and on a
 * machine.
 */
export type RecipeInPlace = { recipe: Recipe; absent: RecipeAbsent }
export function recipeIn(recipe: Recipe, where: RecipeWhere): RecipeInPlace {
  const place = recipe.places?.[where.place]
  const absent: RecipeAbsent = { processes: [], targets: [] }
  const processes: Recipe["processes"] = {}
  for (const [name, shared] of Object.entries(recipe.processes)) {
    const spec = { ...shared, ...place?.processes?.[name] }
    if (runsOn(spec.platform, where)) processes[name] = spec
    else absent.processes.push({ name, needs: spec.platform === "linux" ? "linux" : "mac" })
  }
  const resolved: Recipe = { ...recipe, values: { ...recipe.values, ...place?.values }, processes }
  // As it runs, a recipe has no places: they've been applied.
  delete resolved.places
  if (recipe.targets) {
    const targets: NonNullable<Recipe["targets"]> = {}
    for (const [name, target] of Object.entries(recipe.targets)) {
      if (target.processes.every((process) => process in processes)) targets[name] = target
      else absent.targets.push(name)
    }
    resolved.targets = targets
  }
  return { recipe: resolved, absent }
}

/** What `recipe_save` keeps: a step with outputs that doesn't say links them, written out so the version says so. */
export function withLinkDefault(recipe: Recipe): Recipe {
  if (!recipe.prepare.some((step) => step.outputs?.length && step.link === undefined)) return recipe
  return { ...recipe, prepare: recipe.prepare.map((step) => (step.outputs?.length && step.link === undefined ? { ...step, link: true } : step)) }
}

/** The values that name something for the Thread, such as its database or profile, each as `NAME (template)`. */
export function perThreadValues(recipe: Recipe): string[] {
  const values = [recipe.values, ...Object.values(recipe.processes).map((process) => process.values ?? {})].flatMap(Object.entries)
  return [...new Set(values.filter(([, text]) => text.includes("{thread}")).map(([name, text]) => `${name} (${text})`))]
}
export type RecipeTarget = z.infer<typeof targetSchema>
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
  | {
      kind: "ready"
      checkout: string
      recipe: Recipe
      from: string
      ignored?: string
      saved?: string
      /** Its number among the project's versions; none for a committed recipe. */
      version?: number
      /** A draft only this app runs, made from the published version `parent`. */
      draft?: { parent?: number }
      /** The published version, newer than this one the app's processes started with; it takes it at its next start. */
      newer?: number
      /** Where it was read for, and what of it can't run there (`recipeIn`); `recipe` is as it runs there. */
      where?: RecipeWhere
      absent?: RecipeAbsent
    }
  | { kind: "invalid"; checkout: string; message: string; from?: string; saved?: string }

/** The Git checkout a folder is in, or the folder itself outside Git; resolved, so one folder has one name. */
export async function checkoutOf(git: Git, cwd: string): Promise<string> {
  const top = (await git.output(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")) || cwd
  return realpath(top).catch(() => top)
}

const ProjectCheckoutSchema = z.object({ project: z.string().min(1) })

/** The project folder a Thread's checkout of several repositories mirrors, read from its `PROJECT_CHECKOUT_FILE`. */
export async function mirroredProject(checkout: string): Promise<string | undefined> {
  const text = await readFile(join(checkout, PROJECT_CHECKOUT_FILE), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return ProjectCheckoutSchema.parse(JSON.parse(text)).project
  } catch {
    return undefined
  }
}

/** The project a checkout belongs to: its main checkout, which every worktree of it shares. */
export async function projectRoot(git: Git, checkout: string): Promise<string> {
  const common = await git.output(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")
  if (common) return realpath(dirname(common)).catch(() => dirname(common))
  return (await mirroredProject(checkout)) ?? checkout
}

/**
 * Where Mako keeps a project's recipe: one file for the main checkout and
 * all its worktrees, so saving it reaches every Thread and branch at once.
 * Named so a person can find it.
 */
export async function recipePath(git: Git, root: string, checkout: string): Promise<string> {
  const common = await git.output(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")
  const folder = common || (await mirroredProject(checkout)) || checkout
  const identity = await realpath(folder).catch(() => folder)
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
  return error.issues.flatMap((issue) => issueLines(issue, [])).join("; ")
}

/** A union's issue as the issues of the one option the value could be, which say what's wrong; zod's own says only "Invalid input". */
function issueLines(issue: z.core.$ZodIssue, under: PropertyKey[]): string[] {
  const path = [...under, ...issue.path]
  if (issue.code === "invalid_union") {
    const fitting = issue.errors.filter((option) => !option.every((inner) => inner.code === "invalid_type" && !inner.path.length))
    if (fitting.length === 1) return fitting[0]!.flatMap((inner) => issueLines(inner, path))
  }
  return [`${path.map(String).join(".") || "the file"}: ${issue.message}`]
}

/**
 * The recipe for a checkout: the one Mako keeps for the project under
 * `recipesRoot` when there is one, otherwise one committed in the checkout.
 * Checked against the Thread's values and the checkout's folders, so a bad
 * port offset or a folder this branch lacks fails here rather than in a
 * process.
 */
export async function readRecipe(git: Git, checkout: string, environment: ThreadEnvironment, recipesRoot?: string, where?: RecipeWhere, accounts?: RecipeAccounts): Promise<RecipeRead> {
  // A project the account keeps is read from its mirror, brought up to date first if it's been a few seconds.
  if (accounts && recipesRoot) await accounts.forRead(await recipePath(git, recipesRoot, checkout), checkout)
  const read = await readRecipeAsWritten(git, checkout, environment, recipesRoot)
  return where && read.kind === "ready" ? inPlace(read, where) : read
}

/** A read recipe as it runs in `where`: its place's values and patches, and what that place can't run. */
export function inPlace<Read extends Extract<RecipeRead, { kind: "ready" }>>(read: Read, where: RecipeWhere): Read {
  const resolved = recipeIn(read.recipe, where)
  const placed: Read = { ...read, recipe: resolved.recipe, where }
  if (resolved.absent.processes.length) placed.absent = resolved.absent
  return placed
}

async function readRecipeAsWritten(git: Git, checkout: string, environment: ThreadEnvironment, recipesRoot?: string): Promise<RecipeRead> {
  const saved = recipesRoot ? await recipePath(git, recipesRoot, checkout) : undefined
  const at = saved ? { saved } : {}
  const draft = saved ? await appDraft(saved, environment.app) : undefined
  if (saved && draft) {
    const from = join(recipeVersions(saved), `${draft.version}.json`)
    const problem = await recipeProblem(draft.recipe, checkout, environment)
    if (problem) return { kind: "invalid", checkout, message: `${from}: ${problem}`, from, ...at }
    const ready: RecipeRead = { kind: "ready", checkout, recipe: draft.recipe, from, saved, version: draft.version, draft: draft.parent === undefined ? {} : { parent: draft.parent } }
    if (await lstat(join(checkout, RECIPE_PATH)).then(() => true, () => false)) ready.ignored = join(checkout, RECIPE_PATH)
    return ready
  }
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
  if (from === saved) {
    const version = await publishedVersion(saved)
    if (version !== undefined) ready.version = version
  }
  return ready
}

/** A Mako placeholder written into a command, where nothing fills it in; a shell's own `${port}` is left alone. */
function commandPlaceholder(command: string): string | undefined {
  return /(?<!\$)\{(?:port(?: *\+ *\d+)?|host|url|data|thread)\}/.exec(command)?.[0]
}

/** Why this checkout and Thread can't run `recipe`, if they can't. */
export async function recipeProblem(recipe: Recipe, checkout: string, environment: ThreadEnvironment): Promise<string | undefined> {
  const optionalCommand = (path: string, command: string | undefined): [string, string][] => command ? [[path, command]] : []
  const check = (path: string, given: RecipeCheck | undefined): [string, string][] =>
    given === undefined ? [] : Array.isArray(given) ? given.map((step, index): [string, string] => [`${path}.${index}.command`, step.command]) : [[path, given]]
  const verifyRun = (path: string, verify: RecipeVerify | undefined): [string, string][] => verify && "run" in verify ? check(`${path}.run`, verify.run) : []
  const commands: [string, string][] = [
    ...Object.entries(recipe.processes).flatMap(([name, spec]): [string, string][] => [
      [`processes.${name}.command`, spec.command],
      ...optionalCommand(`processes.${name}.ready`, spec.ready),
    ]),
    ...check("checks.quick", recipe.checks.quick),
    ...check("checks.full", recipe.checks.full),
    ...recipe.prepare.map((step, index): [string, string] => [`prepare.${index}.command`, step.command]),
    ...verifyRun("verify", recipe.verify),
    ...Object.entries(recipe.targets ?? {}).flatMap(([name, target]): [string, string][] => [
      ...check(`targets.${name}.full`, target.full),
      ...verifyRun(`targets.${name}.verify`, target.verify),
    ]),
    ...optionalCommand("cleanup", recipe.cleanup),
  ]
  for (const [path, command] of commands) {
    const placeholder = commandPlaceholder(command)
    if (placeholder)
      return `${path}: ${placeholder} isn't filled in inside a command; Mako fills in only values and ports. Name it in values, such as "PORT": "${placeholder}", and write "$PORT" in the command`
  }
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
    for (const [name, target] of Object.entries(recipe.targets ?? {})) {
      const unknown = target.processes.filter((process) => !recipe.processes[process])
      if (unknown.length) throw new Error(`targets.${name}.processes: the recipe has no process named ${unknown.join(", ")}`)
    }
    for (const [path, verify] of [["verify", recipe.verify], ...Object.entries(recipe.targets ?? {}).map(([name, target]) => [`targets.${name}.verify`, target.verify] as const)] as const)
      if (verify && "check" in verify) {
        try {
          expandTemplate(verify.check, environment)
        } catch (error) {
          throw new Error(`${path}.check: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

// A version and its proofs are the protocol's, so a store and the account's authority read them alike.
export type RecipeProof = z.infer<typeof RecipeProofSchema>
export type RecipeProofStep = z.infer<typeof RecipeProofStepSchema>

/** The longest reason a version keeps; a longer one makes the version unreadable. */
export const REASON_MAX = RECIPE_REASON_MAX

const VersionSchema = RecipeVersionRecordSchema
export type RecipeVersion = Omit<z.infer<typeof VersionSchema>, "recipe"> & { recipe: Recipe }

const PointerSchema = z.object({ version: z.number().int().positive() }).strict()
/** A draft nobody has saved over or published in this long is deleted; published versions are kept. */
const DRAFT_KEEP_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A project's versions, beside its published recipe: `<n>.json` for each,
 * `published.json` naming the one in `<project>.json`, `drafts/<app>.json`
 * for the draft an app runs instead, and `running/<app>.json` for the
 * version a running app started with.
 */
export function recipeVersions(file: string): string {
  return join(dirname(file), "versions", basename(file, ".json"))
}

function recipeText(recipe: Recipe): string {
  return `${JSON.stringify(recipe, null, 2)}\n`
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function pointer(path: string): Promise<number | undefined> {
  const read = await readJson(path).catch((): JsonRead => ({ kind: "absent" }))
  if (read.kind !== "json") return undefined
  const parsed = PointerSchema.safeParse(read.value)
  return parsed.success ? parsed.data.version : undefined
}

function appFile(folder: string, kind: "drafts" | "running", app: AppKey): string {
  return join(folder, kind, `${AppKeySchema.parse(app)}.json`)
}

export async function readVersion(file: string, version: number): Promise<RecipeVersion | undefined> {
  const read = await readJson(join(recipeVersions(file), `${version}.json`)).catch((): JsonRead => ({ kind: "absent" }))
  if (read.kind !== "json") return undefined
  const parsed = VersionSchema.safeParse(read.value)
  const recipe = parsed.success ? RecipeSchema.safeParse(parsed.data.recipe) : undefined
  return parsed.success && recipe?.success ? { ...parsed.data, recipe: recipe.data } : undefined
}

async function writeVersion(file: string, record: RecipeVersion, flag?: "wx"): Promise<void> {
  const path = join(recipeVersions(file), `${record.version}.json`)
  const text = `${JSON.stringify(record, null, 2)}\n`
  if (flag) await writeFile(path, text, { mode: 0o600, flag })
  else await writeAtomic(path, text)
}

export async function versionNumbers(file: string): Promise<number[]> {
  const names = await readdir(recipeVersions(file)).catch(() => [])
  return names.flatMap((name) => /^(\d+)\.json$/.exec(name)?.[1] ?? []).map(Number).sort((a, b) => a - b)
}

/** The published version's number, giving a recipe published before versions existed the first. */
export async function publishedVersion(file: string, now = Date.now()): Promise<number | undefined> {
  const folder = recipeVersions(file)
  const current = await pointer(join(folder, "published.json"))
  if (current !== undefined) return current
  const read = await readJson(file).catch((): JsonRead => ({ kind: "absent" }))
  const recipe = read.kind === "json" ? RecipeSchema.safeParse(read.value) : undefined
  if (!recipe?.success) return undefined
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const first = ((await versionNumbers(file)).at(-1) ?? 0) + 1
  const savedAt = (await stat(file).catch(() => undefined))?.mtimeMs ?? now
  await writeVersion(file, { version: first, state: "published", savedAt: Math.round(savedAt), reason: "Published before Mako kept versions", recipe: recipe.data, publishedAt: Math.round(savedAt) }, "wx").catch(() => {})
  await writeAtomic(join(folder, "published.json"), `${JSON.stringify({ version: first })}\n`)
  return first
}

/** The draft `app` runs instead of the published recipe, if it has one. */
export async function appDraft(file: string, app: AppKey): Promise<RecipeVersion | undefined> {
  const version = await pointer(appFile(recipeVersions(file), "drafts", app))
  const record = version === undefined ? undefined : await readVersion(file, version)
  return record?.state === "draft" ? record : undefined
}

export interface SavedDraft {
  file: string
  /** The draft now, or the published version when what was saved is what's published. */
  version: RecipeVersion
  published?: number
}

/**
 * Saves `recipe` as a draft of `checkout`'s project that only `app` runs,
 * made from the published version. Saving what's published drops the app's
 * draft; saving its draft again changes nothing. Refuses a recipe this
 * checkout can't run.
 */
export async function saveDraft(
  git: Git,
  recipesRoot: string,
  checkout: string,
  recipe: Recipe,
  environment: ThreadEnvironment,
  saved: { by?: string; reason?: string },
  now = Date.now(),
  authority?: RecipeAuthority,
): Promise<SavedDraft> {
  const problem = await recipeProblem(recipe, checkout, environment)
  if (problem) throw new Error(`Not saved: ${problem}`)
  const text = recipeText(recipe)
  if (Buffer.byteLength(text) > RECIPE_MAX_BYTES) throw new Error(`Not saved: larger than ${RECIPE_MAX_BYTES / 1024} KB`)
  const file = await recipePath(git, recipesRoot, checkout)
  const folder = recipeVersions(file)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  // A project the account keeps is numbered there only: its mirror says what's published, never this store's guess.
  const published = authority ? await pointer(join(folder, "published.json")) : await publishedVersion(file, now)
  const draftFile = appFile(folder, "drafts", environment.app)
  const current = published === undefined ? undefined : await readVersion(file, published)
  if (current && recipeText(current.recipe) === text) {
    await rm(draftFile, { force: true })
    return { file, version: current, published }
  }
  const draft = await appDraft(file, environment.app)
  if (draft && draft.parent === published && recipeText(draft.recipe) === text) {
    const saved: SavedDraft = { file, version: draft }
    if (published !== undefined) saved.published = published
    return saved
  }
  if (authority) {
    const request: RecipeSave = { id: randomUUID(), savedAt: now, app: environment.app, recipe }
    if (published !== undefined) request.parent = published
    if (saved.by) request.by = saved.by
    if (saved.reason) request.reason = saved.reason
    const record = mirrored(await authority.save(request))
    await writeVersion(file, record)
    await writeAtomic(draftFile, `${JSON.stringify({ version: record.version })}\n`)
    const result: SavedDraft = { file, version: record }
    if (published !== undefined) result.published = published
    return result
  }
  const record: RecipeVersion = { version: 0, state: "draft", savedAt: now, app: environment.app, recipe }
  if (published !== undefined) record.parent = published
  if (saved.by) record.by = saved.by
  if (saved.reason) record.reason = saved.reason
  for (let next = ((await versionNumbers(file)).at(-1) ?? 0) + 1; ; next += 1) {
    try {
      await writeVersion(file, { ...record, version: next }, "wx")
      record.version = next
      break
    } catch (error) {
      if (!z.object({ code: z.literal("EEXIST") }).safeParse(error).success) throw error
    }
  }
  await writeAtomic(draftFile, `${JSON.stringify({ version: record.version })}\n`)
  await pruneDrafts(file, now)
  const result: SavedDraft = { file, version: record }
  if (published !== undefined) result.published = published
  return result
}

async function pruneDrafts(file: string, now: number): Promise<void> {
  const folder = recipeVersions(file)
  const held = new Set(await Promise.all((await readdir(join(folder, "drafts")).catch(() => [])).map((name) => pointer(join(folder, "drafts", name)))))
  for (const version of await versionNumbers(file)) {
    if (held.has(version)) continue
    const record = await readVersion(file, version)
    if (record?.state === "draft" && now - record.savedAt > DRAFT_KEEP_MS) await rm(join(folder, `${version}.json`), { force: true })
  }
}

/** Records a proof that didn't pass, so the version says how it last went. */
export async function recordProof(file: string, version: number, proof: RecipeProof, authority?: RecipeAuthority): Promise<void> {
  if (authority) return writeVersion(file, mirrored(await authority.prove({ version, proof })))
  const record = await readVersion(file, version)
  if (record) await writeVersion(file, withProof(record, proof))
}

/** A version with `proof` as its last, and as its last in the place it ran. */
function withProof(record: RecipeVersion, proof: RecipeProof): RecipeVersion {
  return { ...record, proof, proofs: { ...placedProofs(record), [proof.place ?? "local"]: proof } }
}

/** The last proof of a version in each place, reading one from before places as this computer's. */
export function placedProofs(record: Pick<RecipeVersion, "proof" | "proofs">): { local?: RecipeProof; cloud?: RecipeProof } {
  if (record.proofs) return record.proofs
  return record.proof ? { [record.proof.place ?? "local"]: record.proof } : {}
}

/** A draft made from a version that's no longer the published one: publishing it would undo what was published since. */
export class StaleDraftError extends Error {
  readonly published: RecipeVersion | undefined
  constructor(message: string, published: RecipeVersion | undefined) {
    super(message)
    this.published = published
  }
}

/**
 * Publishes `app`'s draft with its proof: every Thread of the project uses
 * it from its next start. Refused when another version was published since
 * the draft was made from one.
 */
export async function publishDraft(file: string, app: AppKey, version: number, proof: RecipeProof, now = Date.now(), authority?: RecipeAuthority): Promise<RecipeVersion> {
  const folder = recipeVersions(file)
  if (authority) {
    // The account compares and sets what's published in one turn: of two places publishing at once, one wins.
    const answer = await authority.publish({ version, proof, publishedAt: now })
    if (!answer.ok) {
      const current = answer.published ? mirrored(answer.published) : undefined
      if (current) await mirrorPublished(file, current)
      throw new StaleDraftError(answer.reason, current)
    }
    const done = mirrored(answer.record)
    await mirrorPublished(file, done)
    if ((await pointer(appFile(folder, "drafts", app))) === version) await rm(appFile(folder, "drafts", app), { force: true })
    return done
  }
  const record = await readVersion(file, version)
  if (!record || record.state !== "draft") throw new Error(`Version ${version} isn't a draft any more.`)
  const published = await publishedVersion(file, now)
  if (published !== record.parent) {
    const current = published === undefined ? undefined : await readVersion(file, published)
    throw new StaleDraftError(`Version ${published} was published after this draft was made from ${record.parent === undefined ? "nothing" : `version ${record.parent}`}.`, current)
  }
  const done: RecipeVersion = { ...withProof(record, proof), state: "published", publishedAt: now }
  await writeVersion(file, done)
  await writeAtomic(join(folder, "published.json"), `${JSON.stringify({ version })}\n`)
  await writeAtomic(file, recipeText(record.recipe))
  if ((await pointer(appFile(folder, "drafts", app))) === version) await rm(appFile(folder, "drafts", app), { force: true })
  return done
}

/** The version `app`'s processes started with, kept while they run. */
export async function runningVersion(file: string, app: AppKey): Promise<number | undefined> {
  return pointer(appFile(recipeVersions(file), "running", app))
}

export async function pinRunning(file: string, app: AppKey, version: number): Promise<void> {
  await writeAtomic(appFile(recipeVersions(file), "running", app), `${JSON.stringify({ version })}\n`)
}

export async function unpinRunning(file: string, app: AppKey): Promise<void> {
  await rm(appFile(recipeVersions(file), "running", app), { force: true })
}

/** How many versions a project has kept. */
export async function versionCount(file: string): Promise<number> {
  return (await versionNumbers(file)).length
}

export interface VersionHistory {
  /** Newest first: `app`'s draft, when it has one, and the newest published versions. */
  entries: RecipeVersionView[]
  /** Every version kept, oldest first, drafts of other apps among them. */
  kept: number[]
}

function proofSummary(proof: RecipeProof): RecipeProofSummary {
  const failed = proof.steps.find((step) => !step.passed)
  return failed ? { at: proof.at, passed: false, failed: failed.name } : { at: proof.at, passed: true }
}

async function versionEntry(file: string, version: number, published: number | undefined): Promise<RecipeVersionView | undefined> {
  const read = await readJson(join(recipeVersions(file), `${version}.json`)).catch((): JsonRead => ({ kind: "absent" }))
  if (read.kind !== "json") return undefined
  const parsed = VersionSchema.safeParse(read.value)
  if (!parsed.success) return undefined
  const { state, savedAt, parent, by, reason, publishedAt, recipe, proof } = parsed.data
  const entry: RecipeVersionView = { version, state, current: version === published, savedAt, readable: RecipeSchema.safeParse(recipe).success }
  if (parent !== undefined) entry.parent = parent
  if (by) entry.by = by
  if (reason) entry.reason = reason
  if (publishedAt !== undefined) entry.publishedAt = publishedAt
  if (proof) entry.proof = proofSummary(proof)
  const placed = placedProofs(parsed.data)
  if (placed.local || placed.cloud) {
    entry.places = {}
    if (placed.local) entry.places.local = proofSummary(placed.local)
    if (placed.cloud) entry.places.cloud = proofSummary(placed.cloud)
  }
  return entry
}

/**
 * The versions to choose from when going back: `app`'s draft and the newest
 * `limit` published ones. Other apps' drafts are another Thread's work in
 * progress, so they're counted in `kept` but not listed. Reads from the
 * newest down and stops once it has them, however long the history.
 */
export async function versionHistory(file: string, app: AppKey | undefined, limit: number): Promise<VersionHistory> {
  const kept = await versionNumbers(file)
  const folder = recipeVersions(file)
  const [published, draft] = await Promise.all([
    pointer(join(folder, "published.json")),
    app === undefined ? undefined : pointer(appFile(folder, "drafts", app)),
  ])
  const entries: RecipeVersionView[] = []
  let left = limit
  for (const version of [...kept].reverse()) {
    if (!left && (draft === undefined || version < draft)) break
    const entry = await versionEntry(file, version, published)
    if (entry?.state === "published" && left) {
      entries.push(entry)
      left -= 1
    }
    else if (entry?.state === "draft" && version === draft) entries.push(entry)
  }
  return { entries, kept }
}

// The account's authority

/** A version as the authority sent it, its recipe read as this build reads one; a recipe it can't read stays as sent. */
function mirrored(record: RecipeVersionRecord): RecipeVersion {
  const recipe = RecipeSchema.safeParse(record.recipe)
  // SAFETY: a recipe this build can't read is kept as the authority sent it; `readVersion` reads it as unreadable.
  return { ...record, recipe: (recipe.success ? recipe.data : record.recipe) as Recipe }
}

/** A version the authority says is published: its record, the pointer to it and the project's recipe file. */
async function mirrorPublished(file: string, record: RecipeVersion): Promise<void> {
  await writeVersion(file, record)
  await writeAtomic(join(recipeVersions(file), "published.json"), `${JSON.stringify({ version: record.version })}\n`)
  if (RecipeSchema.safeParse(record.recipe).success) await writeAtomic(file, recipeText(record.recipe))
}

const SyncedSchema = z.object({ authority: z.string(), change: z.number().int().nonnegative() }).strict()

/** How a store took its project's versions from the authority: what changed, and what of its own it gave or set aside. */
export type RecipeSync = { change: number; taken: number; adopted?: number; setAside?: string }

/** The store's mirror of `authority`, if it has ever taken one: the project is the account's from then on. */
export async function syncedWith(file: string): Promise<z.infer<typeof SyncedSchema> | undefined> {
  const read = await readJson(join(recipeVersions(file), "synced.json")).catch((): JsonRead => ({ kind: "absent" }))
  const parsed = read.kind === "json" ? SyncedSchema.safeParse(read.value) : undefined
  return parsed?.success ? parsed.data : undefined
}

/**
 * Takes what changed at the project's authority since this store last asked, into its own files: each version,
 * the published one's pointer and its recipe. The first time, the account takes this store's history when it keeps
 * none; when it keeps another, versions of this store's that aren't the account's are set aside in a folder beside
 * them, never stitched in, and the account's are the project's. The cursor is written last, so a sync cut short
 * takes the same changes again.
 */
export async function syncRecipe(file: string, authority: RecipeAuthority, now = Date.now()): Promise<RecipeSync> {
  const folder = recipeVersions(file)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const synced = await syncedWith(file)
  const result: RecipeSync = { change: 0, taken: 0 }
  let after = synced?.authority === authority.id ? synced.change : 0
  if (synced?.authority !== authority.id) {
    // This store's history as it stands, a recipe saved before versions included.
    const published = await publishedVersion(file, now)
    const own = (await Promise.all((await versionNumbers(file)).map((version) => readVersion(file, version)))).flatMap((record) => (record ? [record] : []))
    const first = await authority.changes(0)
    const adopted = own.length > 0 && first.change === 0 && (await authority.adopt({ versions: own, published: published ?? null })).adopted
    if (adopted) result.adopted = own.length
    else if (own.length) {
      const theirs = await allVersions(authority)
      const differs = own.some((record) => {
        const kept = theirs.get(record.version)
        return !kept || kept.state !== record.state || JSON.stringify(kept.recipe) !== JSON.stringify(record.recipe)
      })
      if (differs) {
        result.setAside = `${folder}.set-aside-${now}`
        await rename(folder, result.setAside)
        await mkdir(folder, { recursive: true, mode: 0o700 })
      }
    }
  }
  for (;;) {
    const changes = await authority.changes(after)
    for (const record of changes.versions) await writeVersion(file, mirrored(record))
    result.taken += changes.versions.length
    after = changes.change
    if (!changes.more) {
      if (changes.published !== null) {
        const record = await readVersion(file, changes.published)
        if (record) await mirrorPublished(file, record)
      }
      break
    }
  }
  await writeAtomic(join(folder, "synced.json"), `${JSON.stringify({ authority: authority.id, change: after })}\n`)
  result.change = after
  return result
}

async function allVersions(authority: RecipeAuthority): Promise<Map<number, RecipeVersionRecord>> {
  const all = new Map<number, RecipeVersionRecord>()
  for (let after = 0; ; ) {
    const changes = await authority.changes(after)
    for (const record of changes.versions) all.set(record.version, record)
    after = changes.change
    if (!changes.more) return all
  }
}

/** A project the account keeps whose authority can't be reached now: a version saved or published here would be numbered apart from the others. */
export class RecipeUnreachableError extends Error {}

/** Whether a refusal says the account doesn't keep recipes for this caller (signed out, or no cloud), not that it can't be reached. */
export type RecipeAuthorityOf = (checkout: string) => Promise<RecipeAuthority | undefined>

/**
 * The projects the account keeps the recipes of, as one host works with them: the authority for a checkout's
 * project, and each store kept in step with it. A read asks for what changed at most every `freshMs`, one ask at a
 * time per store, and never fails: a store that can't reach its authority reads what it took last. A write needs the
 * authority once the store has taken it, and says so when it can't be reached; a project the account doesn't keep
 * (no repository it knows, signed out, no cloud) is this store's alone, as before.
 */
export class RecipeAccounts {
  readonly #of: RecipeAuthorityOf
  readonly #freshMs: number
  readonly #stores = new Map<string, { at: number; authority?: RecipeAuthority; flight?: Promise<RecipeAuthority | undefined>; failed?: string }>()
  readonly #log: (message: string, fields: Record<string, string | number>) => void

  constructor(of: RecipeAuthorityOf, options: { freshMs?: number; log?: (message: string, fields: Record<string, string | number>) => void } = {}) {
    this.#of = of
    this.#freshMs = options.freshMs ?? 3_000
    this.#log = options.log ?? (() => undefined)
  }

  /** The authority `file`'s store mirrors, kept fresh for a read; undefined for a project the account doesn't keep. */
  async forRead(file: string, checkout: string): Promise<RecipeAuthority | undefined> {
    return (await this.#fresh(file, checkout, false).catch(() => undefined)) ?? undefined
  }

  /** The authority a write goes through, the store fresh first; undefined for a project the account doesn't keep. */
  async forWrite(file: string, checkout: string): Promise<RecipeAuthority | undefined> {
    return this.#fresh(file, checkout, true)
  }

  /** What went wrong the last time `file`'s store asked its authority, for a status that says why it may be behind. */
  failure(file: string): string | undefined {
    return this.#stores.get(file)?.failed
  }

  async #fresh(file: string, checkout: string, force: boolean): Promise<RecipeAuthority | undefined> {
    const state = this.#stores.get(file) ?? { at: 0 }
    this.#stores.set(file, state)
    if (state.flight) return state.flight
    // Within a few seconds of the last look, a read takes what it found then, the authority or that there's none.
    if (!force && Date.now() - state.at < this.#freshMs && !state.failed) return state.authority
    const authority = await this.#of(checkout)
    state.authority = authority
    if (!authority) {
      state.at = Date.now()
      return undefined
    }
    const flight = (async () => {
      const started = performance.now()
      try {
        const synced = await syncRecipe(file, authority)
        state.at = Date.now()
        state.failed = undefined
        if (synced.taken || synced.adopted || synced.setAside) this.#log("recipe versions taken", { file, taken: synced.taken, adopted: synced.adopted ?? 0, setAside: synced.setAside ?? "", ms: Math.round(performance.now() - started) })
        return authority
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // The account keeps no recipes for this caller: a project it was never taken by stays this store's own.
        if (z.object({ status: z.union([z.literal(401), z.literal(403)]) }).safeParse(error).success && !(await syncedWith(file))) {
          state.authority = undefined
          state.at = Date.now()
          return undefined
        }
        state.failed = message
        this.#log("recipe versions not taken", { file, error: message })
        if (force || (await syncedWith(file))) throw new RecipeUnreachableError(`Mako couldn't reach your account, which keeps this project's recipe versions, so nothing was kept (${message}). The recipe it has is still what runs; try again in a moment.`)
        return undefined
      } finally {
        state.flight = undefined
      }
    })()
    state.flight = flight
    return flight
  }
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

/** What a cleanup runs with: the recipe's values and its processes' own, which name what they made; a name processes set differently is left out. */
export function cleanupValues(recipe: Recipe, environment: ThreadEnvironment) {
  const agreed = new Map<string, string>()
  const differ = new Set<string>()
  for (const spec of Object.values(recipe.processes)) {
    for (const [name, text] of Object.entries(spec.values ?? {})) {
      const value = expandTemplate(text, environment)
      if (agreed.has(name) && agreed.get(name) !== value) differ.add(name)
      agreed.set(name, value)
    }
  }
  for (const name of differ) agreed.delete(name)
  return { ...recipeValues(recipe, environment), ...Object.fromEntries(agreed) }
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
async function inputFiles(git: Git, checkout: string, folder: string): Promise<string[]> {
  const listed = await git.output(checkout, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", folder]).then(
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
export async function inputsDigest(git: Git, checkout: string, inputs: string[]): Promise<string> {
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
    else if (entry.isDirectory()) for (const file of await inputFiles(git, checkout, relative(checkout, resolve(checkout, input)) || ".")) await add(file)
    else if (entry.isFile()) await add(relative(checkout, resolve(checkout, input)))
  }
  return hash.digest("hex")
}

/**
 * The project's recipe as written, saved in Mako or committed, without
 * checking it against a Thread: what a new checkout takes from the main one
 * needs no ports. Undefined when there is none, or it doesn't parse.
 */
export async function projectRecipe(git: Git, checkout: string, recipesRoot: string | undefined): Promise<Recipe | undefined> {
  const read = await readProjectRecipe(git, checkout, recipesRoot)
  return read.kind === "recipe" ? read.recipe : undefined
}

/**
 * `projectRecipe`, saying which of three it found: no recipe at all, one, or
 * one it couldn't read (not JSON, not a recipe, or a file it couldn't open),
 * for a caller that must never take "unreadable" for "says nothing".
 */
export type ProjectRecipeRead = { kind: "absent" } | { kind: "recipe"; recipe: Recipe } | { kind: "unreadable"; why: string }

export async function readProjectRecipe(git: Git, checkout: string, recipesRoot: string | undefined): Promise<ProjectRecipeRead> {
  const unreadable = (error: Error): JsonRead => ({ kind: "invalid", message: error.message })
  const saved = recipesRoot ? await recipePath(git, recipesRoot, checkout).then(readJson).catch(unreadable) : { kind: "absent" as const }
  const read = saved.kind === "absent" ? await readJson(join(checkout, RECIPE_PATH)).catch(unreadable) : saved
  if (read.kind === "absent") return read
  if (read.kind === "invalid") return { kind: "unreadable", why: read.message }
  const parsed = RecipeSchema.safeParse(read.value)
  return parsed.success ? { kind: "recipe", recipe: parsed.data } : { kind: "unreadable", why: recipeIssues(parsed.error) }
}
