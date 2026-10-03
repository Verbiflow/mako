import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { AppKeySchema, type AppKey, type ThreadEnvironment } from "./contracts/thread-environments.js"
import { git } from "./worktree-git.js"

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
}).strict()

/**
 * How Mako proves a new version of the recipe before it reaches every
 * Thread: `run` is a command Mako runs against the started app, passing on
 * exit 0; `check` is what the agent publishing it goes and sees for itself,
 * by any means (the app, its logs, Mako's computer control), and reports.
 */
const verifySchema = z.union([
  z.object({ run: command }).strict(),
  z.object({ check: z.string().trim().min(1).max(2_000) }).strict(),
])
export type RecipeVerify = z.infer<typeof verifySchema>

const processName = /^[a-z][a-z0-9-]{0,31}$/

const targetSchema = z.object({
  /** The recipe's processes this target runs, such as the API and the desktop app. */
  processes: z.array(z.string().regex(processName, "a process name")).min(1).max(20),
  /** Its own full check, in place of the recipe's. */
  full: command.optional(),
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
   * A new checkout's package folders link each package to the main
   * checkout's, in a second, instead of cloning them. An install must
   * never run over the links, since it writes through them into the main
   * checkout; Mako gives the checkout its own copy first. The default for a
   * step whose outputs are all package folders; `false` clones them instead,
   * for a bundler that doesn't follow links.
   */
  link: z.boolean().optional(),
}).strict().refine(
  (step) => !step.link || packageFolders(step.outputs),
  { message: "link is for package folders: give outputs such as **/node_modules, and nothing else", path: ["link"] },
).transform((step) => (step.link === undefined && packageFolders(step.outputs) ? { ...step, link: true } : step))

function packageFolders(outputs: readonly string[] | undefined): boolean {
  return Boolean(outputs?.length && outputs.every((pattern) => pattern.split("/").at(-1) === "node_modules"))
}

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
  /** How a new version is proven before it's published; with no `verify`, a version that installs and starts is published. */
  verify: verifySchema.optional(),
  /**
   * Undoes what a Thread's app leaves outside its checkout, such as its
   * containers' volumes or its database, when its worktree is removed.
   */
  cleanup: command.optional(),
}).strict()

export type Recipe = z.infer<typeof RecipeSchema>
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
    }
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
  const verifyRun = (path: string, verify: RecipeVerify | undefined): [string, string][] => verify && "run" in verify ? [[`${path}.run`, verify.run]] : []
  const commands: [string, string][] = [
    ...Object.entries(recipe.processes).flatMap(([name, spec]): [string, string][] => [
      [`processes.${name}.command`, spec.command],
      ...optionalCommand(`processes.${name}.ready`, spec.ready),
    ]),
    ...Object.entries(recipe.checks).flatMap(([tier, command]): [string, string][] => command ? [[`checks.${tier}`, command]] : []),
    ...recipe.prepare.map((step, index): [string, string] => [`prepare.${index}.command`, step.command]),
    ...verifyRun("verify", recipe.verify),
    ...Object.entries(recipe.targets ?? {}).flatMap(([name, target]): [string, string][] => [
      ...optionalCommand(`targets.${name}.full`, target.full),
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

const ProofStepSchema = z.object({
  /** Such as `install`, `start`, `verify` or `verify web`. */
  name: z.string().max(100),
  passed: z.boolean(),
  ms: z.number().nonnegative().optional(),
  /** For a step Mako ran. */
  command: z.string().max(4_000).optional(),
  /** For a check the agent made: what it did and saw. */
  how: z.string().max(4_000).optional(),
}).strict()

const ProofSchema = z.object({
  at: z.number(),
  /** Where it ran: `this Mac`; a cloud environment has a proof of its own. */
  on: z.string(),
  checkout: z.string(),
  by: z.string().max(300).optional(),
  steps: z.array(ProofStepSchema).max(50),
}).strict()
export type RecipeProof = z.infer<typeof ProofSchema>
export type RecipeProofStep = z.infer<typeof ProofStepSchema>

const VersionSchema = z.object({
  version: z.number().int().positive(),
  /** The published version it was made from; none for a project's first. */
  parent: z.number().int().positive().optional(),
  state: z.enum(["draft", "published"]),
  savedAt: z.number(),
  /** Who saved it, such as `the Thread "Fix login" (codex)`. */
  by: z.string().max(300).optional(),
  reason: z.string().max(500).optional(),
  /** The app that saved it, the only one that runs it while it's a draft. */
  app: AppKeySchema.optional(),
  recipe: z.unknown(),
  /** The last proof run of it, passed or not. */
  proof: ProofSchema.optional(),
  publishedAt: z.number().optional(),
}).strict()
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

async function versionNumbers(file: string): Promise<number[]> {
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
  recipesRoot: string,
  checkout: string,
  recipe: Recipe,
  environment: ThreadEnvironment,
  saved: { by?: string; reason?: string },
  now = Date.now(),
): Promise<SavedDraft> {
  const problem = await recipeProblem(recipe, checkout, environment)
  if (problem) throw new Error(`Not saved: ${problem}`)
  const text = recipeText(recipe)
  if (Buffer.byteLength(text) > RECIPE_MAX_BYTES) throw new Error(`Not saved: larger than ${RECIPE_MAX_BYTES / 1024} KB`)
  const file = await recipePath(recipesRoot, checkout)
  const folder = recipeVersions(file)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const published = await publishedVersion(file, now)
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
export async function recordProof(file: string, version: number, proof: RecipeProof): Promise<void> {
  const record = await readVersion(file, version)
  if (record) await writeVersion(file, { ...record, proof })
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
export async function publishDraft(file: string, app: AppKey, version: number, proof: RecipeProof, now = Date.now()): Promise<RecipeVersion> {
  const record = await readVersion(file, version)
  if (!record || record.state !== "draft") throw new Error(`Version ${version} isn't a draft any more.`)
  const published = await publishedVersion(file, now)
  if (published !== record.parent) {
    const current = published === undefined ? undefined : await readVersion(file, published)
    throw new StaleDraftError(`Version ${published} was published after this draft was made from ${record.parent === undefined ? "nothing" : `version ${record.parent}`}.`, current)
  }
  const done: RecipeVersion = { ...record, state: "published", proof, publishedAt: now }
  await writeVersion(file, done)
  const folder = recipeVersions(file)
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
