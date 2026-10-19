import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { readCursorCliApiKey } from "@mako/host/harnesses/cursor/sdk/cli-keychain"

/**
 * A home of its own for the real harness CLIs, signed in as this machine's
 * person without touching their homes or their sign-ins. Each harness keeps
 * its sessions under the scratch home, and gets a credential it can use but
 * never renew: an access token still valid, with no refresh token, or an API
 * key. So no CLI rotates a refresh token the person's own copy still holds,
 * and nothing is written back to their keychain or files.
 *
 * - Claude Code: the keychain's access token as `CLAUDE_CODE_OAUTH_TOKEN`, a
 *   config folder in the scratch home.
 * - Codex, and OpenCode through its OpenAI sign-in: Codex's ChatGPT access
 *   token, in an `auth.json` with no refresh token and a fresh refresh time.
 * - Grok: its access key, in an `auth.json` with no refresh token.
 * - Cursor: the CLI's API key (`CURSOR_API_KEY`).
 * - Devin: a copy of its `credentials.toml`, an API key.
 *
 * Each token must stay valid for the run; `expiresInHours` says how long the
 * shortest has.
 */

const run = promisify(execFile)

/** Credentials, endpoints, homes and the parent Claude Code session a harness would otherwise take from this shell. */
const INHERITED = /^(ANTHROPIC_|CLAUDE|CODEX_|OPENAI_|XAI_|GROK_|OPENCODE_|DEVIN_|WINDSURF_|CURSOR_|MAKO_|XDG_)/

const ClaudeKeychain = z.object({ claudeAiOauth: z.object({ accessToken: z.string(), expiresAt: z.number() }) })
const CodexAuth = z.object({ tokens: z.object({ id_token: z.string(), access_token: z.string(), account_id: z.string().optional() }).loose() }).loose()
const GrokAuth = z.record(z.string(), z.object({ key: z.string(), expires_at: z.string().optional() }).loose())
const JwtClaims = z.object({ exp: z.number() }).loose()

export interface ScratchHome {
  home: string
  env: NodeJS.ProcessEnv
  /** Hours until the first of the credentials it holds expires. */
  expiresInHours: number
}

function jwtExpiry(token: string): number {
  const [, payload = ""] = token.split(".")
  return JwtClaims.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).exp * 1000
}

/** A scratch home under `root`, with a credential for each harness that has one here; `trusted` are working folders Grok may run in. */
export async function scratchHarnessHome(root: string, trusted: readonly string[]): Promise<ScratchHome> {
  const home = join(root, "home")
  const real = homedir()
  const expiries: number[] = []
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.test(name)))
  Object.assign(env, {
    // The XDG folders are left to default under the home: `cursor-agent` keeps its chats under `XDG_CONFIG_HOME` when it's set, where Mako's reader doesn't look.
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), GROK_HOME: join(home, ".grok"),
    GROK_TELEMETRY_ENABLED: "0", GROK_DISABLE_AUTOUPDATER: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    PATH: [join(real, ".local", "bin"), join(real, ".opencode", "bin"), process.env["PATH"] ?? ""].join(":"),
  })
  await mkdir(home, { recursive: true })

  const claude = await run("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]).then(({ stdout }) => ClaudeKeychain.safeParse(JSON.parse(stdout)).data, () => undefined)
  if (claude) {
    env["CLAUDE_CODE_OAUTH_TOKEN"] = claude.claudeAiOauth.accessToken
    expiries.push(claude.claudeAiOauth.expiresAt)
  }

  const codex = CodexAuth.safeParse(JSON.parse(await readFile(join(real, ".codex", "auth.json"), "utf8").catch(() => "null"))).data
  if (codex) {
    const access = codex.tokens.access_token
    expiries.push(jwtExpiry(access))
    await mkdir(join(home, ".codex"), { recursive: true })
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({
      auth_mode: "chatgpt", OPENAI_API_KEY: null,
      tokens: { ...codex.tokens, refresh_token: "" },
      last_refresh: new Date().toISOString(),
    }), { mode: 0o600 })
    await mkdir(join(home, ".local", "share", "opencode"), { recursive: true })
    await writeFile(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({
      openai: { type: "oauth", refresh: "", access, expires: jwtExpiry(access), ...codex.tokens.account_id && { accountId: codex.tokens.account_id } },
    }), { mode: 0o600 })
  }

  const grok = GrokAuth.safeParse(JSON.parse(await readFile(join(real, ".grok", "auth.json"), "utf8").catch(() => "null"))).data
  if (grok) {
    await mkdir(join(home, ".grok"), { recursive: true })
    const entries = Object.entries(grok).map(([name, entry]) => {
      if (entry.expires_at) expiries.push(Date.parse(entry.expires_at))
      return [name, { ...entry, refresh_token: "" }]
    })
    await writeFile(join(home, ".grok", "auth.json"), JSON.stringify(Object.fromEntries(entries), null, 2), { mode: 0o600 })
    await writeFile(join(home, ".grok", "trusted_folders.toml"), trusted.map((folder) => `[folders.${JSON.stringify(folder)}]\ntrusted = true\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`).join("\n"))
  }

  const cursor = process.env["CURSOR_API_KEY"] || await readCursorCliApiKey()
  if (cursor) env["CURSOR_API_KEY"] = cursor

  const devin = await readFile(join(real, ".local", "share", "devin", "credentials.toml")).catch(() => null)
  if (devin) {
    await mkdir(join(home, ".local", "share", "devin"), { recursive: true })
    await writeFile(join(home, ".local", "share", "devin", "credentials.toml"), devin, { mode: 0o600 })
  }
  const first = expiries.length ? Math.min(...expiries) : Infinity
  return { home, env, expiresInHours: (first - Date.now()) / 3_600_000 }
}

/** The variables that say where a harness or its installer writes: each must be inside the scratch home. */
const WRITES_UNDER = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "npm_config_prefix", "NPM_CONFIG_PREFIX"] as const

function inside(path: string, folder: string): boolean {
  const from = relative(resolve(folder), resolve(path))
  return !isAbsolute(from) && from !== ".." && !from.startsWith(`..${sep}`)
}

/**
 * Refuses an environment an installer could write the person's own homes
 * from: none given (the process's own, with their `HOME`), a `HOME` that is
 * theirs or holds theirs, or a harness's own folder outside the scratch home.
 * A package's install script writes where its CLI lives, under `HOME`:
 * Grok's npm postinstall, run with the person's home, once put a build in
 * their `~/.grok/bin`, repointed their `grok` to it and rewrote their
 * `config.toml`.
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
