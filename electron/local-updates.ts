import { constants } from "node:fs"
import { physicalFiles } from "./physical-files.js"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { createHash } from "node:crypto"
import {
  BuildIdentitySchema,
  type LocalBuildState,
} from "./contracts/app-lifecycle.js"
import { environmentForExecutable, resolveExecutable } from "./executable.js"
import { unregisterBundle } from "./local-update-installer.js"

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

export class LocalUpdates {
  private source: string | null = null
  private state: LocalBuildState = { kind: "idle" }
  private candidate: string | null = null
  private preparedRoot: string | null = null
  private job: Promise<void> | null = null
  private stamp: string | null = null
  private lastReady: LocalBuildState | null = null
  private readonly root: string
  private readonly identity: string
  private readonly changed: () => void
  constructor(root: string, identity: string, changed: () => void) {
    this.root = root
    this.identity = identity
    this.changed = changed
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
    const receipt = await readFile(
      join(this.root, "install-result.json"),
      "utf8"
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (receipt) {
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
    return { source: this.source, local: this.state }
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
    this.candidate = null
    this.stamp = null
    this.lastReady = null
    this.state = { kind: "idle" }
    this.changed()
  }

  start(): void {
    if (this.job) return
    if (!this.source)
      throw new Error("Choose a trusted Mako source checkout first.")
    const source = this.source
    this.state = { kind: "building", phase: "copying" }
    this.candidate = null
    this.job = this.build(source)
      .catch((error) => {
        const phase =
          this.state.kind === "building" ? this.state.phase : "verification"
        const reason = error instanceof Error ? error.message.slice(0, 1500) : "Unexpected build failure"
        this.state = {
          kind: "error",
          message: `The update failed during ${phase}: ${reason} Your installed app and agents were not changed.`,
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

  private phase(
    phase: Extract<LocalBuildState, { kind: "building" }>["phase"]
  ): void {
    this.state = { kind: "building", phase }
    this.changed()
  }

  private async build(source: string): Promise<void> {
    const node = resolveExecutable("node")
    const npm = resolveExecutable("npm")
    if (!node || !npm)
      throw new Error("Node.js and npm are required to build Mako.")
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const checkout = join(this.root, "checkout")
    const job = await mkdtemp(join(this.root, "build-"))
    const output = join(job, "output")
    try {
      const [revision, dirty, fingerprint] = await Promise.all([
        execute("git", ["-C", source, "rev-parse", "HEAD"], {
          timeout: 10_000,
        }).then(({ stdout }) => stdout.trim()),
        execute("git", ["-C", source, "status", "--porcelain"], {
          timeout: 10_000,
        }).then(({ stdout }) => Boolean(stdout.trim())),
        syncBuildCheckout(source, checkout),
      ])
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
      const env = environmentForExecutable(node, {
        ...inherited,
        MAKO_LOCAL_SIGNING_IDENTITY: this.identity,
        MAKO_BUILD_REVISION: revision,
        MAKO_BUILD_DIRTY: dirty ? "1" : "0",
      })
      this.phase("compiling")
      // Lint reads only sources, so it overlaps the compile; the test steps
      // need the built output and then run independently of each other.
      await Promise.all([
        runBuild(npm, ["run", "build"], checkout, env),
        runBuild(npm, ["run", "lint"], checkout, env),
      ])
      this.phase("checking")
      const checks = ["test:performance", "test:application", "test:renderer-assets"]
      const results = await Promise.allSettled(
        checks.map((script) => runBuild(npm, ["run", script], checkout, env))
      )
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${checks[index]}: ${result.reason instanceof Error ? result.reason.message : result.reason}`]
          : []
      )
      if (failures.length) throw new Error(failures.join(" "))
      this.phase("packaging")
      await runBuild(
        node,
        ["scripts/package-mac.mjs", "--local", "--dir", `--output=${output}`],
        checkout,
        env
      )
      this.phase("verifying")
      const candidate = join(output, "mac-arm64/Mako.app")
      const build = await verifyLocalCandidate(candidate, this.identity)
      if (this.preparedRoot) {
        await unregisterBundle(
          join(this.preparedRoot, "output/mac-arm64/Mako.app")
        )
        await (await physicalFiles()).rm(this.preparedRoot, { recursive: true, force: true })
      }
      this.preparedRoot = job
      this.candidate = candidate
      this.state = { kind: "ready", build }
      this.lastReady = this.state
      this.stamp = stamp
    } finally {
      if (this.preparedRoot !== job) {
        await unregisterBundle(join(output, "mac-arm64/Mako.app"))
        await (await physicalFiles()).rm(job, { recursive: true, force: true })
      }
    }
  }
}

const buildCaches = new Set([".git", ".next", ".eve", ".output", ".vercel", ".cache", ".turbo", ".DS_Store"])

const SYNC_MANIFEST = ".mako-sync.json"
const DEPENDENCIES_SENTINEL = join("node_modules", ".package-lock.json")

interface BuildSyncManifest {
  /** Signature of the npm-managed dependency sentinel, when one exists. */
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
 * when npm's own sentinel moved; hand edits inside it are deliberately not
 * tracked. Generated output (dist, tsbuildinfo) is never synced, so it
 * survives in the checkout and the compile stays incremental.
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

  const deps = await files
    .lstat(join(source, DEPENDENCIES_SENTINEL))
    .then((info) => `${info.size}:${info.mtimeMs}`)
    .catch(() => null)
  const sourceModules = await files
    .lstat(join(source, "node_modules"))
    .then((info) => info.isDirectory())
    .catch(() => false)
  const checkoutModules = await files
    .lstat(join(checkout, "node_modules"))
    .then((info) => info.isDirectory())
    .catch(() => false)
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
  env: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "ignore",
      detached: true,
    })
    let timedOut = false
    let force: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ESRCH"
        )
          reject(error)
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill("SIGTERM")
      force = setTimeout(() => kill("SIGKILL"), 5000)
    }, 20 * 60_000)
    child.once("error", (error) => {
      clearTimeout(timer)
      clearTimeout(force)
      reject(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      clearTimeout(force)
      if (code === 0 && !timedOut) resolve()
      else
        reject(
          new Error(
            timedOut
              ? "The build step exceeded its time limit."
              : `${basename(command)} ${args.join(" ")} exited with ${code ?? "a signal"}. Run this step in the selected checkout to inspect its output.`
          )
        )
    })
  })
}
