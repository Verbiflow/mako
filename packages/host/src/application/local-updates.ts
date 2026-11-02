import { constants } from "node:fs"
import { physicalFiles } from "../base/physical-files.js"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { execFile } from "node:child_process"
import { promisify, stripVTControlCharacters } from "node:util"
import { z } from "zod"
import { createHash } from "node:crypto"
import {
  BuildIdentitySchema,
  CHANGE_TITLES,
  type BuildIdentity,
  type LocalBuildState,
  type RevisionChanges,
  type UnsurePerformance,
  type UpdateSource,
} from "../contracts/app-lifecycle.js"
import { describeRow, parseVerdicts, PERFORMANCE_VERDICT_VARIABLE } from "../contracts/performance-verdict.js"
import { busyReasons, describeMachine, readMachine, type MachineReading } from "../base/machine-load.js"
import { hostLog } from "../base/host-log.js"
import { environmentForExecutable, resolveExecutable } from "../base/executable.js"
import { unregisterBundle } from "./local-update-installer.js"
import { BUILD_UNCOMMITTED_VARIABLE, bringForward, changesSince, readUncommitted, readUpdateSource } from "./local-update-source.js"
import { runProcessGroup } from "./process-group.js"
import { DependencyInstallError, installDependencies, missingDependencies, uninstalledPackages } from "./local-update-dependencies.js"
import type { Git } from "@mako/git"

const execute = promisify(execFile)
const localPackage = z.object({
  makoDistribution: z.literal("local"),
  makoLocalSigningIdentity: z.string().regex(/^[A-Fa-f0-9]{40}$/),
  makoBuild: BuildIdentitySchema,
})
const sourcePackage = z.object({
  name: z.literal("mako"),
  scripts: z.object({
    "package:mac:local": z.string(),
    "test:performance": z.string(),
    lint: z.string(),
    build: z.string(),
  }),
})
const excluded = new Set([
  "node_modules",
  "ignore",
  "release",
  "dist",
  "dist-electron",
  "dist-browser-extension",
])

export async function verifyLocalCandidate(app: string, identity: string) {
  const metadata = localPackage.parse(
    JSON.parse(
      await readFile(
        join(app, "Contents/Resources/app.asar/package.json"),
        "utf8"
      )
    )
  )
  if (
    metadata.makoLocalSigningIdentity.toUpperCase() !== identity.toUpperCase()
  )
    throw new Error(
      "The update was signed with a different identity. Nothing was installed."
    )
  await execute(
    "codesign",
    [
      "--verify",
      "--deep",
      "--strict",
      "--test-requirement",
      `=identifier "dev.mako.app" and certificate leaf = H"${identity}"`,
      app,
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 }
  )
  return metadata.makoBuild
}

/**
 * A packaged Mako.app measures about 0.8 GB; electron-builder writes it once
 * into the build's output.
 */
export const PACKAGED_APP_BYTES = 1e9
/**
 * Left free after a build. The build's compile output, test profiles and
 * swap need room too, and macOS itself misbehaves with less than a few GB.
 */
export const DISK_MARGIN_BYTES = 5e9

export type DiskReader = (path: string) => Promise<{ bavail: number; bsize: number }>

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

/**
 * Refuse a build the disk can't hold, before anything is copied or built.
 * `copied` is what the build duplicates first (the private checkout); the
 * packaged app and the margin are added to it. The disk once filled to the
 * last byte from builds nobody removed, so this is checked on every build.
 */
export async function ensureBuildSpace(
  folder: string,
  copied: number,
  read: DiskReader = statfs
): Promise<{ needed: number; free: number }> {
  const disk = await read(folder)
  const free = disk.bavail * disk.bsize
  const needed = copied + PACKAGED_APP_BYTES + DISK_MARGIN_BYTES
  if (free < needed)
    throw new Error(
      `Not enough free disk space to build Mako: it needs about ${gigabytes(needed)} free on the disk holding ${folder} (${copied ? `${gigabytes(copied)} for its copy of the checkout, ` : ""}${gigabytes(PACKAGED_APP_BYTES)} for the packaged app and ${gigabytes(DISK_MARGIN_BYTES)} left over), and ${gigabytes(free)} is free. Nothing was copied or built. Free some space, then build again.`
    )
  return { needed, free }
}

/**
 * What a fresh private checkout of `source` takes: everything the sync
 * copies, `node_modules` included, as if none of it were there yet.
 */
export async function buildCopyBytes(source: string): Promise<number> {
  const files = await physicalFiles()
  let total = 0
  const visit = async (dir: string, top: boolean): Promise<void> => {
    const entries = await files.readdir(dir, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.map(async (entry) => {
      const skipped = top && entry.name !== "node_modules" && (excluded.has(entry.name) || entry.name.startsWith("."))
      if (skipped) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return visit(path, false)
      if (!entry.isFile()) return
      const size = (await files.lstat(path).catch(() => null))?.size ?? 0
      total += size
    }))
  }
  await visit(source, true)
  return total
}

const revisionChanges = z.object({
  from: z.string().nullable(),
  count: z.number().int().nonnegative(),
  titles: z.array(z.string()).max(CHANGE_TITLES),
})
/** What a build brought, kept beside it so the build it becomes can say so once it runs. */
const BUILD_CHANGES = "build-changes.json"
const buildChanges = z.object({ build: z.string(), changes: revisionChanges })

/** A reading younger than this answers a check without fetching again; Check again and Build always fetch. */
const FETCH_EVERY_MS = 60_000

export interface LocalUpdateOptions {
  /**
   * Pass `MAKO_BUILD_SOURCE` to the build's checks. Updaters released before
   * it was added never passed it; `test:settings-build --as-installed-updater`
   * turns it off to rehearse them.
   */
  buildSource?: boolean
  statfs?: DiskReader
  /** How long npm install in the checkout may run; `DEPENDENCY_INSTALL_TIMEOUT_MS` unless a test shortens it. */
  installTimeoutMs?: number
  /** Packages the checked build into `output` and verifies what it made; the real packager and codesign unless a test stands in. */
  candidate?: CandidateMaker
  /** Reads the Mac while an update waits for it to quiet down; `readMachine` unless a test simulates one. */
  machine?: () => Promise<MachineReading>
  /** How often a waiting update reads the Mac; `QUIET_EVERY_MS` unless a test shortens it. */
  quietEveryMs?: number
}

export interface CandidateMaker {
  package(checkout: string, output: string, env: NodeJS.ProcessEnv): Promise<void>
  verify(app: string): Promise<BuildIdentity>
}

/**
 * The private build copy. Spotlight leaves a folder named `.noindex` alone:
 * a build rewrites the copy's 50,000 dependency files whenever the lockfile
 * moves, and indexing them kept `mds_stores` at a full core through the
 * performance check that followed.
 */
const CHECKOUT = "checkout.noindex"
/** Where builds before `CHECKOUT` kept the copy; moved once, so the next build stays incremental. */
const LEGACY_CHECKOUT = "checkout"
/** The file a build's performance check appends its verdicts to, in the build's own folder. */
const VERDICTS = "performance-verdict.jsonl"
/** How long one build step may run. */
const BUILD_STEP_MS = 20 * 60_000
/**
 * How long the performance check may run: on a busy Mac each of its two
 * comparisons waits up to 3 minutes for quiet and measures for 5 more.
 */
const PERFORMANCE_CHECK_MS = 40 * 60_000
/** How often an update the Mac was too busy to measure reads it again, and how many quiet readings in a row measure again. */
export const QUIET_EVERY_MS = 60_000
export const QUIET_READINGS = 3

export class LocalUpdates {
  private source: string | null = null
  private state: LocalBuildState = { kind: "idle" }
  private candidate: string | null = null
  private preparedRoot: string | null = null
  private job: Promise<void> | null = null
  private stamp: string | null = null
  private lastReady: LocalBuildState | null = null
  /** How the last build ran its checks, for measuring its performance again. */
  private checks: { npm: string; env: NodeJS.ProcessEnv } | null = null
  /** The next reading of the Mac, while an update waits for it to quiet down. */
  private quietTimer: NodeJS.Timeout | null = null
  /** An install or restart is pending; the update stays as it is until it's done or cancelled. */
  private held = false
  /** The source against its upstream, as last read, and the reading under way. */
  private reading: UpdateSource | null = null
  private pendingRead: Promise<UpdateSource> | null = null
  private fetchedAt = 0
  /** What the running build brought, when Settings built and installed it. */
  private installed: RevisionChanges | null = null
  private readonly git: Git
  private readonly root: string
  private readonly identity: string
  private readonly changed: () => void
  private readonly running: BuildIdentity | null
  private readonly options: LocalUpdateOptions
  constructor(git: Git, root: string, identity: string, changed: () => void, running: BuildIdentity | null = null, options: LocalUpdateOptions = {}) {
    this.git = git
    this.root = root
    this.identity = identity
    this.changed = changed
    this.running = running
    this.options = options
  }

  async load(): Promise<void> {
    await this.pruneBuilds()
    try {
      this.source = z
        .string()
        .parse(
          JSON.parse(await readFile(join(this.root, "source.json"), "utf8"))
        )
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        this.state = {
          kind: "error",
          message:
            "The saved source selection could not be read. Choose the checkout again.",
        }
    }
    const kept = await readFile(join(this.root, BUILD_CHANGES), "utf8").then((text) => buildChanges.parse(JSON.parse(text))).catch(() => null)
    if (kept && kept.build === this.running?.id) this.installed = kept.changes
    const receiptPath = join(this.root, "install-result.json")
    const receipt = await readFile(receiptPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    // Other installers (the CLI, a manual copy) never write this receipt. One
    // older than the running build therefore describes an earlier installation.
    const superseded = receipt !== null && this.running !== null &&
      (await stat(receiptPath)).mtimeMs < Date.parse(this.running.builtAt)
    if (receipt && !superseded) {
      const result = z
        .object({ ok: z.boolean(), message: z.string().optional() })
        .parse(JSON.parse(receipt))
      if (!result.ok || result.message)
        this.state = {
          kind: "error",
          message:
            result.message ??
            "The previous update could not be installed. Your previous app was retained.",
        }
    }
  }

  snapshot() {
    return { source: this.source, local: this.state, checkout: this.reading, reading: this.pendingRead !== null, installed: this.installed }
  }

  /**
   * Read the source against its upstream. `fetch` asks the remote first,
   * unless a fetch answered within the last minute and `force` isn't set.
   * Readings asked for while one runs share it; `force` waits it out and
   * reads afresh.
   */
  async check({ fetch, force = false }: { fetch: boolean; force?: boolean }): Promise<UpdateSource | null> {
    const source = this.source
    if (!source) return null
    while (this.pendingRead) {
      if (!force) return this.pendingRead
      await this.pendingRead.catch(() => undefined)
    }
    const fetching = fetch && (force || Date.now() - this.fetchedAt >= FETCH_EVERY_MS)
    const installed = this.running ? { revision: this.running.revision, dirty: this.running.dirty } : null
    const read = readUpdateSource(this.git, source, { fetch: fetching, installed })
      .then((reading) => {
        if (fetching) this.fetchedAt = Date.now()
        if (this.source === source) this.reading = reading
        return reading
      })
      .finally(() => {
        this.pendingRead = null
        this.changed()
      })
    this.pendingRead = read
    this.changed()
    return read
  }

  /**
   * Remove the build directories earlier hosts left under `updates/`.
   *
   * A finished build keeps its `output/` — some 850 MB of packaged app —
   * until this host builds again, so it can be installed. Installing copies
   * it into `/Applications` first (`prepareLocalInstall`), and the prepared
   * state lives only in this process, so once a host has restarted every
   * `build-*` here is dead weight: four of them held 3.4 GB. The current
   * host's own job is never on disk yet when this runs, and a directory
   * that is not one of ours, or is a symlink, stays.
   */
  private async pruneBuilds(): Promise<string[]> {
    const removed: string[] = []
    const names: string[] = await readdir(this.root).catch(() => [])
    const files = await physicalFiles()
    for (const name of names) {
      if (!/^build-[A-Za-z0-9]+$/.test(name)) continue
      const path = join(this.root, name)
      if (path === this.preparedRoot) continue
      const info = await lstat(path).catch(() => null)
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue
      try {
        await unregisterBundle(join(path, "output/mac-arm64/Mako.app"))
        await files.rm(path, { recursive: true, force: true })
        removed.push(path)
      } catch {
        // A directory another process still holds is tried again next start.
      }
    }
    return removed
  }
  get building(): boolean {
    return this.job !== null
  }
  get ready(): boolean {
    return this.state.kind === "ready" && this.candidate !== null
  }

  async select(path: string): Promise<void> {
    if (this.job)
      throw new Error("Wait for the current build before changing its source.")
    const source = await realpath(path)
    sourcePackage.parse(
      JSON.parse(await readFile(join(source, "package.json"), "utf8"))
    )
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFile(join(this.root, "source.json"), JSON.stringify(source), {
      mode: 0o600,
    })
    this.source = source
    this.stopWaiting()
    this.candidate = null
    this.stamp = null
    this.lastReady = null
    this.reading = null
    this.fetchedAt = 0
    this.state = { kind: "idle" }
    this.changed()
    void this.check({ fetch: true }).catch(() => undefined)
  }

  start(): void {
    if (this.job) return
    if (!this.source)
      throw new Error("Choose a trusted Mako source checkout first.")
    const source = this.source
    this.stopWaiting()
    this.state = { kind: "building", phase: "copying" }
    this.candidate = null
    this.job = this.build(source)
      .catch((error) => {
        const phase =
          this.state.kind === "building" ? this.state.phase : "verification"
        const reason = error instanceof Error ? error.message.slice(0, 1500) : "Unexpected build failure"
        const what = phase === "installing" ? "couldn't install dependencies" : `failed during ${phase}`
        this.state = {
          kind: "error",
          message: `The update ${what}: ${reason} Your installed app and agents were not changed.`,
          ...error instanceof DependencyInstallError && { command: error.command },
        }
      })
      .finally(() => {
        this.job = null
        this.changed()
      })
    this.changed()
  }

  async prepared(): Promise<{ app: string; identity: string }> {
    if (!this.ready || !this.candidate)
      throw new Error("Build and verify an update before installing it.")
    const build = await verifyLocalCandidate(this.candidate, this.identity)
    if (this.state.kind !== "ready" || build.id !== this.state.build.id)
      throw new Error(
        "The prepared update changed. Build it again before installing."
      )
    return { app: this.candidate, identity: this.identity }
  }

  /**
   * Measure a built update's performance again, after a Mac too busy to
   * measure it: nothing is rebuilt, and on a pass it's ready as any other.
   * Mako starts this itself once the Mac is quiet; Retry starts it at once.
   */
  measureAgain(): void {
    if (this.job) return
    const waiting = this.state.kind === "ready" && this.state.performance ? this.state : null
    if (!waiting || !this.checks || !this.preparedRoot) throw new Error("No update is waiting to have its performance measured again.")
    this.stopWaiting()
    const { npm, env } = this.checks
    const revision = waiting.build.revision ?? undefined
    this.state = { kind: "building", phase: "checking", remeasuring: true, ...revision && { revision } }
    this.job = this.checkPerformance(npm, join(this.root, CHECKOUT), env, this.preparedRoot, revision)
      .then((performance) => {
        this.state = { kind: "ready", build: waiting.build, changes: waiting.changes, forwarded: waiting.forwarded, ...performance && { performance } }
        this.lastReady = performance ? null : this.state
        if (performance) this.waitForQuiet()
      })
      .catch((error) => {
        const reason = error instanceof Error ? error.message.slice(0, 1500) : "Unexpected failure"
        this.state = { kind: "error", message: `The update failed its performance check: ${reason} Your installed app and agents were not changed.` }
      })
      .finally(() => {
        this.job = null
        this.changed()
      })
    this.changed()
  }

  /**
   * `test:performance`, alone, its verdicts read from the file it's handed
   * (`PERFORMANCE_VERDICT_VARIABLE`): a slower row fails the build by name,
   * and rows the Mac was too busy to settle come back as the update's caveat.
   * A checkout from before verdicts writes none; its exit code says it all.
   */
  private async checkPerformance(npm: string, checkout: string, env: NodeJS.ProcessEnv, folder: string, revision: string | undefined): Promise<UnsurePerformance | undefined> {
    const file = join(folder, VERDICTS)
    await (await physicalFiles()).rm(file, { force: true })
    const started = Date.now()
    let failure: Error | undefined
    try {
      await runBuild(npm, ["run", "test:performance"], checkout, { ...env, [PERFORMANCE_VERDICT_VARIABLE]: file }, undefined, PERFORMANCE_CHECK_MS)
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    const verdicts = parseVerdicts(await readFile(file, "utf8").catch(() => ""))
    const rows = verdicts.flatMap((verdict) => verdict.rows)
    const slower = rows.filter((row) => row.outcome === "slower").map(describeRow)
    const unsure = rows.filter((row) => row.outcome === "unsure").map(describeRow)
    const busy = [...new Set(verdicts.flatMap((verdict) => verdict.busy))]
    const machine = verdicts.find((verdict) => verdict.busy.length)?.machine ?? verdicts.at(-1)?.machine ?? ""
    hostLog("updates", "performance check", {
      revision: revision?.slice(0, 12),
      outcome: failure ? "failed" : unsure.length ? "unsure" : "passed",
      measured: rows.length,
      slower: slower.join("; ") || undefined,
      unsure: unsure.join("; ") || undefined,
      machine: machine || undefined,
      ms: Date.now() - started,
    })
    if (failure) {
      const named = slower.length ? `${slower.length === 1 ? "this row is" : "these rows are"} slower than the code ${slower.length === 1 ? "its baseline" : "their baselines"} measured, beside it on this Mac: ${slower.join("; ")}. ` : ""
      throw new Error(`test:performance: ${named}${failure.message}`)
    }
    return unsure.length ? { rows: unsure, machine, busy, measuredAt: new Date().toISOString() } : undefined
  }

  /** Once the Mac reads quiet `QUIET_READINGS` times running, measure the waiting update again. */
  private waitForQuiet(): void {
    this.stopWaiting()
    const read = this.options.machine ?? (() => readMachine())
    let quiet = 0
    const look = () => {
      const timer = setTimeout(() => void read().then((reading) => {
        if (this.quietTimer !== timer) return
        if (this.job || this.state.kind !== "ready" || !this.state.performance) return this.stopWaiting()
        quiet = this.held || busyReasons(reading).length ? 0 : quiet + 1
        if (quiet < QUIET_READINGS) return look()
        hostLog("updates", "the Mac is quiet; measuring the update's performance again", { machine: describeMachine(reading) })
        this.quietTimer = null
        this.measureAgain()
      }, () => {
        if (this.quietTimer === timer) look()
      }), this.options.quietEveryMs ?? QUIET_EVERY_MS)
      timer.unref()
      this.quietTimer = timer
    }
    look()
  }

  hold(held: boolean): void {
    this.held = held
  }

  private stopWaiting(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = null
  }

  /** The packager and codesign this build's checkout carries. */
  private packager(node: string): CandidateMaker {
    return {
      package: (checkout, output, env) => runBuild(node, ["scripts/package-mac.mjs", "--local", "--dir", `--output=${output}`], checkout, env),
      verify: (app) => verifyLocalCandidate(app, this.identity),
    }
  }

  private phase(
    phase: Extract<LocalBuildState, { kind: "building" }>["phase"]
  ): void {
    const revision = this.state.kind === "building" ? this.state.revision : undefined
    this.state = { kind: "building", phase, ...revision && { revision } }
    this.changed()
  }

  private async build(source: string): Promise<void> {
    const node = resolveExecutable("node")
    const npm = resolveExecutable("npm")
    if (!node || !npm)
      throw new Error("Node.js and npm are required to build Mako.")
    // What's available decides what's built: fetch, bring the checkout
    // forward when it can be, and don't rebuild what is already installed.
    const reading = await this.check({ fetch: true, force: true })
    if (reading?.kind === "unreadable") throw new Error(reading.reason)
    if (reading?.kind === "checkout" && (reading.plan.kind === "current" || (reading.plan.kind === "as-is" && reading.plan.installed))) {
      this.state = { kind: "idle" }
      return
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await ensureBuildSpace(this.root, await buildCopyBytes(source), this.options.statfs)
    const forwarded = reading ? await bringForward(this.git, source, reading) : null
    const built = forwarded ? await this.check({ fetch: false, force: true }) : reading
    const revision = built?.kind === "checkout" ? { revision: built.head } : {}
    this.state = { kind: "building", phase: "copying", ...revision }
    this.changed()
    const inherited = Object.fromEntries(
      [
        "HOME",
        "PATH",
        "TMPDIR",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LC_ALL",
      ].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]]
      )
    )
    // A lockfile the fast-forward (or a pull) changed: install what it
    // lists into the checkout first, with the npm and Node the build uses.
    const missing = await uninstalledPackages(source)
    if (missing.length) {
      this.state = { kind: "building", phase: "installing", ...revision, dependencies: missingDependencies(missing) }
      this.changed()
      const env = environmentForExecutable(node, inherited)
      await installDependencies(this.git, source, missing, {
        run: (args, signal) => runBuild(npm, args, source, env, signal),
        timeoutMs: this.options.installTimeoutMs,
      })
      this.phase("copying")
    }
    const checkout = join(this.root, CHECKOUT)
    await moveLegacyCheckout(this.root)
    const job = await mkdtemp(join(this.root, "build-"))
    const output = join(job, "output")
    try {
      // The uncommitted files are read as the copy is taken, and the build carries them by name.
      const [revision, uncommitted, fingerprint] = await Promise.all([
        this.git.text({ cwd: source, args: ["rev-parse", "HEAD"], timeoutMs: 10_000 }),
        readUncommitted(this.git, source),
        syncBuildCheckout(source, checkout),
      ])
      const dirty = uncommitted.count > 0
      const stamp = `${fingerprint}:${revision}:${dirty ? 1 : 0}:${this.identity}`
      // Identical inputs produce an identical candidate: when the prepared
      // output from a successful build is still on disk there is nothing to
      // redo — retrying an install or a mistaken second build is instant.
      if (
        this.lastReady &&
        this.stamp === stamp &&
        this.candidate &&
        (await lstat(this.candidate).catch(() => null))
      ) {
        this.state = this.lastReady
        this.changed()
        return
      }
      const variables: NodeJS.ProcessEnv = {
        ...inherited,
        MAKO_LOCAL_SIGNING_IDENTITY: this.identity,
        MAKO_BUILD_REVISION: revision,
        MAKO_BUILD_DIRTY: dirty ? "1" : "0",
        [BUILD_UNCOMMITTED_VARIABLE]: JSON.stringify(uncommitted),
      }
      // The copy has no history; a performance row over budget is measured beside a commit exported from here.
      if (this.options.buildSource !== false) variables.MAKO_BUILD_SOURCE = source
      const env = environmentForExecutable(node, variables)
      this.phase("compiling")
      // Lint reads only sources, so it overlaps the compile; the test steps
      // need the built output and then run independently of each other.
      await Promise.all([
        runBuild(npm, ["run", "build"], checkout, env),
        runBuild(npm, ["run", "lint"], checkout, env),
      ])
      this.phase("checking")
      const checks = ["test:application", "test:renderer-assets"]
      const results = await Promise.allSettled(
        checks.map((script) => runBuild(npm, ["run", script], checkout, env))
      )
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${checks[index]}: ${result.reason instanceof Error ? result.reason.message : result.reason}`]
          : []
      )
      if (failures.length) throw new Error(failures.join(" "))
      // Alone, after the rest: a timing that shares the Mac with the update's own checks measures them too.
      const performance = await this.checkPerformance(npm, checkout, env, job, revision)
      this.phase("packaging")
      const maker = this.options.candidate ?? this.packager(node)
      await maker.package(checkout, output, env)
      this.phase("verifying")
      const candidate = join(output, "mac-arm64/Mako.app")
      const build = await maker.verify(candidate)
      if (this.preparedRoot) {
        await unregisterBundle(
          join(this.preparedRoot, "output/mac-arm64/Mako.app")
        )
        await (await physicalFiles()).rm(this.preparedRoot, { recursive: true, force: true })
      }
      this.preparedRoot = job
      this.candidate = candidate
      // Counted to the revision the build stamped, whatever moved in the checkout meanwhile.
      const changes = this.running?.revision && build.revision ? await changesSince(this.git, source, this.running.revision, build.revision) : null
      if (changes) await writeFile(join(this.root, BUILD_CHANGES), JSON.stringify({ build: build.id, changes } satisfies z.infer<typeof buildChanges>), { mode: 0o600 })
      this.state = { kind: "ready", build, changes, forwarded, ...performance && { performance } }
      this.stamp = stamp
      this.checks = { npm, env }
      // A build the Mac was too busy to measure isn't one to hand back unmeasured on the next Build.
      this.lastReady = performance ? null : this.state
      if (performance) this.waitForQuiet()
    } finally {
      if (this.preparedRoot !== job) {
        await unregisterBundle(join(output, "mac-arm64/Mako.app"))
        await (await physicalFiles()).rm(job, { recursive: true, force: true })
      }
    }
  }
}

/** The copy an earlier build kept as `checkout`, renamed `CHECKOUT` where nothing is there yet: its manifest and compile output carry over. */
async function moveLegacyCheckout(root: string): Promise<void> {
  const legacy = join(root, LEGACY_CHECKOUT)
  const info = await lstat(legacy).catch(() => null)
  if (!info?.isDirectory() || (await lstat(join(root, CHECKOUT)).catch(() => null))) return
  await rename(legacy, join(root, CHECKOUT))
}

const buildCaches = new Set([".git", ".next", ".eve", ".output", ".vercel", ".cache", ".turbo", ".DS_Store"])

const SYNC_MANIFEST = ".mako-sync.json"
const DEPENDENCIES_SENTINEL = join("node_modules", ".package-lock.json")

interface BuildSyncManifest {
  /** Signatures of npm's dependency sentinel and the project lockfile. */
  deps: string | null
  /** Last synced source entries: relative path → signature. */
  entries: Record<string, string>
}

const syncManifestSchema = z.object({
  deps: z.string().nullable(),
  entries: z.record(z.string(), z.string()),
})

const buildSourceFilter = (path: string) => {
  const name = basename(path)
  return (
    !name.startsWith(".env") &&
    !buildCaches.has(name) &&
    !name.endsWith(".tsbuildinfo")
  )
}

async function entrySignature(
  files: Awaited<ReturnType<typeof physicalFiles>>,
  path: string,
  entry: { isSymbolicLink(): boolean; isDirectory(): boolean }
): Promise<string> {
  if (entry.isSymbolicLink()) return `l:${await files.readlink(path)}`
  if (entry.isDirectory()) return "d"
  const info = await files.lstat(path)
  return `${info.size}:${info.mtimeMs}`
}

/**
 * The tracked source tree as relative path → signature, `node_modules`
 * excepted: it is managed whole through the dependency sentinel instead of
 * per-file diffs. Same admission rules as `copyBuildSource` — top-level
 * dotfiles except .npmrc/.prettier*, the excluded set, no top-level links,
 * and the per-name filter at every level below.
 */
async function scanBuildSource(
  files: Awaited<ReturnType<typeof physicalFiles>>,
  source: string
): Promise<Map<string, string>> {
  const entries = new Map<string, string>()
  const visit = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await files.readdir(dir, { withFileTypes: true })) {
      const name = entry.name
      const path = join(dir, name)
      const relative = rel ? `${rel}/${name}` : name
      if (!rel) {
        const config = name === ".npmrc" || name.startsWith(".prettier")
        if (
          (!config && name.startsWith(".")) ||
          excluded.has(name) ||
          !buildSourceFilter(path)
        )
          continue
        if (entry.isSymbolicLink())
          throw new Error("Build source entries must not be symbolic links.")
      } else if (!buildSourceFilter(path)) continue
      if (entry.isDirectory()) {
        entries.set(relative, "d")
        if (rel || name !== "node_modules") await visit(path, relative)
      } else {
        entries.set(relative, await entrySignature(files, path, entry))
      }
    }
  }
  await visit(source, "")
  return entries
}

/**
 * Sync the private build checkout instead of copying the whole tree.
 *
 * A manifest of the last synced signatures makes repeat updates copy only
 * what changed — the full clone of a checkout plus node_modules was the
 * slowest step of every local update. node_modules is replaced whole only
 * when npm's sentinel or the project lockfile moved; hand edits inside it
 * are deliberately not tracked. Generated output (dist, tsbuildinfo) is never
 * synced, so it survives in the checkout and the compile stays incremental.
 */
export async function syncBuildCheckout(
  source: string,
  checkout: string
): Promise<string> {
  const files = await physicalFiles()
  let manifest: BuildSyncManifest | null = await files
    .readFile(join(checkout, SYNC_MANIFEST), "utf8")
    .then((text) => syncManifestSchema.parse(JSON.parse(text)))
    .catch(() => null)
  if (!manifest) {
    await files.rm(checkout, { recursive: true, force: true })
    manifest = { deps: null, entries: {} }
  }
  await files.mkdir(checkout, { recursive: true })

  const locks = await Promise.all(
    [DEPENDENCIES_SENTINEL, "package-lock.json"].map((path) => files
      .lstat(join(source, path))
      .then((info) => `${info.size}:${info.mtimeMs}`)
      .catch(() => null))
  )
  const deps = locks[0] === null ? null : JSON.stringify(locks)
  const sourceModules = await files
    .lstat(join(source, "node_modules"))
    .then((info) => info.isDirectory())
    .catch(() => false)
  const checkoutModules = await files
    .lstat(join(checkout, "node_modules"))
    .then((info) => info.isDirectory())
    .catch(() => false)
  const uninstalled = sourceModules ? await uninstalledPackages(source) : []
  if (uninstalled.length) {
    const named = uninstalled.slice(0, 3).join(", ") + (uninstalled.length > 3 ? ` and ${uninstalled.length - 3} more` : "")
    throw new Error(`${source} hasn't installed what its package-lock.json lists (${named}). Run npm install there, then build the update again.`)
  }
  let resyncedDependencies = false
  if (!sourceModules) {
    await files.rm(join(checkout, "node_modules"), {
      recursive: true,
      force: true,
    })
  } else if (deps === null || manifest.deps !== deps || !checkoutModules) {
    // No sentinel means there is nothing trustworthy to diff against; pay the
    // whole copy rather than guess at npm's tree.
    await files.rm(join(checkout, "node_modules"), {
      recursive: true,
      force: true,
    })
    await files.cp(join(source, "node_modules"), join(checkout, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: buildSourceFilter,
    })
    resyncedDependencies = true
  }

  const scanned = await scanBuildSource(files, source)
  const newLinks: string[] = []
  for (const [rel, signature] of scanned) {
    if (manifest.entries[rel] === signature) continue
    const from = join(source, rel)
    const to = join(checkout, rel)
    if (signature === "d") {
      await files.mkdir(to, { recursive: true })
      continue
    }
    const existing = await files.lstat(to).catch(() => null)
    const info = await files.lstat(from)
    if (
      existing &&
      (existing.isDirectory() ||
        existing.isSymbolicLink() !== info.isSymbolicLink())
    )
      await files.rm(to, { recursive: true, force: true })
    await files.mkdir(dirname(to), { recursive: true })
    await files.cp(from, to, {
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    })
    if (info.isSymbolicLink()) newLinks.push(to)
  }
  for (const rel of Object.keys(manifest.entries))
    if (!scanned.has(rel))
      await files.rm(join(checkout, rel), { recursive: true, force: true })

  const root = await files.realpath(checkout)
  const checkLink = async (link: string) => {
    const resolved = await files.realpath(link).catch(() => null)
    if (resolved && resolved !== root && !resolved.startsWith(`${root}/`))
      throw new Error(
        `The dependency link ${relative(root, link)} leaves the private build copy. Reinstall dependencies in the source checkout before building.`
      )
  }
  // A link's resolution is fixed by its location and text, so only newly
  // synced links need checking; a wholesale dependency resync revalidates its
  // tree the way the original copy did.
  for (const link of newLinks) await checkLink(link)
  if (resyncedDependencies) {
    const pending = [join(checkout, "node_modules")]
    while (pending.length) {
      const directory = pending.pop()!
      for (const entry of await files.readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) await checkLink(path)
        else if (entry.isDirectory()) pending.push(path)
      }
    }
  }

  await writeFile(
    join(checkout, SYNC_MANIFEST),
    JSON.stringify({ deps: sourceModules ? deps : null, entries: Object.fromEntries(scanned) } satisfies BuildSyncManifest),
    { mode: 0o600 }
  )
  const fingerprint = createHash("sha256")
  for (const [path, signature] of [...scanned].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  ))
    fingerprint.update(`${path} ${signature}\n`)
  return fingerprint.update(`deps ${deps}`).digest("hex")
}

export async function copyBuildSource(
  source: string,
  checkout: string
): Promise<void> {
  const files = await physicalFiles()
  const filter = (path: string) => {
    const name = basename(path)
    return !name.startsWith(".env") && !buildCaches.has(name) && !name.endsWith(".tsbuildinfo")
  }
  const entries = await files.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const config = entry.name === ".npmrc" || entry.name.startsWith(".prettier")
    if ((!config && entry.name.startsWith(".")) || excluded.has(entry.name))
      continue
    if (entry.isSymbolicLink())
      throw new Error("Build source entries must not be symbolic links.")
    await files.cp(join(source, entry.name), join(checkout, entry.name), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter,
    })
  }
  await files.cp(join(source, "node_modules"), join(checkout, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter,
  })
  const root = await files.realpath(checkout)
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of await files.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const resolved = await files.realpath(path)
        if (!resolved.startsWith(`${root}/`))
          throw new Error(
            `The dependency link ${relative(root, path)} leaves the private build copy. Reinstall dependencies in the source checkout before building.`
          )
      } else if (entry.isDirectory()) pending.push(path)
    }
  }
}

async function runBuild(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeoutMs = BUILD_STEP_MS
): Promise<void> {
  // Keep a bounded diagnostic tail. Discarding all output made a failed
  // Settings check report only "exited with 1", hiding the failing test.
  let stdout = ""
  let stderr = ""
  const { code, stopped } = await runProcessGroup(command, args, {
    cwd,
    env,
    stdio: "pipe",
    signal,
    timeoutMs,
    output: (stream, text) => {
      if (stream === "stdout") stdout = (stdout + text).slice(-8192)
      else stderr = (stderr + text).slice(-8192)
    },
  })
  if (signal?.aborted) throw signal.reason
  if (code === 0 && !stopped) return
  if (stopped === "timeout") throw new Error("The build step exceeded its time limit.")
  // The pipes can drain out of order: a stdout burst must not erase the
  // final stderr failure, even if the child wrote stderr last.
  const diagnostic = [stdout.slice(stderr ? -600 : -1200), stderr.slice(stdout ? -600 : -1200)]
    .map(text => stripVTControlCharacters(text).trim()).filter(Boolean).join("\n")
  throw new Error(`${basename(command)} ${args.join(" ")} exited with ${code ?? "a signal"}. ${diagnostic || "The step produced no diagnostic output."}`)
}
