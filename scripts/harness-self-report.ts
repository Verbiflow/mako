import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"
import { parseArgs } from "node:util"
import { VOCABULARIES, type HarnessConcepts } from "@mako/sessions/harnesses"
import { z } from "zod"
import { resolveExecutable } from "../electron/executable.ts"
import { resolveCodexExecutable } from "../electron/providers/codex/executable.ts"
import { devinExecutable } from "../electron/providers/devin/executable.ts"

/**
 * Records what a harness says about itself, names only, as the fixtures its
 * vocabulary is checked against (`scripts/test-harness-vocabulary.ts`).
 *
 *   npm run harness:self-report -- <harness>
 *
 * Every harness: the installed build (binary, or the SDK's bundle) is searched
 * for each instruction file name and hook event its concepts declare, and the
 * version, the count and the names it lacks are written to
 * `fixtures/native-vocabulary/<harness>-concepts.json`. No session starts and
 * nothing is read from the person's own files.
 *
 * Claude also: a print run on the light model, stopped at its `system/init`,
 * which Claude sends before calling the model; keeps the version, built-in
 * tool names, agent names and protocol capabilities, never a prompt, a path,
 * a skill or a credential.
 *
 * Claude, Codex, OpenCode, Grok and Devin also: the harness's own listing of
 * its skills or MCP servers, run with a throwaway home and project holding
 * one probe in each folder and file its concepts declare it reads. Cursor's
 * SDK lists nothing without an agent, so its skill folders are read from the
 * root table in the SDK's own bundle.
 */

const run = promisify(execFile)
const { positionals } = parseArgs({ allowPositionals: true })
const harness = positionals[0]
const vocabulary = VOCABULARIES.find((entry) => entry.harness === harness)
if (!vocabulary) throw new Error(`usage: npm run harness:self-report -- <${VOCABULARIES.map((entry) => entry.harness).join("|")}>`)
const fixtures = new URL("./fixtures/native-vocabulary/", import.meta.url)

interface Build {
  version: string
  /** The files searched: the executable, or every module of an SDK. */
  files: string[]
}

async function executableBuild(executable: string | null, versionArgs = ["--version"]): Promise<Build> {
  if (!executable) throw new Error(`${harness} is not installed`)
  const { stdout } = await run(executable, versionArgs, { timeout: 20_000 })
  const version = /\d+(?:\.\d+)+/.exec(stdout)?.[0]
  if (!version) throw new Error(`${harness} printed no version: ${stdout.slice(0, 80)}`)
  return { version, files: [await realpath(executable)] }
}

async function codexBinary(): Promise<string | null> {
  const launcher = await resolveCodexExecutable()
  if (!launcher) return null
  const real = await realpath(launcher)
  if (!real.endsWith(".js")) return real
  // The npm launcher runs a native binary from its platform package.
  const vendor = join(dirname(real), "..", "node_modules", `@openai/codex-${process.platform}-${process.arch}`, "vendor")
  const [target] = await readdir(vendor)
  return target ? join(vendor, target, "bin", "codex") : null
}

async function cursorSdk(): Promise<Build> {
  const root = new URL("../node_modules/@cursor/sdk/", import.meta.url)
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL("package.json", root), "utf8")))
  const esm = new URL("dist/esm/", root).pathname
  const files = (await readdir(esm, { recursive: true })).filter((name) => name.endsWith(".js")).map((name) => join(esm, name))
  return { version, files }
}

const builds = new Map<string, () => Promise<Build>>([
  ["claude", () => executableBuild(resolveExecutable("claude", process.env))],
  ["codex", async () => executableBuild(await codexBinary())],
  ["cursor", cursorSdk],
  ["opencode", () => executableBuild(resolveExecutable("opencode", process.env))],
  ["grok", () => executableBuild(resolveExecutable("grok", process.env))],
  ["devin", () => executableBuild(devinExecutable())],
])

/** The literals a build must contain: instruction file names, and hook events unless they're composed at run time. */
function probedLiterals(concepts: HarnessConcepts): string[] {
  const files = concepts.instructions.files.map((file) => basename(file))
  const events = "events" in concepts.hooks && !concepts.hooks.composed ? concepts.hooks.events : []
  return [...new Set([...files, ...events])]
}

async function missingLiterals(build: Build, literals: string[]): Promise<string[]> {
  const left = new Set(literals)
  for (const file of build.files) {
    const bytes = await readFile(file)
    for (const literal of left) if (bytes.includes(literal)) left.delete(literal)
    if (!left.size) break
  }
  return [...left]
}

interface Sandbox {
  home: string
  project: string
  /** The harness's environment, its home moved into the sandbox. */
  env: NodeJS.ProcessEnv
}

/**
 * A harness's own listing of what it loads, run in a sandbox holding one
 * probe in each place its concepts declare: a skill in each skill folder, a
 * server in each MCP file. Returns the listing's text, which names the probes
 * it found.
 */
type Listing = (executable: string, sandbox: Sandbox) => Promise<string>

/** How a harness's own configuration names one MCP server, for the probe files. */
type McpProbeFormat = "mcpServers" | "opencode"

interface Listings {
  executable: () => Promise<string | null>
  skills?: Listing
  mcpConfig?: Listing
  mcpFormat?: McpProbeFormat
}

/** A listing command's output. Probe servers fail health checks, which some listings report through their exit code. */
const cliListing = (args: string[]): Listing => (executable, { project, env }) =>
  new Promise((resolve, reject) => execFile(executable, args, { cwd: project, env, timeout: 30_000 }, (error, stdout) =>
    stdout || !error ? resolve(stdout) : reject(error)))

const AppServerReply = z.object({ id: z.number() }).loose()
type AppServerReply = z.infer<typeof AppServerReply>
interface AppServerParams {
  clientInfo?: { name: string; version: string }
  cwds?: string[]
  forceReload?: boolean
}

async function codexSkillList(executable: string, { project, env }: Sandbox): Promise<string> {
  const child = spawn(executable, ["app-server"], { cwd: project, env, stdio: ["pipe", "pipe", "ignore"] })
  const replies = new Map<number, (reply: AppServerReply) => void>()
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    try {
      const reply = AppServerReply.parse(JSON.parse(line))
      replies.get(reply.id)?.(reply)
    } catch {
      // Notifications and other harness output.
    }
  })
  let next = 0
  const call = (method: string, params: AppServerParams) => new Promise<AppServerReply>((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => reject(new Error(`codex app-server did not answer ${method}`)), 20_000)
    replies.set(id, (value) => { clearTimeout(timer); resolve(value) })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  try {
    await call("initialize", { clientInfo: { name: "mako-self-report", version: "0" } })
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`)
    const reply = z.object({ result: z.object({ data: z.array(z.object({ skills: z.array(z.object({ name: z.string() }).loose()) }).loose()) }) })
      .parse(await call("skills/list", { cwds: [project], forceReload: true }))
    return reply.result.data.flatMap((entry) => entry.skills.map((skill) => skill.name)).join("\n")
  } finally {
    lines.close()
    child.kill()
  }
}

/**
 * OpenCode answers its listings from a server. Its background service owns
 * one fixed port per machine, so the listing starts a private server on a
 * free port with a throwaway password, and asks until two answers agree:
 * skills register after the server's plugins activate, not when it listens.
 */
const openCodeListing = (path: string): Listing => async (executable, { project, env }) => {
  const serverEnv = { ...env, OPENCODE_SERVER_PASSWORD: randomUUID() }
  const server = spawn(executable, ["serve", "--port", "0"], { cwd: project, env: serverEnv, stdio: ["ignore", "pipe", "pipe"], detached: true })
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("opencode serve did not report its address")), 20_000)
      const read = (chunk: Buffer) => {
        const address = /server listening on (http:\/\/\S+)/.exec(chunk.toString())?.[1]
        if (address) { clearTimeout(timer); resolve(address) }
      }
      server.stdout.on("data", read)
      server.stderr.on("data", read)
      server.once("exit", () => reject(new Error("opencode serve exited before listening")))
    })
    let previous = ""
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(1_500)) {
      const { stdout } = await run(executable, ["api", "--server", url, "GET", path], { cwd: project, env: serverEnv, timeout: 20_000 })
      if (stdout.includes("mako-probe-") && stdout === previous) return stdout
      previous = stdout
    }
    return previous
  } finally {
    if (server.pid) process.kill(-server.pid, "SIGTERM")
  }
}

/**
 * The skill folders Cursor's SDK reads, from the root table in the bundle
 * Mako runs: each entry is read in the project and the home, a builtin one in
 * the home only. A table that moved or changed shape reads as no folders, so
 * every declared one shows as missing.
 */
async function cursorSkillTable(): Promise<string> {
  const places: string[] = []
  for (const file of (await cursorSdk()).files) {
    for (const [, dir, subdir, , builtin] of (await readFile(file, "utf8")).matchAll(/\{configDir:"([^"]+)",subdir:"([^"]+)",thirdParty:!([01]),builtin:!([01])\}/g))
      // Minified: `!1` is false, `!0` true.
      places.push(...builtin === "1" ? [`${dir}/${subdir}`, `~/${dir}/${subdir}`] : [`~/${dir}/${subdir}`])
  }
  return places.join("\n")
}

/**
 * How each harness says where it reads: its own listing where one answers
 * without an account or a model call, else the table in the code it runs.
 */
const listings = new Map<string, Listings>([
  ["claude", { executable: async () => resolveExecutable("claude", process.env), mcpConfig: cliListing(["mcp", "list"]) }],
  ["codex", { executable: () => resolveCodexExecutable(), skills: codexSkillList }],
  ["opencode", { executable: async () => resolveExecutable("opencode", process.env), skills: openCodeListing("/api/skill"), mcpConfig: openCodeListing("/api/mcp"), mcpFormat: "opencode" }],
  ["grok", { executable: async () => resolveExecutable("grok", process.env), mcpConfig: cliListing(["mcp", "doctor"]) }],
  ["devin", { executable: async () => devinExecutable(), skills: cliListing(["skills", "list"]), mcpConfig: cliListing(["mcp", "list"]) }],
])

/** The harnesses whose folders come from a table in their code rather than a listing. */
const tables = new Map<string, { skills: () => Promise<string>; via: string }>([
  ["cursor", { skills: cursorSkillTable, via: "the SDK's skill-root table" }],
])

function sandboxed(sandbox: Sandbox, path: string): string {
  return path.startsWith("~/") ? join(sandbox.home, path.slice(2)) : join(sandbox.project, path)
}

/** One probe per declared place, named so no name is a prefix of another. */
async function placeProbes(kind: "skills" | "mcpConfig", places: readonly string[], sandbox: Sandbox, format: McpProbeFormat): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const files = new Map<string, string[]>()
  for (const [index, place] of places.entries()) {
    const name = `mako-probe-${String.fromCharCode(97 + index)}`
    names.set(name, place)
    if (kind === "skills") {
      const dir = join(sandboxed(sandbox, place), name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Mako's probe of ${place}\n---\nProbe.\n`)
    } else {
      files.set(sandboxed(sandbox, place), [...files.get(sandboxed(sandbox, place)) ?? [], name])
    }
  }
  for (const [file, servers] of files) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, file.endsWith(".toml")
      ? servers.map((name) => `[mcp_servers.${name}]\ncommand = "true"\n`).join("\n")
      : format === "opencode"
        ? JSON.stringify({ mcp: Object.fromEntries(servers.map((name) => [name, { type: "local", command: ["true"] }])) })
        : JSON.stringify({ mcpServers: Object.fromEntries(servers.map((name) => [name, { command: "true", args: [] }])) }))
  }
  return names
}

/** What the harness itself lists of the places its concepts declare, from a throwaway home and project. */
async function listed(kind: "skills" | "mcpConfig", places: readonly string[], listing: Listing, executable: string, format: McpProbeFormat = "mcpServers"): Promise<Places> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `mako-${harness}-${kind}-`)))
  try {
    const home = join(root, "home")
    const project = join(root, "project")
    await mkdir(join(project, ".git"), { recursive: true })
    const env = { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), TMPDIR: root }
    const sandbox = { home, project, env }
    const names = await placeProbes(kind, places, sandbox, format)
    const text = await listing(executable, sandbox)
    const found = [...names].filter(([name]) => text.includes(name)).map(([, place]) => place)
    return { via: "its own listing", listed: found, missing: places.filter((place) => !found.includes(place)) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

interface Places {
  /** What answered: the harness's own listing, or a table in the code it runs. */
  via: string
  listed: string[]
  missing: string[]
}

interface ListedPlaces {
  skills?: Places
  mcpConfig?: Places
}

async function listedPlaces(concepts: HarnessConcepts): Promise<ListedPlaces> {
  const places: ListedPlaces = {}
  const table = tables.get(harness!)
  if (table) {
    const read = (await table.skills()).split("\n")
    places.skills = { via: table.via, listed: concepts.skills.filter((place) => read.includes(place)), missing: concepts.skills.filter((place) => !read.includes(place)) }
  }
  const harnessListings = listings.get(harness!)
  if (!harnessListings) return places
  const executable = await harnessListings.executable()
  if (!executable) throw new Error(`${harness} is not installed`)
  if (harnessListings.skills) places.skills = await listed("skills", concepts.skills, harnessListings.skills, executable)
  if (harnessListings.mcpConfig) places.mcpConfig = await listed("mcpConfig", concepts.mcpConfig, harnessListings.mcpConfig, executable, harnessListings.mcpFormat)
  return places
}

async function claudeInit(): Promise<void> {
  const Init = z.object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    claude_code_version: z.string(),
    tools: z.array(z.string()),
    agents: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
  }).loose()
  const child = spawn("claude", ["-p", "--output-format", "stream-json", "--verbose", "--model", "haiku", "Reply with the single word ok."], {
    stdio: ["ignore", "pipe", "ignore"],
  })
  let init: z.infer<typeof Init> | undefined
  for await (const line of createInterface({ input: child.stdout })) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = Init.safeParse(value)
    if (parsed.success) {
      init = parsed.data
      break
    }
  }
  child.kill()
  if (!init) throw new Error("Claude exited before reporting system/init")
  const report = {
    harness,
    version: init.claude_code_version,
    on: new Date().toISOString().slice(0, 10),
    via: "claude -p --output-format stream-json, stopped at system/init",
    tools: init.tools.filter((tool) => !tool.startsWith("mcp__")).sort(),
    agents: init.agents ?? [],
    capabilities: init.capabilities ?? [],
  }
  await writeFile(new URL(`${harness}-init.json`, fixtures), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${harness} ${report.version}: ${report.tools.length} built-in tools, written to scripts/fixtures/native-vocabulary/${harness}-init.json`)
}

const build = await builds.get(harness)!()
const literals = probedLiterals(vocabulary.concepts)
const report = {
  harness,
  version: build.version,
  on: new Date().toISOString().slice(0, 10),
  searched: build.files.length === 1 ? basename(build.files[0]!) : `${build.files.length} SDK modules`,
  probed: literals.length,
  missing: await missingLiterals(build, literals),
  ...await listedPlaces(vocabulary.concepts),
}
await writeFile(new URL(`${harness}-concepts.json`, fixtures), `${JSON.stringify(report, null, 2)}\n`)
console.log(`${harness} ${report.version}: ${report.probed - report.missing.length} of ${report.probed} declared names found${report.missing.length ? `; missing ${report.missing.join(", ")}` : ""}`)
for (const kind of ["skills", "mcpConfig"] as const) {
  const places = report[kind]
  if (places) console.log(`${harness} ${kind}: lists ${places.listed.length} of ${places.listed.length + places.missing.length} declared${places.missing.length ? `; not ${places.missing.join(", ")}` : ""}`)
}
if (harness === "claude") await claudeInit()
