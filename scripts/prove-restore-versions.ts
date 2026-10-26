import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { homePlace, SAVED_HISTORY_READERS, SessionCatalog, type KeptRestore } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { recordWritersAt } from "@mako/sessions/record-store"
import { newestWriter } from "@mako/sessions/record-writers"
import { parseVersion } from "@mako/host/contracts/runtime-version"
import { createContinuationPlanner } from "@mako/host/conversations/continuation"
import { restorePlan, restoringResume, type InstalledRuntime } from "@mako/host/conversations/kept-resume"
import { harnessNamed, nativePath, removeSession } from "./native-harnesses.ts"
import { scratchHarnessHome, scratchInstall } from "./scratch-harness-home.ts"

/**
 * Records go only into the version of their harness that wrote them or a
 * newer one, against the real CLIs, two versions of each installed side by
 * side into scratch npm prefixes, in a scratch home (`scratch-harness-home.ts`;
 * the person's own homes, sessions and installs are never touched).
 *
 * For each harness named: the newer CLI writes a session planting a
 * codeword; Mako's record store takes it (Grok's records state no version,
 * so its capture observes the installed one, as a write heard as it lands
 * is); the harness deletes it. Then, with only the older CLI installed, the
 * host's plan offers the update and a reply would go on from the transcript,
 * and nothing is written into the harness's store. The older install is
 * updated as npm updates it (into its scratch prefix), its version read
 * again, and the same plan restores the session and the harness's own resume
 * recalls the codeword.
 *
 * Claude Code's sessions run the build the Agent SDK ships, so what's
 * "installed" for a restore is that build: the newer terminal CLI writes the
 * session, the SDK's build is the older one, and the update is Mako's own
 * (a newer SDK); after it, the newer CLI resumes.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/prove-restore-versions.ts [harness…]
 *   ... --versions codex=0.159.3:0.163.0   older:newer for a harness
 *
 * It runs model turns on each harness's own account.
 */

const run = promisify(execFile)

interface Cli { package: string; bin: string; older: string; newer: string }
const CLIS = new Map<string, Cli>([
  ["codex", { package: "@openai/codex", bin: "codex", older: "0.159.3", newer: "0.163.0" }],
  ["opencode", { package: "@opencode/cli", bin: "opencode", older: "2.0.27", newer: "2.0.32" }],
  ["grok", { package: "@xai-official/grok", bin: "grok", older: "1.0.46", newer: "1.0.62" }],
  ["claude", { package: "@anthropic-ai/claude-code", bin: "claude", older: "2.1.283", newer: "2.1.302" }],
])

const args = process.argv.slice(2)
const versions = args.indexOf("--versions")
if (versions >= 0) {
  for (const pair of (args[versions + 1] ?? "").split(",")) {
    const [harness = "", range = ""] = pair.split("=")
    const [older = "", newer = ""] = range.split(":")
    const cli = CLIS.get(harness)
    if (!cli || !older || !newer) throw new Error(`--versions takes harness=older:newer, not ${pair}`)
    Object.assign(cli, { older, newer })
  }
  args.splice(versions, 2)
}
const chosen = args.length ? args : [...CLIS.keys()]
const data = process.env["MAKO_THREAD_DATA_DIR"] ?? "/tmp"
const root = join(data, "restore-versions-proof")
await rm(root, { recursive: true, force: true })
const cwds = new Map(chosen.map((harness) => [harness, join(root, "work", harness)]))
const scratch = await scratchHarnessHome(root, [...cwds.values()])
if (scratch.expiresInHours < 0.5) throw new Error("A credential the scratch home holds expires within half an hour; sign the harness in again first")
const { home, env } = scratch
const stores = new NativeStores(false)
const lines: string[] = []

/** Installs `pkg@version` into its own prefix, as npm installs a global; the binary's path. */
async function install(prefix: string, cli: Cli, version: string): Promise<string> {
  await mkdir(prefix, { recursive: true })
  // Only in the scratch home (`scratchInstall` refuses anything else): a package's install script writes where its CLI lives (Grok's puts
  // its binary in `$GROK_HOME/bin`, repoints the `grok` link there and rewrites `config.toml`), and run with the person's home it changed
  // their own install. npm's cache stays theirs.
  await scratchInstall("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", `${cli.package}@${version}`], { env: { ...env, npm_config_cache: join(homedir(), ".npm") } })
  return join(prefix, "node_modules", ".bin", cli.bin)
}

async function installed(binary: string): Promise<string | null> {
  const { stdout } = await run(binary, ["--version"], { env: { ...env, PATH: `${join(binary, "..")}:${env["PATH"] ?? ""}` } })
  return parseVersion(stdout) ?? null
}

for (const harness of chosen) {
  const cli = CLIS.get(harness)
  if (!cli) throw new Error(`No CLI to install for ${harness}; there are ${[...CLIS.keys()].join(", ")}`)
  const spec = harnessNamed(harness)
  const cwd = cwds.get(harness)!
  await mkdir(cwd, { recursive: true })
  const note = (ok: boolean, what: string) => lines.push(`${harness.padEnd(8)} ${ok ? "PASS" : "FAIL"} ${what}`)
  const word = `VERSION-${harness.toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const readings = join(root, `${harness}-runtime-updates.json`)
  const catalog = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores, homePlace(home))), {
    recordsPath: join(root, "records"), recordsHome: home, cachePath: join(root, `${harness}-cache.json`), runtimeReadings: readings,
    readBack: { readers: SAVED_HISTORY_READERS, stores },
  })
  let id = ""
  try {
    const newer = await install(join(root, "cli", `${harness}-newer`), cli, cli.newer)
    const older = await install(join(root, "cli", `${harness}-older`), cli, cli.older)
    const newerVersion = await installed(newer)
    note(newerVersion === cli.newer && (await installed(older)) === cli.older, `${cli.package} ${cli.newer} and ${cli.older} installed side by side`)
    // The host's reading of what's installed as the session is written: the newer CLI, unchanged since it was read.
    const info = statSync(newer)
    await writeFile(readings, JSON.stringify({ version: 2, updates: { [harness]: { provider: harness, binary: newer, installed: newerVersion } }, signatures: { [harness]: { binary: newer, mtimeMs: info.mtimeMs, size: info.size, installed: newerVersion } } }))

    // The newer CLI writes the session.
    const withNewer = { ...env, PATH: `${join(newer, "..")}:${env["PATH"] ?? ""}` }
    ;({ id } = await spec.start(cwd, `Remember this codeword for later: ${word}. Reply with just OK. Don't run any tools.`, withNewer))
    const path = await nativePath(harness, id, home)
    await catalog.scan()
    note(await catalog.hold(path), "the record store holds the session")
    const writer = newestWriter(recordWritersAt(join(root, "records"), path)?.writers)
    note(writer?.version === newerVersion, `it knows ${cli.newer} wrote it (${writer ? `${writer.version}, ${writer.source}` : "nothing known"})`)
    await removeSession(harness, id, home)
    await catalog.scan({ emitChanges: true })
    const kept = catalog.list().find((ref) => ref.nativeId === id)
    note(Boolean(kept?.archived && !kept.copyOnly && !existsSync(path)), "deleted by its harness, the rail lists it from Mako's records")
    if (!kept) continue

    // Only the older version here. Claude resumes under the SDK's build, which is the older one.
    let here: InstalledRuntime = { version: harness === "claude" ? cli.older : await installed(older), offer: harness === "claude" ? { kind: "owner", owner: "Mako" } : { kind: "update", runtimeId: harness, label: "Update with npm" } }
    const restores: KeptRestore[] = []
    const planner = createContinuationPlanner({
      ref: async (at) => catalog.list().find((ref) => ref.path === at),
      live: () => ({ available: true, canResume: true }),
      assessResume: (ref) => restoringResume({
        assess: async (binding) => {
          const listed = catalog.list().find((each) => each.path === binding.path)
          return listed && !listed.archived ? { kind: "resumable", record: "unknown" } : { kind: "unavailable", reason: "The native record is missing." }
        },
        ref: (at) => catalog.list().find((each) => each.path === at),
        heldElsewhere: () => null,
        installed: () => here,
        restore: async (at, version) => {
          const restored = await catalog.restoreKept(at, version)
          restores.push(restored)
          return restored
        },
        writers: (at) => recordWritersAt(join(root, "records"), at)?.writers ?? null,
        label: (name) => name,
      })({ id: ref.nativeId, provider: ref.harness, nativeId: ref.nativeId, path: ref.path, coveredBlocks: 0, includesBase: false }),
      nativeInstalled: () => true, running: () => false, external: () => null,
    })
    const offer = restorePlan(kept, recordWritersAt(join(root, "records"), kept.path)?.writers ?? null, here)
    note(offer.kind === "update" && offer.outdated.wrote?.version === newerVersion && offer.outdated.installed === here.version, `with ${here.version} here, the composer offers the update: ${JSON.stringify(offer)}`)
    const declined = await planner.resolve(kept.path)
    note(declined.transport === "handoff" && declined.outdated?.installed === here.version && restores.at(-1)?.kind === "outdated" && !existsSync(path),
      `a reply then goes on from the transcript, and nothing is written into the older harness's store: ${JSON.stringify(declined)}`)

    // The update, as its channel runs it, then the same reply.
    let resumeWith = older
    if (harness === "claude") {
      here = { version: newerVersion, offer: here.offer }
      resumeWith = newer
    } else {
      await install(join(root, "cli", `${harness}-older`), cli, cli.newer)
      here = { version: await installed(older), offer: here.offer }
    }
    note(here.version === newerVersion, `updated: ${here.version} here now`)
    note(restorePlan(kept, recordWritersAt(join(root, "records"), kept.path)?.writers ?? null, here).kind === "native", "the composer's plan turns native")
    const plan = await planner.resolve(kept.path)
    const restored = restores.at(-1)
    note(plan.transport === "live" && "nativeId" in plan && plan.nativeId === id && restored?.kind === "restored", `the reply restores it and reopens the same session: ${JSON.stringify(plan)}`)
    const recalled = await spec.resume(cwd, id, "What codeword did I ask you to remember? Reply with just the codeword. Don't run any tools.", { ...env, PATH: `${join(resumeWith, "..")}:${env["PATH"] ?? ""}` })
    note(recalled.includes(word), `${harness} ${here.version} resumes it natively and recalls it: ${JSON.stringify(recalled.trim().slice(0, 80))}`)
  } catch (error) {
    note(false, error instanceof Error ? error.message : String(error))
  } finally {
    await catalog.stop()
    if (id) await removeSession(harness, id, home).catch(() => undefined)
  }
}
console.log(lines.join("\n"))
process.exitCode = lines.some((line) => line.includes(" FAIL ")) ? 1 : 0
