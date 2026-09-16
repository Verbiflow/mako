import { spawn } from "node:child_process"
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { z } from "zod"
import {
  HarnessUpdateCommandSchema,
  HarnessUpdateChannelSchema,
  HarnessUpdateResultSchema,
  type HarnessUpdateChannel,
  type HarnessUpdateCommand,
  type HarnessUpdateInfo,
  type HarnessUpdates,
} from "./contracts/harness-updates.js"
import { compareVersions, parseVersion } from "./contracts/runtime-version.js"
import { environmentForExecutable, resolveExecutable } from "./executable.js"
import { hostLog, hostWarn } from "./host-log.js"
import { withDiscoveryProcess } from "./providers/discovery-process.js"
import type { ProviderUpdateSource } from "./providers/update-source.js"

/**
 * The runtimes behind every provider: what is installed, what is current,
 * who updates it, and the update itself.
 *
 * Nothing here waits on the user. The host reads every runtime a few seconds
 * after it starts, again when a window asks and the reading is old, and
 * hourly for the public version; every reading is pushed to every window as
 * `runtime-updates` and kept on disk so the next host paints the last
 * reading before its own arrives. Opening Settings therefore shows versions
 * at once, and the model picker never triggers a probe.
 *
 * Two readings, two clocks. The installed version is local and cheap when
 * the binary has not changed: the file's mtime and size are the cache key,
 * so a re-check spawns nothing unless the file moved (Omnigent's rule for its
 * Codex catalog, the one that stopped an in-place `npm i -g` from serving
 * the old models for the rest of the process). The public version is a
 * network read with its own hour-long TTL, and a registry that is down
 * leaves the installed reading standing with `latestError` beside it.
 *
 * A changed binary is discovery's business as much as this module's: the
 * `onRuntimeChanged` hook fires whenever the installed reading moves, whether
 * Mako ran the update or the user did in a terminal, and the host answers by
 * dropping that provider's model catalog and discovering again.
 */

const persistedInfoSchema = z.object({
  binary: z.string().optional(),
  installed: z.string().optional(),
  latest: z.string().optional(),
  channel: HarnessUpdateChannelSchema.optional(),
  managedBy: z.string().optional(),
  update: HarnessUpdateCommandSchema.optional(),
  checkedAt: z.number().optional(),
  latestCheckedAt: z.number().optional(),
  error: z.string().optional(),
  latestError: z.string().optional(),
  result: HarnessUpdateResultSchema.optional(),
})
const signatureSchema = z.object({
  binary: z.string(),
  mtimeMs: z.number(),
  size: z.number(),
  installed: z.string(),
})
const fileSchema = z.object({
  version: z.literal(1),
  updates: z.record(z.string(), persistedInfoSchema),
  signatures: z.record(z.string(), signatureSchema),
})
type PersistedFile = z.infer<typeof fileSchema>
type Signature = z.infer<typeof signatureSchema>

export interface RuntimeChange {
  provider: string
  from?: string
  to?: string
}

export interface RuntimeUpdatesOptions {
  sources: () => ProviderUpdateSource[]
  /** Where readings are kept between hosts. */
  path: string
  emit: (updates: HarnessUpdates) => void
  env?: () => NodeJS.ProcessEnv
  /** The installed reading moved: the binary is new, gone, or another version. */
  onRuntimeChanged?: (change: RuntimeChange) => void
  /** Probes and runners, injectable for tests. Defaults spawn real processes and read the npm registry. */
  version?: (binary: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>
  latest?: (npmPackage: string) => Promise<string>
  run?: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number
  ) => Promise<{ code: number | null; output: string }>
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number }>
  realpath?: (path: string) => Promise<string>
  now?: () => number
  /** How long after `start()` the first reading runs; startup work goes first. */
  startDelayMs?: number
  /** An installed reading older than this is re-taken when a window asks. */
  installedTtlMs?: number
  /** How long a public version reading stands. */
  latestTtlMs?: number
  /** How long a failed public reading is held before it is asked again. */
  latestRetryMs?: number
  versionTimeoutMs?: number
  updateTimeoutMs?: number
}

type Timing = Required<
  Pick<
    RuntimeUpdatesOptions,
    | "startDelayMs"
    | "installedTtlMs"
    | "latestTtlMs"
    | "latestRetryMs"
    | "versionTimeoutMs"
    | "updateTimeoutMs"
  >
>
const DEFAULTS: Timing = {
  startDelayMs: 5_000,
  installedTtlMs: 10 * 60_000,
  latestTtlMs: 60 * 60_000,
  latestRetryMs: 10 * 60_000,
  versionTimeoutMs: 8_000,
  updateTimeoutMs: 5 * 60_000,
}

/** The tail of an updater's output kept for the receipt and the log. */
const OUTPUT_TAIL = 16 * 1024
const REGISTRY_TIMEOUT_MS = 4_000
const REGISTRY_BODY_LIMIT = 256 * 1024

export class RuntimeUpdates {
  private readonly options: RuntimeUpdatesOptions & Timing
  private updates: HarnessUpdates = {}
  private signatures = new Map<string, Signature>()
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()
  private readonly checking = new Map<string, Promise<HarnessUpdateInfo>>()
  private readonly updating = new Set<string>()
  private readonly locks = new Map<string, Promise<void>>()
  private refreshing: Promise<HarnessUpdates> | null = null
  private emitScheduled = false
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private stopped = false

  constructor(options: RuntimeUpdatesOptions) {
    this.options = { ...DEFAULTS, ...options }
  }

  /** Reads the last host's readings so the first snapshot is never empty. */
  async load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(this.options.path, "utf8"))
        const result = fileSchema.safeParse(parsed)
        if (!result.success) return
        this.updates = result.data.updates
        this.signatures = new Map(Object.entries(result.data.signatures))
      } catch {
        // No readings yet, or an unreadable file: the first check writes a fresh one.
      }
    })()
    await this.loaded
  }

  /** Schedules the first reading behind startup and the hourly public reading. */
  start(): void {
    this.stopped = false
    const first = setTimeout(() => {
      void this.refresh().catch(() => undefined)
    }, this.options.startDelayMs)
    first.unref()
    const periodic = setInterval(() => {
      void this.refresh().catch(() => undefined)
    }, this.options.latestTtlMs)
    periodic.unref()
    this.timers.push(first, periodic)
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  /** What is known now. Sync so a window paints before any probe answers. */
  snapshot(): HarnessUpdates {
    return structuredClone(this.updates)
  }

  /**
   * What is known now, and a fresh reading behind it when the caller asks or
   * the last one is old. Never waits on a probe.
   */
  async read(refresh = false): Promise<HarnessUpdates> {
    await this.load()
    const now = this.options.now?.() ?? Date.now()
    const stale = this.options.sources().some((source) => {
      const held = this.updates[source.provider]
      return !held?.checkedAt || now - held.checkedAt > this.options.installedTtlMs
    })
    if (refresh || stale) void this.refresh({ latest: refresh }).catch(() => undefined)
    return this.snapshot()
  }

  /** Every runtime, read once; concurrent callers share the pass. */
  refresh(options: { latest?: boolean } = {}): Promise<HarnessUpdates> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      await this.load()
      await Promise.all(
        this.options
          .sources()
          .map((source) => this.check(source.provider, options).catch(() => undefined))
      )
      return this.snapshot()
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /**
   * One runtime: the binary, its version (spawned only when the file changed),
   * its channel and update plan, then the public version when that reading is
   * due. The installed reading is published before the network is touched.
   */
  check(
    provider: string,
    options: { force?: boolean; latest?: boolean } = {}
  ): Promise<HarnessUpdateInfo> {
    const active = this.checking.get(provider)
    if (active) return active
    const request = this.readRuntime(provider, options).finally(() => {
      if (this.checking.get(provider) === request) this.checking.delete(provider)
    })
    this.checking.set(provider, request)
    return request
  }

  private async readRuntime(
    provider: string,
    options: { force?: boolean; latest?: boolean }
  ): Promise<HarnessUpdateInfo> {
    await this.load()
    const source = this.options.sources().find((entry) => entry.provider === provider)
    if (!source) throw new Error(`${provider} has no runtime Mako can read`)
    const env = this.options.env?.() ?? process.env
    const previous = this.updates[provider]
    this.publish(provider, { ...previous, phase: this.updating.has(provider) ? "updating" : "checking" })
    const next: HarnessUpdateInfo = {}
    if (previous?.latest) next.latest = previous.latest
    if (previous?.latestCheckedAt) next.latestCheckedAt = previous.latestCheckedAt
    if (previous?.latestError) next.latestError = previous.latestError
    if (previous?.result) next.result = previous.result
    try {
      const binary = await source.binary(env)
      if (binary) {
        next.binary = binary
        const installed = await this.installedVersion(provider, source, binary, env, options.force === true)
        if (installed.version) next.installed = installed.version
        else next.error = installed.error
        const real = await (this.options.realpath ?? realpath)(binary).catch(() => binary)
        Object.assign(next, resolveRuntimeChannel(source, binary, real))
      } else {
        // Not installed: nothing to show and nothing to update. The row stays hidden.
        this.signatures.delete(provider)
      }
    } catch (error) {
      next.error = error instanceof Error ? error.message : String(error)
    }
    next.checkedAt = this.options.now?.() ?? Date.now()
    this.publish(provider, this.updating.has(provider) ? { ...next, phase: "updating" } : next)
    if (previous && (previous.installed !== next.installed || previous.binary !== next.binary)) {
      hostLog("runtime", "runtime changed", { provider, from: previous.installed ?? null, to: next.installed ?? null, binary: next.binary ?? null })
      this.options.onRuntimeChanged?.({ provider, from: previous.installed, to: next.installed })
    }
    await this.persist()
    if (source.npmPackage && this.latestDue(next, options.latest === true)) {
      await this.readLatest(provider, source.npmPackage)
      await this.persist()
    }
    return this.updates[provider] ?? next
  }

  private latestDue(info: HarnessUpdateInfo, force: boolean): boolean {
    if (force) return true
    const now = this.options.now?.() ?? Date.now()
    if (!info.latestCheckedAt) return true
    const age = now - info.latestCheckedAt
    return age > (info.latestError ? this.options.latestRetryMs : this.options.latestTtlMs)
  }

  private async readLatest(provider: string, npmPackage: string): Promise<void> {
    const held = this.updates[provider]
    if (!held) return
    const at = this.options.now?.() ?? Date.now()
    try {
      const latest = await (this.options.latest ?? npmRegistryLatest)(npmPackage)
      const next: HarnessUpdateInfo = { ...held, latest, latestCheckedAt: at }
      delete next.latestError
      this.publish(provider, next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.publish(provider, { ...held, latestCheckedAt: at, latestError: message })
    }
  }

  private async installedVersion(
    provider: string,
    source: ProviderUpdateSource,
    binary: string,
    env: NodeJS.ProcessEnv,
    force: boolean
  ): Promise<{ version?: string; error?: string }> {
    const signature = await (this.options.stat ?? stat)(binary).catch(() => null)
    const held = this.signatures.get(provider)
    if (
      !force &&
      signature &&
      held &&
      held.binary === binary &&
      held.mtimeMs === signature.mtimeMs &&
      held.size === signature.size
    )
      return { version: held.installed }
    try {
      const output = await (this.options.version ?? spawnVersion)(
        binary,
        source.versionArgs ?? ["--version"],
        env
      )
      const version = parseVersion(output)
      if (!version) return { error: `${basename(binary)} did not report a version` }
      if (signature) this.signatures.set(provider, { binary, installed: version, ...signature })
      else this.signatures.delete(provider)
      return { version }
    } catch (error) {
      this.signatures.delete(provider)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Runs the runtime's update, then reads it again. One update per channel
   * at a time, because two npm globals installing together corrupt each
   * other's tree; one update per provider at a time, because the second
   * would report the first's outcome as its own.
   */
  async update(provider: string): Promise<HarnessUpdateInfo> {
    await this.load()
    const source = this.options.sources().find((entry) => entry.provider === provider)
    if (!source) throw new Error(`${provider} does not update through Mako`)
    if (this.updating.has(provider)) throw new Error(`${provider} is already updating`)
    const current =
      (await this.checking.get(provider)) ??
      this.updates[provider] ??
      (await this.check(provider))
    const plan = current.update
    if (!plan) {
      throw new Error(
        current.managedBy
          ? `${provider} updates come from ${current.managedBy}`
          : `${provider} does not update through Mako`
      )
    }
    const env = this.options.env?.() ?? process.env
    const lockKey = current.channel === "self" ? provider : (current.channel ?? provider)
    this.updating.add(provider)
    this.publish(provider, { ...current, phase: "updating" })
    const startedAt = this.options.now?.() ?? Date.now()
    try {
      const failure = await this.runUpdate(provider, current, plan, env, lockKey)
      if (failure !== null) {
        const failed = withoutPhase({
          ...(this.updates[provider] ?? current),
          result: { at: startedAt, outcome: "failed", from: current.installed, message: failure },
        })
        this.updating.delete(provider)
        this.publish(provider, failed)
        await this.persist()
        return failed
      }
      // A reading already in flight predates the update; wait it out, then read again.
      await this.checking.get(provider)?.catch(() => undefined)
      const after = await this.check(provider, { force: true, latest: true })
      const to = after.installed
      const outcome =
        to && current.installed && compareVersions(to, current.installed) === 0
          ? "unchanged"
          : "updated"
      hostLog("runtime", "update finished", { provider, from: current.installed ?? null, to: to ?? null, outcome })
      const done = withoutPhase({
        ...after,
        result: { at: startedAt, outcome, from: current.installed, to },
      })
      this.updating.delete(provider)
      this.publish(provider, done)
      await this.persist()
      return done
    } finally {
      this.updating.delete(provider)
    }
  }

  /** The updater itself, under the channel lock. Resolves to the failure text, or `null` when it finished cleanly. */
  private async runUpdate(
    provider: string,
    current: HarnessUpdateInfo,
    plan: HarnessUpdateCommand,
    env: NodeJS.ProcessEnv,
    lockKey: string
  ): Promise<string | null> {
    const release = await this.acquire(lockKey)
    try {
      const command = resolveExecutable(plan.command, env)
      if (!command) throw new Error(`${plan.command} is not installed`)
      hostLog("runtime", "update started", {
        provider,
        channel: current.channel ?? null,
        command: [plan.command, ...plan.args].join(" "),
        from: current.installed ?? null,
      })
      const outcome = await (this.options.run ?? spawnUpdate)(
        command,
        plan.args,
        env,
        this.options.updateTimeoutMs
      )
      if (outcome.code !== 0) {
        const tail = outcome.output.trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(-600)
        throw new Error(tail || `${plan.command} exited with ${outcome.code ?? "a signal"}`)
      }
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      hostWarn("runtime", "update failed", { provider, error: message })
      return message
    } finally {
      release()
    }
  }

  private async acquire(key: string): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const chain = previous.then(() => held)
    this.locks.set(key, chain)
    await previous
    return () => {
      release()
      if (this.locks.get(key) === chain) this.locks.delete(key)
    }
  }

  private publish(provider: string, info: HarnessUpdateInfo): void {
    this.updates = { ...this.updates, [provider]: info }
    if (this.emitScheduled) return
    this.emitScheduled = true
    queueMicrotask(() => {
      this.emitScheduled = false
      if (!this.stopped) this.options.emit(this.snapshot())
    })
  }

  private persist(): Promise<void> {
    const updates: PersistedFile["updates"] = {}
    for (const [provider, info] of Object.entries(this.updates))
      updates[provider] = withoutPhase(info)
    const file: PersistedFile = {
      version: 1,
      updates,
      signatures: Object.fromEntries(this.signatures),
    }
    this.writes = this.writes
      .then(async () => {
        const temp = `${this.options.path}.${process.pid}.tmp`
        await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
        await writeFile(temp, JSON.stringify(file), { encoding: "utf8", mode: 0o600 })
        await rename(temp, this.options.path)
      })
      .catch((error) => {
        hostWarn("runtime", "readings not saved", { error: error instanceof Error ? error.message : String(error) })
      })
    return this.writes
  }
}

/**
 * Where a binary came from, read off its path and real path, and the update
 * that install channel takes. The order is the order of evidence: another
 * app's registry and an app bundle are unmistakable; the CLI's own install
 * root comes before package managers because its installer may symlink into
 * a directory a manager also uses; among managers the real path decides.
 */
export function resolveRuntimeChannel(
  source: ProviderUpdateSource,
  binary: string,
  real: string
): Pick<HarnessUpdateInfo, "channel" | "managedBy" | "update"> {
  const paths = [binary, real]
  const normalized = paths.map((path) => path.replaceAll("\\", "/"))
  const managed = source.managedBy?.find(([needle]) => normalized.some((path) => path.includes(needle)))
  if (managed) return { channel: "managed", managedBy: managed[1] }
  for (const path of normalized) {
    const app = path.match(/\/([^/]+\.app)\/Contents\//)
    if (app) return { channel: "app", managedBy: app[1] }
  }
  const native = source.native
  if (native && paths.some((path) => native.ownsPath(path)))
    return {
      channel: "self",
      update: { label: native.label, command: binary, args: native.args },
    }
  const lower = normalized.map((path) => path.toLowerCase())
  const has = (...needles: string[]) => lower.some((path) => needles.some((needle) => path.includes(needle)))
  const pkg = source.npmPackage
  if (has("/.bun/bin/", "/.bun/install/global/"))
    return withPackage("bun", pkg, (name) => ({ label: "Update with bun", command: "bun", args: ["add", "-g", `${name}@latest`] }))
  if (has("/.local/share/pnpm/", "/library/pnpm/", "/appdata/local/pnpm/", "/pnpm/global/"))
    return withPackage("pnpm", pkg, (name) => ({ label: "Update with pnpm", command: "pnpm", args: ["add", "-g", `${name}@latest`] }))
  if (has("/lib/node_modules/", "/node_modules/.bin/", "/npm/node_modules/"))
    return withPackage("npm", pkg, npmUpdate)
  if (has("/cellar/", "/caskroom/")) {
    if (!source.homebrew) return { channel: "brew", managedBy: "Homebrew" }
    const { name, cask } = source.homebrew
    return {
      channel: "brew",
      update: { label: "Update with Homebrew", command: "brew", args: cask ? ["upgrade", "--cask", name] : ["upgrade", name] },
    }
  }
  return { channel: "manual" }
}

function withoutPhase(info: HarnessUpdateInfo): HarnessUpdateInfo {
  const copy = { ...info }
  delete copy.phase
  return copy
}

function withPackage(
  channel: HarnessUpdateChannel,
  pkg: string | undefined,
  plan: (name: string) => HarnessUpdateCommand
): Pick<HarnessUpdateInfo, "channel" | "managedBy" | "update"> {
  return pkg ? { channel, update: plan(pkg) } : { channel }
}

/**
 * npm 12 blocks install scripts by default and still exits 0, so a package
 * whose postinstall finishes the install (Claude copies its native binary
 * over a stub) is left broken while the update reports success. This one
 * package's scripts are allowed; npm 11 accepts the flag silently.
 */
function npmUpdate(name: string): HarnessUpdateCommand {
  return {
    label: "Update with npm",
    command: "npm",
    args: ["install", "-g", `--allow-scripts=${name}`, `${name}@latest`],
  }
}

async function spawnVersion(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string> {
  return withDiscoveryProcess(
    { command: binary, args, env, timeoutMs: DEFAULTS.versionTimeoutMs, priority: "background" },
    async ({ child, exited }) => {
      const chunks: Buffer[] = []
      let bytes = 0
      const collect = (chunk: Buffer) => {
        if (bytes > 64 * 1024) return
        bytes += chunk.length
        chunks.push(chunk)
      }
      child.stdout.on("data", collect)
      child.stderr.on("data", collect)
      child.stdin.end()
      const result = await exited
      const output = Buffer.concat(chunks).toString("utf8")
      if (result.code !== 0 && !parseVersion(output))
        throw new Error(`${basename(binary)} --version exited with ${result.signal ?? result.code}`)
      return output
    }
  )
}

/** The npm registry's `latest` tag, read with a bounded body and a short deadline. */
async function npmRegistryLatest(npmPackage: string): Promise<string> {
  const response = await fetch(
    `https://registry.npmjs.org/${npmPackage.replace("/", "%2F")}/latest`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    }
  )
  if (!response.ok) throw new Error(`npm registry answered ${response.status}`)
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length > REGISTRY_BODY_LIMIT) throw new Error("npm registry answer too large")
  const text = await response.text()
  if (text.length > REGISTRY_BODY_LIMIT) throw new Error("npm registry answer too large")
  const parsed = z.object({ version: z.string() }).safeParse(JSON.parse(text))
  if (!parsed.success) throw new Error("npm registry answer had no version")
  return parsed.data.version
}

/** Runs an updater to completion, keeping only the tail of what it printed. */
function spawnUpdate(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environmentForExecutable(command, env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let output = ""
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL)
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref()
      reject(new Error(`${basename(command)} did not finish within ${Math.round(timeoutMs / 60_000)} minutes`))
    }, timeoutMs)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}
