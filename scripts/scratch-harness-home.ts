import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { executableCandidates } from "@mako/host/base/executable"
import { CURSOR_CLI_KEYCHAIN_ACCOUNT, CURSOR_CLI_KEYCHAIN_SERVICE } from "@mako/host/harnesses/cursor/sdk/cli-keychain"

/**
 * A home of its own for the real harness CLIs, signed in as this machine's
 * person without touching their homes or their sign-ins. Each harness keeps
 * its sessions under the scratch home, and gets a credential it can use but
 * never renew: an access token still valid, with no refresh token, or an API
 * key. So no CLI rotates a refresh token the person's own copy still holds,
 * and nothing is written back to their keychain or files.
 *
 * - Claude Code: the keychain's access token, as `CLAUDE_CODE_OAUTH_TOKEN` for
 *   a CLI run directly and as the config folder's `.credentials.json` (with no
 *   refresh token) for a Mako host, which runs Claude on its own login and so
 *   drops that variable. Out of the person's home the CLI can't reach their
 *   keychain at all: macOS finds a login keychain under `HOME`.
 * - Codex, and OpenCode through its OpenAI sign-in: Codex's ChatGPT access
 *   token, in an `auth.json` with no refresh token and a fresh refresh time.
 * - Grok: its access key, in an `auth.json` with no refresh token.
 * - Cursor: the CLI's API key (`CURSOR_API_KEY`).
 * - Devin: a copy of its `credentials.toml`, an API key.
 *
 * Each token must stay valid for the run; `expiresInHours` says how long the
 * shortest has. The harnesses themselves are the person's installs, found on
 * `PATH` in the folders a host looks in, since the scratch home has none.
 *
 * The copies live only as long as the run: each file is 0600 in a 0700
 * folder, and every home is disposed of when the process that made it ends,
 * normally, by an error or by SIGINT, SIGTERM or SIGHUP (`ScratchHome.dispose`,
 * which callers that stop earlier call themselves). A home made `keep` (its
 * sessions outlive the run: a moves proof's data root, a packaged app between
 * restarts, recorded session flows) loses only its sign-ins and keychain; any
 * other goes whole. A run killed outright leaves its home in the registry
 * (`<tmpdir>/mako-scratch-homes`), and the next one to make a home sweeps the
 * sign-ins of every home whose process is gone. Devin's key and Grok's access
 * key stay files: Devin reads `WINDSURF_API_KEY` too, but every tool its agent
 * runs would inherit it (and could print it into a transcript), which is why
 * Mako's own accounts never use it; Grok's is an OAuth access key with an
 * expiry, which no environment variable takes. Cursor's is `CURSOR_API_KEY`.
 * A home is never made inside a Git checkout, so no copy can be committed.
 *
 * Every proof or test that runs a real harness runs it in one of these (or in
 * `sandboxed` from `harness-sandbox.ts`, which has no sign-in at all): its
 * sessions land in the scratch home, never in the person's `~/.claude`,
 * `~/.codex` and the like, which their own Mako catalogs and keeps copies of.
 * A Mako host or packaged app run for a proof takes `scratchHostHome`; a
 * script that drives a harness in its own process enters one first
 * (`enterScratchHome`). `test-scratch-home.ts` holds every driver to it.
 */

const run = promisify(execFile)
const SECURITY = "/usr/bin/security"

/** Credentials, endpoints, homes and the parent Claude Code session a harness would otherwise take from this shell, and where npm installs globals (a harness's own updater installs there). */
const INHERITED = /^(ANTHROPIC_|CLAUDE|CODEX_|OPENAI_|XAI_|GROK_|OPENCODE_|DEVIN_|WINDSURF_|CURSOR_|MAKO_|XDG_|npm_config_prefix$|NPM_CONFIG_PREFIX$)/

const ClaudeKeychain = z.object({ claudeAiOauth: z.object({ accessToken: z.string(), expiresAt: z.number() }).loose() }).loose()
/** Who the person is signed in to Claude as, from Claude's state file: names the account, holds no secret. */
const ClaudeState = z.object({ oauthAccount: z.object({ accountUuid: z.string() }).loose() }).loose()
const CodexAuth = z.object({ tokens: z.object({ id_token: z.string(), access_token: z.string(), account_id: z.string().optional() }).loose() }).loose()
const GrokAuth = z.record(z.string(), z.object({ key: z.string(), expires_at: z.string().optional() }).loose())
const JwtClaims = z.object({ exp: z.number() }).loose()
const CURSOR_KEY = /^[\x21-\x7e]{16,4096}$/

export interface ScratchHome {
  home: string
  env: NodeJS.ProcessEnv
  /** Hours until the first of the credentials it holds expires. */
  expiresInHours: number
  /** Removes the home's sign-ins and keychain, and the home itself unless it was made `keep`. Idempotent. */
  dispose(): void
}

export interface ScratchHomeOptions {
  /** Working folders Grok may run in. */
  trusted?: readonly string[]
  /** The home's sessions outlive the run: disposing removes only its sign-ins and keychain. */
  keep?: boolean
}

/** What the person is signed in with, read from their own home and keychain: each harness's, when it has one here. */
export interface PersonSignIns {
  claude?: z.infer<typeof ClaudeKeychain>
  claudeAccount?: z.infer<typeof ClaudeState>["oauthAccount"]
  codex?: z.infer<typeof CodexAuth>
  grok?: z.infer<typeof GrokAuth>
  cursor?: string
  devin?: Buffer
}

function jwtExpiry(token: string): number {
  const [, payload = ""] = token.split(".")
  return JwtClaims.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).exp * 1000
}

/** A keychain item's secret, or undefined: none, or not on macOS. Read with the person's own `HOME`, where their login keychain is. */
function keychainSecret(service: string, account?: string): string | undefined {
  if (process.platform !== "darwin") return undefined
  try {
    return execFileSync(SECURITY, ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, HOME: homedir() } }).trim()
  } catch {
    return undefined
  }
}

/** A JSON file's contents as `schema` reads them, or undefined: none, unreadable or another shape. */
function readJsonFile<T>(path: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.safeParse(JSON.parse(readFileSync(path, "utf8"))).data
  } catch {
    return undefined
  }
}

/** The person's sign-ins, read once; nothing here writes anywhere. */
export function readPersonSignIns(real = homedir()): PersonSignIns {
  const claude = ClaudeKeychain.safeParse(JSON.parse(keychainSecret("Claude Code-credentials") ?? "null")).data
  const claudeAccount = readJsonFile(join(real, ".claude.json"), ClaudeState)?.oauthAccount
  const codex = readJsonFile(join(real, ".codex", "auth.json"), CodexAuth)
  const grok = readJsonFile(join(real, ".grok", "auth.json"), GrokAuth)
  const key = process.env["CURSOR_API_KEY"] || keychainSecret(CURSOR_CLI_KEYCHAIN_SERVICE, CURSOR_CLI_KEYCHAIN_ACCOUNT)
  const cursor = key && CURSOR_KEY.test(key) ? key : undefined
  const devinPath = join(real, ".local", "share", "devin", "credentials.toml")
  const devin = existsSync(devinPath) ? readFileSync(devinPath) : undefined
  return { ...claude && { claude }, ...claudeAccount && { claudeAccount }, ...codex && { codex }, ...grok && { grok }, ...cursor && { cursor }, ...devin && { devin } }
}

/**
 * A scratch home's `PATH`: this one, then the folders a host in the person's home looks in for a harness CLI (theirs:
 * the scratch home has none), so it runs the CLIs their own Mako would.
 */
export function harnessPath(real = homedir(), path = process.env["PATH"] ?? ""): string {
  const bins = executableCandidates("", { PATH: "" }, real).map((candidate) => candidate.replace(/\/$/, ""))
  return [...new Set([...path.split(delimiter).filter(Boolean), ...bins])].join(delimiter)
}

/** The files a scratch home holds sign-ins in, under the home; its keychain is apart (`KEYCHAIN`). */
export const SECRET_FILES = [
  [".claude", ".credentials.json"],
  [".codex", "auth.json"],
  [".local", "share", "opencode", "auth.json"],
  [".grok", "auth.json"],
  [".local", "share", "devin", "credentials.toml"],
] as const
const KEYCHAIN = ["Library", "Keychains", "scratch.keychain-db"] as const

/** A sign-in copy: the file 0600, every folder from the home down to it 0700, whatever made them first. */
function writeSecret(home: string, parts: readonly string[], contents: string | Buffer): void {
  let folder = home
  for (const part of parts.slice(0, -1)) {
    folder = join(folder, part)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    chmodSync(folder, 0o700)
  }
  const path = join(home, ...parts)
  writeFileSync(path, contents, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** The homes this machine's runs made and haven't disposed of, by owner: `<tmpdir>/mako-scratch-homes/<id>.json`. */
const REGISTRY = join(tmpdir(), "mako-scratch-homes")
const Registered = z.object({ home: z.string(), pid: z.number(), keep: z.boolean() })
const registryEntry = (home: string) => join(REGISTRY, `${createHash("sha256").update(home).digest("hex").slice(0, 24)}.json`)
/** This process's homes, disposed of as it ends. */
const owned = new Map<string, () => void>()

function removeSecrets(home: string, keep: boolean): void {
  const keychain = join(home, ...KEYCHAIN)
  if (process.platform === "darwin" && existsSync(keychain)) {
    // Out of the home's search list too; the file goes below either way.
    try { execFileSync(SECURITY, ["delete-keychain", keychain], { env: { ...process.env, HOME: home }, stdio: "ignore" }) } catch { /* removed below */ }
  }
  if (keep) {
    for (const parts of SECRET_FILES) rmSync(join(home, ...parts), { force: true })
    rmSync(keychain, { force: true })
  } else {
    rmSync(home, { recursive: true, force: true })
  }
  rmSync(registryEntry(home), { force: true })
}

function disposeOwned(): void {
  // Each dispose removes only its own entry, and a Map's iterator goes on past an entry removed under it, so the map
  // is walked in place.
  for (const dispose of owned.values()) dispose()
}

let ending = false
/** Disposes of this process's homes as it ends however it ends; a signal no one else handles still ends it. */
function disposeOnEnd(): void {
  if (ending) return
  ending = true
  process.once("exit", disposeOwned)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      disposeOwned()
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/**
 * Removes the sign-ins of every home a run made and never disposed of, its process gone (killed outright, or the Mac
 * restarted); says which, never what they held. Returns the homes swept.
 */
export function sweepScratchHomes(log: (line: string) => void = (line) => console.error(line)): string[] {
  const swept: string[] = []
  for (const name of existsSync(REGISTRY) ? readdirSync(REGISTRY) : []) {
    const entry = Registered.safeParse((() => { try { return JSON.parse(readFileSync(join(REGISTRY, name), "utf8")) } catch { return null } })()).data
    if (!entry) {
      rmSync(join(REGISTRY, name), { force: true })
      continue
    }
    if (alive(entry.pid)) continue
    removeSecrets(entry.home, entry.keep)
    swept.push(entry.home)
    log(`Removed the sign-ins a scratch home kept after its run (process ${entry.pid}) ended without disposing of it: ${entry.home}`)
  }
  return swept
}

/** Refuses a home inside a Git checkout, where a copied sign-in could be committed. */
function assertOutsideRepository(home: string): void {
  let existing = home
  while (!existsSync(existing)) existing = dirname(existing)
  let top: string | undefined
  try {
    top = execFileSync("git", ["-C", existing, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return
  }
  throw new Error(`refused: a scratch home at ${home} would hold sign-in copies inside the Git checkout ${top}`)
}

/** Registers `home` with this process as its owner, and what disposes of it. */
function own(home: string, keep: boolean): () => void {
  mkdirSync(REGISTRY, { recursive: true, mode: 0o700 })
  writeFileSync(registryEntry(home), JSON.stringify({ home, pid: process.pid, keep }), { mode: 0o600 })
  disposeOnEnd()
  const dispose = () => {
    if (!owned.delete(home)) return
    removeSecrets(home, keep)
  }
  owned.set(home, dispose)
  return dispose
}

/**
 * A scratch home under `root` holding `signIns`, as access alone, owned by
 * this process until it's disposed of. Writes only under `root`, and sweeps
 * what crashed runs left first.
 */
export function seedScratchHome(root: string, signIns: PersonSignIns, options: ScratchHomeOptions = {}, real = homedir()): ScratchHome {
  const { trusted = [], keep = false } = options
  const home = join(resolve(root), "home")
  assertOutsideRepository(home)
  sweepScratchHomes()
  const expiries: number[] = []
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.test(name)))
  Object.assign(env, {
    // The XDG folders are left to default under the home: `cursor-agent` keeps its chats under `XDG_CONFIG_HOME` when it's set, where Mako's reader doesn't look.
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), GROK_HOME: join(home, ".grok"),
    GROK_TELEMETRY_ENABLED: "0", GROK_DISABLE_AUTOUPDATER: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", DISABLE_AUTOUPDATER: "1",
    PATH: harnessPath(real),
  })
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  const dispose = own(home, keep)

  if (signIns.claude) {
    const oauth = signIns.claude.claudeAiOauth
    env["CLAUDE_CODE_OAUTH_TOKEN"] = oauth.accessToken
    const access = Object.fromEntries(Object.entries(oauth).filter(([name]) => name !== "refreshToken"))
    writeSecret(home, SECRET_FILES[0], JSON.stringify({ claudeAiOauth: access }))
    expiries.push(oauth.expiresAt)
    // Who it's signed in as, as Claude keeps it: Claude writes its state file on its first start, and a host takes a
    // state file that appears between a launch and its first prompt for a changed sign-in.
    if (signIns.claudeAccount) writeSecret(home, [".claude.json"], JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: signIns.claudeAccount }))
  }

  if (signIns.codex) {
    const access = signIns.codex.tokens.access_token
    expiries.push(jwtExpiry(access))
    writeSecret(home, SECRET_FILES[1], JSON.stringify({
      auth_mode: "chatgpt", OPENAI_API_KEY: null,
      tokens: { ...signIns.codex.tokens, refresh_token: "" },
      last_refresh: new Date().toISOString(),
    }))
    writeSecret(home, SECRET_FILES[2], JSON.stringify({
      openai: { type: "oauth", refresh: "", access, expires: jwtExpiry(access), ...signIns.codex.tokens.account_id && { accountId: signIns.codex.tokens.account_id } },
    }))
  }

  if (signIns.grok) {
    const entries = Object.entries(signIns.grok).map(([name, entry]) => {
      if (entry.expires_at) expiries.push(Date.parse(entry.expires_at))
      return [name, { ...entry, refresh_token: "" }]
    })
    writeSecret(home, SECRET_FILES[3], JSON.stringify(Object.fromEntries(entries), null, 2))
    writeFileSync(join(home, ".grok", "trusted_folders.toml"), trusted.map((folder) => `[folders.${JSON.stringify(folder)}]\ntrusted = true\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`).join("\n"))
  }

  if (signIns.cursor) env["CURSOR_API_KEY"] = signIns.cursor
  if (signIns.devin) writeSecret(home, SECRET_FILES[4], signIns.devin)
  const first = expiries.length ? Math.min(...expiries) : Infinity
  return { home, env, expiresInHours: (first - Date.now()) / 3_600_000, dispose }
}

/** A scratch home under `root`, with a credential for each harness that has one here; `trusted` are working folders Grok may run in. */
export async function scratchHarnessHome(root: string, trusted: readonly string[]): Promise<ScratchHome> {
  return seedScratchHome(root, readPersonSignIns(), { trusted })
}

/**
 * On macOS, an empty keychain of the scratch home's own, unlocked, as its
 * default: a Mako host keeps its data key in the default keychain, and out of
 * the person's home it finds none (macOS looks under `HOME`), so a host there
 * could keep no secret, its cloud sign-in included. The person's keychain and
 * search list are never touched: `security` reads and writes the search list
 * of the `HOME` it runs with. Not named `login`: macOS unlocks a login
 * keychain with the person's own password. Idempotent, for a home used again.
 */
export function scratchKeychain(home: string): void {
  if (process.platform !== "darwin") return
  const keychain = join(home, ...KEYCHAIN)
  const env = { ...process.env, HOME: home }
  const security = (...args: string[]) => execFileSync(SECURITY, args, { env, stdio: "ignore" })
  // The search list and default are preferences of this home: without its folder, they'd be kept nowhere.
  mkdirSync(join(home, "Library", "Preferences"), { recursive: true })
  if (!existsSync(keychain)) {
    // Made unlocked, with no password, and never locked by sleep or time: nothing would be there to unlock it.
    mkdirSync(join(home, "Library"), { recursive: true, mode: 0o700 })
    mkdirSync(dirname(keychain), { recursive: true, mode: 0o700 })
    chmodSync(dirname(keychain), 0o700)
    security("create-keychain", "-p", "", keychain)
    security("set-keychain-settings", keychain)
  } else {
    // One this run made earlier (a packaged app started again before it was stopped) stays unlocked; unlock it anyway.
    security("unlock-keychain", "-p", "", keychain)
  }
  security("list-keychains", "-d", "user", "-s", keychain)
  security("default-keychain", "-d", "user", "-s", keychain)
}

/**
 * A scratch home for a Mako host or packaged app run by a proof: its catalog
 * reads, and its harnesses write, only the scratch home's stores, and it
 * keeps its secrets in the home's own keychain. `root/home`; with `keep`, its
 * sessions stay with the root once its sign-ins and keychain are gone.
 */
export function scratchHostHome(root: string, options: ScratchHomeOptions = {}): ScratchHome {
  const scratch = seedScratchHome(root, readPersonSignIns(), options)
  scratchKeychain(scratch.home)
  assertScratchEnvironment(scratch.env, "a proof's host")
  return scratch
}

/**
 * Moves this process into a scratch home under `root` before it drives a
 * harness itself (a driver in-process, a CLI it spawns with its own
 * environment): every later `homedir()` and child is the scratch home's. Call
 * it before anything reads `homedir()`; import it first to be sure.
 */
export function enterScratchHome(root: string, options: ScratchHomeOptions = {}): ScratchHome {
  const scratch = scratchHostHome(root, options)
  for (const name of Object.keys(process.env)) if (!(name in scratch.env)) delete process.env[name]
  Object.assign(process.env, scratch.env)
  if (homedir() !== scratch.home) throw new Error(`this process still runs as ${homedir()}, not its scratch home ${scratch.home}`)
  return scratch
}

/** The variables that say where a harness or its installer writes: each must be inside the scratch home. */
const WRITES_UNDER = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "npm_config_prefix", "NPM_CONFIG_PREFIX"] as const

function inside(path: string, folder: string): boolean {
  const from = relative(resolve(folder), resolve(path))
  return !isAbsolute(from) && from !== ".." && !from.startsWith(`..${sep}`)
}

/**
 * Refuses an environment an installer or a harness could write the person's
 * own homes from: none given (the process's own, with their `HOME`), a `HOME`
 * that is theirs or holds theirs, or a harness's own folder outside the
 * scratch home. A package's install script writes where its CLI lives, under
 * `HOME`: Grok's npm postinstall, run with the person's home, once put a
 * build in their `~/.grok/bin`, repointed their `grok` and rewrote their
 * `config.toml`. And a harness run there writes its sessions into their
 * stores, which their own Mako lists.
 */
export function assertScratchEnvironment(env: NodeJS.ProcessEnv | undefined, what: string, real = homedir()): void {
  if (!env) throw new Error(`${what}: refused, it would run with this process's environment, whose HOME is the person's own (${real})`)
  const home = env["HOME"]
  if (!home) throw new Error(`${what}: refused, its environment names no HOME, so it would write under the person's own (${real})`)
  if (inside(real, home)) throw new Error(`${what}: refused, its HOME (${home}) is the person's own home or holds it`)
  for (const name of WRITES_UNDER) {
    const value = env[name]
    if (value && !inside(value, home)) throw new Error(`${what}: refused, ${name} (${value}) is outside its scratch home (${home})`)
  }
}

/**
 * Runs an installer (`npm install`, a vendor's install script) only in a
 * scratch home: the one way a proof installs a CLI. Refuses before anything
 * is spawned when `assertScratchEnvironment` does.
 */
export function scratchInstall(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv | undefined; cwd?: string; maxBuffer?: number }, real = homedir()): Promise<{ stdout: string; stderr: string }> {
  try {
    assertScratchEnvironment(options.env, [command, ...args].join(" "), real)
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  return run(command, [...args], { env: options.env, ...options.cwd && { cwd: options.cwd }, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024 })
}
