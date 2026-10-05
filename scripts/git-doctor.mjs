// "Status looks wrong" in one command: what Mako's host holds for a
// repository beside a fresh `git status`, how that status is kept, and the
// Git processes running now.
//
//   npm run git:doctor -- [path]          the installed app's host
//   MAKO_PROFILE=dev npm run git:doctor   a development profile's host
//   MAKO_DATA_ROOT=/tmp/x npm run git:doctor
//
// Exits 1 when the held status differs from Git's.
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "../dist-electron/runtime-service.js"
import { invokeRuntime, settleRuntime } from "../dist-electron/runtime-connection.js"
import { gitActivity, openRepository } from "@mako/git"

const path = resolve(process.argv[2] ?? process.cwd())
const dataRoot = runtimeDataRoot(appDataFolder(), process.env)
const { socket } = runtimeLocation(dataRoot)
const probe = await settleRuntime(socket, { timeoutMs: 2_000 }).catch(() => null)

let report
let source
if (probe?.state === "ready") {
  report = await invokeRuntime(socket, randomUUID(), "mako:git-doctor", [path]).catch((error) => {
    if (!/Unknown Mako host method/.test(error.message)) throw error
    return null
  })
  source = report ? `host ${probe.info.pid} (${dataRoot})` : `host ${probe.info.pid} predates git:doctor; restart Mako once its work finishes. This compares two fresh reads`
} else source = `no host is running for ${dataRoot}; this compares two fresh reads`
if (!report) {
  const repository = await openRepository(path)
  if (!repository) {
    console.error(`${path} isn't inside a Git repository.`)
    process.exit(2)
  }
  report = { held: false, diagnosis: await repository.diagnose(), activity: gitActivity() }
}

const { held, diagnosis: d, activity } = report
const ms = (value) => value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`
const count = (value) => value.toLocaleString("en-US")
const ago = (value) => value < 60_000 ? `${Math.round(value / 1000)} s ago` : `${Math.round(value / 60_000)} min ago`
const lines = [
  `Repository  ${d.root}`,
  `Asked       ${source}`,
  `HEAD        held ${d.held.head}${d.held.head === d.fresh.head ? "" : `, Git ${d.fresh.head}`}`,
  `Entries     held ${count(d.held.entries)}, Git ${count(d.fresh.entries)}`,
  `Kept by     ${d.watchers === 0 ? "nothing: every read is a full one" : d.rereads === null ? "full reads: Git tracks or shows files in too many folders no watcher hears" : `${d.watchers} watcher${d.watchers === 1 ? "" : "s"}`}`,
  `Unheard     ${d.unheard.length ? d.unheard.join(", ") : "none"}`,
  `Re-read     ${d.rereads === null ? "everything" : d.rereads.length ? `${d.rereads.join(", ")} on every status` : "nothing beyond what changed"}`,
  `Last heard  ${d.heardAgoMs === null ? "never" : ago(d.heardAgoMs)}`,
  `Last full   ${d.lastFull ? `${ago(d.lastFull.agoMs)}: ${d.lastFull.reason}` : "never"}`,
  `Pending     ${d.pending === "all" ? "a full read" : `${count(d.pending)} path${d.pending === 1 ? "" : "s"}`}${held ? "" : " (the host hadn't opened this repository)"}`,
  `Timings     held status ${ms(d.heldMs)}, fresh git status ${ms(d.freshMs)}`,
  `Previews    ${count(d.previews.count)} cached, ${(d.previews.bytes / 1024 / 1024).toFixed(1)} MB`,
  `Processes   ${activity.running.length ? activity.running.map((entry) => `git ${entry.command} ${ms(entry.ms)} in ${entry.cwd}`).join("; ") : "none"}${activity.queued ? `, ${activity.queued} reads queued` : ""}`,
]
console.log(lines.join("\n"))
if (d.mismatches.length === 0 && d.held.head === d.fresh.head) {
  console.log("\nThe held status matches Git's.")
} else {
  console.log(`\n${count(d.mismatches.length)} path${d.mismatches.length === 1 ? "" : "s"} differ (held → Git); run again to rule out a change between the two reads:`)
  for (const entry of d.mismatches.slice(0, 200)) console.log(`  ${(entry.held ?? "--").padEnd(4)} → ${(entry.fresh ?? "--").padEnd(4)} ${entry.path}`)
  if (d.mismatches.length > 200) console.log(`  … and ${count(d.mismatches.length - 200)} more`)
  process.exitCode = 1
}
