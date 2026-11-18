// Who changed what, from a host's attribution journal, read-only beside the
// running host:
//
//   npm run attribution -- status
//   npm run attribution -- why <file>:<line>
//   npm run attribution -- thread <thread id>
//   npm run attribution -- partition <checkout> <thread id>
//   npm run attribution -- restorable <file> | --thread <thread id>
//   npm run attribution -- footprint <thread id> [--turns 5]
//   npm run attribution -- files <thread id> <spelling>... [--as-of <time>] [--cwd <folder>]
//   npm run attribution -- history <thread id> [--out <file>]
//
// The journal is the device's shared one, in the user root every host of
// `MAKO_PROFILE` shares (`~/.mako`; an isolated data root is its own);
// `--data-root` or `--journal` point elsewhere. Paths, authors and timings only: a line's
// text is printed for `why`, as `git blame` would.
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Attribution } from "@mako/protocol"
import { resolveHostEnvironment } from "@mako/host/base/host-environment"
import { journalPath } from "@mako/host/attribution/index"
import { JournalStore } from "@mako/host/attribution/journal-store"
import { decodeText } from "@mako/host/attribution/content"
import { splitLines } from "@mako/host/attribution/line-diff"
import { presentRuns } from "@mako/host/attribution/line-map"
import { NoiseBaseline } from "@mako/host/attribution/noise-baseline"
import { within } from "@mako/host/attribution/paths"
import type { FootprintBasis } from "@mako/protocol"
import { changes, partition, restorable, shares, storedView, writerOf } from "@mako/host/attribution/queries"
import { attributionStatus } from "@mako/host/attribution/status"
import { ThreadFiles } from "@mako/host/attribution/thread-files"
import { threadHistory } from "@mako/host/attribution/thread-history"
import { candidatesOf, resolveSpelling } from "@mako/host/files/index"
import { Git } from "@mako/git"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const value = args[at + 1]
  args.splice(at, 2)
  return value
}
const journalOption = option("--journal")
const turnsOption = option("--turns")
const asOfOption = option("--as-of")
const cwdOption = option("--cwd")
const dataRootOption = option("--data-root")
const outOption = option("--out")
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const environment = resolveHostEnvironment({ env: { ...process.env, ...(dataRootOption && { MAKO_DATA_ROOT: dataRootOption }) }, appRoot, platform: process.platform, home: homedir() })
const path = journalOption ?? journalPath(environment.userRoot)
if (!existsSync(path)) {
  console.error(`No attribution journal at ${path}. Start a host with that data folder, or pass --data-root or --journal.`)
  process.exit(1)
}
const store = JournalStore.open(path, { device: "", readOnly: true })
const view = storedView(store)
const [command, ...rest] = args

const time = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "")
const bytes = (count: number) => (count >= 1024 ** 3 ? `${(count / 1024 ** 3).toFixed(2)} GB` : count >= 1024 ** 2 ? `${(count / 1024 ** 2).toFixed(1)} MB` : `${(count / 1024).toFixed(1)} KB`)

/** Why a footprint entry was kept, in words. */
const FOOTPRINT_BASES = {
  writer: "one of its session's processes wrote it",
  named: "one of its calls named it",
  folder: "in a folder one of its calls named",
  output: "a command's output mentioned it",
  cwd: "in a folder the turn ran in",
  window: "changed while the turn ran and no rule explains it",
} satisfies Record<FootprintBasis, string>

function who(author: Attribution | null): string {
  if (!author) return "the base (committed)"
  switch (author.certainty) {
    case "exact":
      return `Thread ${author.author.thread}, exact: its call ${author.author.call ?? "?"} reported this ${author.effect}`
    case "named":
      return `Thread ${author.author.thread}, named: a call in flight named the path (${author.by})`
    case "window":
      return `Thread ${author.author.thread}, window: the only Thread running in this checkout (during its ${author.during})`
    case "ambiguous":
      return `ambiguous (${author.reason}): ${author.candidates.map((candidate) => `Thread ${candidate.thread}`).join(", ") || "no Thread was running"}`
    case "person":
      return author.via === "editor" ? "the person, saving through Mako" : "the person or another app: no Thread was running"
    case "mako":
      return `Mako itself: ${author.operation}`
  }
}

/** The call, turn or background work behind an author, as the journal recorded it. */
function evidence(author: Attribution | null): string[] {
  if (!author || !("author" in author)) return []
  const { session, call, work, turn } = author.author
  const found = call ? store.activity(session, "call", call) : work ? store.activity(session, "background", work) : turn ? store.activity(session, "turn", turn) : undefined
  const turnRecord = turn ? store.activity(session, "turn", turn)?.record : undefined
  const lines = [`    session ${session}${turn ? `, turn ${turn}` : ""}${call ? `, call ${call}` : ""}${work ? `, background work ${work}` : ""}`]
  if (found) {
    lines.push(`    ${found.kind} ${found.label ?? ""} ran ${time(found.start)} to ${found.end === null ? "still running" : time(found.end)}${found.cwd ? ` in ${found.cwd}` : ""}`)
    if (found.named.length) lines.push(`    named: ${found.named.slice(0, 8).join(", ")}${found.named.length > 8 ? ` and ${found.named.length - 8} more` : ""}`)
    for (const effect of found.effects ?? []) lines.push(`    reported ${effect.kind}: ${"path" in effect ? effect.path : "command" in effect ? effect.command.slice(0, 160) : `${effect.from} → ${effect.to}`}`)
  }
  const record = found?.record ?? turnRecord
  if (record) lines.push(`    the harness's record: ${record}${call ? ` (call ${call}; npm run decode reads it)` : ""}`)
  return lines
}

/** The tracked root a file is in, by the path as given or with its links resolved (`/tmp` is `/private/tmp`). */
function rootOf(file: string) {
  const absolute = resolve(file)
  const real = existsSync(absolute) ? realpathSync(absolute) : absolute
  const roots = store.roots().filter((item) => item.active).sort((a, b) => b.path.length - a.path.length)
  for (const root of roots) {
    const base = existsSync(root.path) ? realpathSync(root.path) : root.path
    for (const [folder, path] of [[root.path, absolute], [base, real]] as const)
      if (within(folder, path) && path !== folder) return { root, path: path.slice(folder.length + 1) }
  }
  console.error(`${real} isn't in a tracked checkout. Tracked: ${roots.map((item) => item.path).join(", ") || "none"}`)
  process.exit(1)
}

switch (command) {
  case "status": {
    const status = attributionStatus(view)
    console.log(`journal ${status.journal.id} on ${status.journal.device}: ${status.journal.path}, ${bytes(status.journal.bytes)}`)
    console.log(`entries ${status.entries.total} (${status.entries.unsettled} not settled); ${Object.entries(status.entries.byCertainty).map(([key, count]) => `${key} ${count}`).join(", ") || "none yet"}; ambiguous ${(status.entries.ambiguousShare * 100).toFixed(1)}%`)
    console.log(`kept content: ${status.blobs.count} versions, ${bytes(status.blobs.bytes)} compressed (budget 2 GB, 14 days past the last uncommitted line)`)
    console.log(`activity ${status.activity} turns, calls and background work; footprint ${status.footprint} paths outside the checkouts`)
    console.log(status.lag ? `heard to journaled over the last ${status.lag.flushes} flushes: p50 ${status.lag.p50} ms, p95 ${status.lag.p95} ms, max ${status.lag.max} ms; hashing ${status.lag.hashMs} ms and line maps ${status.lag.diffMs} ms a flush` : "no flush timings saved yet")
    for (const root of status.roots)
      console.log(`root ${root.path}${root.repository ? ` at ${root.head?.slice(0, 12) ?? "no commit"}` : " (folder)"}: ${root.files} files, ${root.changed} with uncommitted changes, last heard ${time(root.seenAt)}${root.caughtUpTo ? `, history mark ${root.caughtUpTo}` : ""}`)
    for (const gap of status.gaps) console.log(`gap ${gap.id} in ${gap.root}: ${gap.reason}, ${time(gap.from)} to ${time(gap.to)}`)
    break
  }
  case "why": {
    const target = rest[0] ?? ""
    const at = target.lastIndexOf(":")
    const line = Number(target.slice(at + 1))
    if (at < 0 || !Number.isInteger(line) || line < 1) {
      console.error("Usage: npm run attribution -- why <file>:<line>")
      process.exit(1)
    }
    const { root, path: relative } = rootOf(target.slice(0, at))
    const file = store.files().find((item) => item.root === root.id && item.path === relative)
    if (!file) {
      console.log(`${relative} has no uncommitted change the journal saw: line ${line} is as committed at ${root.head?.slice(0, 12) ?? "the base"} (git blame says who).`)
      break
    }
    const run = presentRuns(file.map).find((item) => line - 1 >= item.start && line - 1 < item.start + item.length)
    const text = file.current ? store.blob(file.current) : undefined
    if (text) console.log(`${relative}:${line}  ${(splitLines(decodeText(text))[line - 1] ?? "").trimEnd().slice(0, 160)}`)
    if (!run) {
      console.log(`line ${line} is past the end of the file as the journal last saw it.`)
      break
    }
    const seq = run.ins > 0 ? run.ins : 0
    const author = seq ? view.author(seq) : null
    console.log(`last written by ${who(author)}${seq ? ` (entry ${seq})` : run.ins < 0 ? " (a writer the journal never saw)" : ""}`)
    for (const detail of evidence(author)) console.log(detail)
    if (run.over > 0) console.log(`  it replaced lines entry ${run.over} wrote: ${who(view.author(run.over))}`)
    console.log(`\n${relative} since its base:`)
    for (const entry of store.chain(root.id, relative, file.baseSeq))
      console.log(`  ${entry.seq}  ${time(entry.changedAt)}  ${entry.kind.padEnd(6)} +${entry.added ?? 0} -${entry.removed ?? 0}  ${entry.observed}${entry.restores ? `, restores ${entry.restores}` : ""}  ${who(entry.author)}${entry.settled ? "" : " (not settled)"}`)
    break
  }
  case "thread": {
    const thread = rest[0]
    if (!thread) {
      console.error("Usage: npm run attribution -- thread <thread id>")
      process.exit(1)
    }
    const summary = changes(view, thread)
    const { created, modified, deleted, renamed } = summary.files
    console.log(`Thread ${thread}: ${created.length} created, ${modified.length} changed, ${deleted.length} deleted, ${renamed.length} renamed; +${summary.lines.added} -${summary.lines.removed} lines`)
    console.log(`certainty: ${Object.entries(summary.certainty).map(([key, count]) => `${key} ${count}`).join(", ") || "no entries"}; ${summary.maybe} more might be its own (ambiguous)`)
    for (const [label, paths] of [["created", created], ["changed", modified], ["deleted", deleted]] as const) for (const item of paths) console.log(`  ${label} ${item}`)
    for (const item of renamed) console.log(`  renamed ${item.from} → ${item.to}`)
    for (const item of summary.commands.slice(-20)) console.log(`  ran ${item.command.slice(0, 160)}${item.exitCode !== undefined ? ` (exit ${item.exitCode})` : ""}`)
    for (const item of summary.outside) console.log(`  outside: ${item.access} ${item.path} (${item.evidence}${item.secret ? ", looks like a secret" : ""})`)
    break
  }
  case "partition": {
    const [checkout, thread] = rest
    if (!checkout || !thread) {
      console.error("Usage: npm run attribution -- partition <checkout> <thread id>")
      process.exit(1)
    }
    const given = resolve(checkout)
    const tracked = store.roots().filter((item) => item.active).map((item) => item.path)
    const folder = tracked.some((path) => within(given, path) || within(path, given)) ? given : realpathSync(given)
    const result = partition(view, folder, thread)
    console.log(`${result.files.length} files go with Thread ${thread} (${result.ms.toFixed(1)} ms)`)
    for (const file of result.files) console.log(`  ${file.move === "whole" ? "whole" : "lines"} ${file.path}: Thread's side ${file.thread.kind}, checkout keeps ${file.remaining.kind}`)
    for (const hunk of result.whole) console.log(`  whole hunk ${hunk.path} base ${hunk.base.start + 1}+${hunk.base.length} → ${hunk.to}: ${hunk.reason}`)
    for (const item of result.uncertain) console.log(`  uncertain ${item.path}${item.lines ? `:${item.lines.start + 1}+${item.lines.length}` : ""} (${item.certainty}, entry ${item.entry}) stays`)
    for (const item of result.unattributed) console.log(`  not attributed ${item.path}${item.lines ? `:${item.lines.start + 1}+${item.lines.length}` : ""} (entry ${item.entry}) stays`)
    // What a worktree move would say, as the move card does: files and lines by whose they are.
    const divided = shares(view, folder, thread)
    const kinds = [["the thread's", divided.thread], ["other threads'", divided.others], ["the person's", divided.person], ["might be its", divided.uncertain], ["not attributed", divided.unattributed]] as const
    console.log(`  by whose: ${kinds.map(([label, share]) => `${label} ${share.files.length} files, ${share.lines} lines`).join("; ")}`)
    break
  }
  case "restorable": {
    const thread = option("--thread") ?? (rest[0] === "--thread" ? rest[1] : undefined)
    const target = thread ? { thread } : (() => {
      const { root, path: relative } = rootOf(rest[0] ?? ".")
      return { root: root.id, path: relative }
    })()
    for (const version of restorable(view, target))
      console.log(`  entry ${version.entry}  ${time(version.at)}  ${version.path}  ${version.size === undefined ? "" : bytes(version.size)}  ${writerOf(version.author).certainty}${writerOf(version.author).thread ? ` ${writerOf(version.author).thread}` : ""}  ${version.ref}`)
    break
  }
  case "files": {
    const [thread, ...spellings] = rest
    if (!thread || !spellings.length) {
      console.error("Usage: npm run attribution -- files <thread id> <spelling>... [--as-of <time, or ms>] [--cwd <folder>]")
      process.exit(1)
    }
    const asOf = asOfOption === undefined ? undefined : /^\d+$/.test(asOfOption) ? Number(asOfOption) : Date.parse(asOfOption)
    if (asOf !== undefined && Number.isNaN(asOf)) {
      console.error(`--as-of ${asOfOption} isn't a time. Give an ISO time or milliseconds.`)
      process.exit(1)
    }
    const worked = [...store.activityOfThread(thread), ...store.carriedParts(thread).flatMap((part) => part.activity)]
    const cwd = cwdOption ? resolve(cwdOption) : worked.sort((a, b) => b.start - a.start).find((item) => item.cwd)?.cwd
    const files = new ThreadFiles({ git: new Git(), home: homedir() })
    const source = { thread, cwd, current: cwd ? [cwd] : [], asOf }
    // The first asks read Git's renames in the background, as the host's first answer does; wait for them here.
    await files.context(store, source)
    await files.renamesRead()
    const context = await files.context(store, source)
    const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
    const place = (root: string) => context.places.find((item) => item.root === root)
    const home = homedir()
    const short = (path: string) => (cwd && within(cwd, path) && path !== cwd ? path.slice(cwd.length + 1) : within(home, path) ? `~${path.slice(home.length)}` : path)
    console.log(`Thread ${thread}${asOf === undefined ? ", now" : `, as of ${time(asOf)}`}: ${context.touched.size} files touched; working in ${cwd ?? "no folder the journal knows"}; ${context.chosen?.size ?? 0} picks`)
    console.log(`  folders, latest first: ${context.folders.join(", ") || "none"}`)
    for (const item of context.places) if (item.current || item.gone || item.index) console.log(`  place ${item.root}${item.current ? " (works here now)" : ""}${item.gone ? " (gone)" : ""}${item.index ? `, ${item.index.size} files indexed` : ""}`)
    for (const part of store.carriedParts(thread)) console.log(`  carried from ${part.device} (journal ${part.journal.slice(0, 8)}, through entry ${part.through}, taken ${time(part.at)}): ${part.activity.length} calls, ${part.writes.length} writes, ${part.names.filter((name) => name.to).length} renames`)
    for (const spelling of spellings) {
      const answer = resolveSpelling(spelling, context, isFile)
      const said = answer.kind === "file" ? `${short(answer.file.path)} (${answer.file.reason})${answer.others?.length ? `, ${answer.others.length} more to pick again` : ""}` : answer.kind === "choice" ? `a chooser of ${answer.candidates.length}` : "plain text"
      console.log(`\n${spelling} → ${said}`)
      for (const draft of candidatesOf(spelling, context)) {
        const touch = context.touched.get(draft.path) ?? (draft.was ? context.touched.get(draft.was) : undefined)
        const where = [...context.places].sort((a, b) => b.root.length - a.root.length).find((item) => draft.path.startsWith(`${item.root}/`))
        console.log(`  ${isFile(draft.path) ? "file" : "none"}  ${short(draft.path)}  ${draft.reason}${Number.isFinite(draft.folder) ? ` from folder ${draft.folder + 1}` : ""}${draft.was ? `, was ${short(draft.was)}` : ""}${touch ? `, ${touch.kind} ${time(touch.at)}` : ", not touched"}${where && place(where.root)?.current ? ", where it works now" : ""}`)
      }
    }
    break
  }
  case "history": {
    const thread = rest[0]
    if (!thread) {
      console.error("Usage: npm run attribution -- history <thread id> [--out <file>]")
      process.exit(1)
    }
    const began = performance.now()
    const history = threadHistory(store, thread, Date.now())
    const ms = performance.now() - began
    const json = JSON.stringify(history)
    console.log(`Thread ${thread}'s file history from journal ${history.from.slice(0, 8)}: ${history.parts.length} parts, ${history.choices.length} picks, ${bytes(json.length)}, written in ${ms.toFixed(0)} ms`)
    for (const part of history.parts) {
      console.log(`  ${part.journal === history.from ? "own" : "carried"} part of ${part.device} (journal ${part.journal.slice(0, 8)}), through entry ${part.through}, taken ${time(part.at)}`)
      console.log(`    ${part.activity.length} calls, ${part.writes.length} certain writes, ${part.names.length} paths' last entries (${part.names.filter((name) => name.to).length} renamed away)`)
      for (const root of part.roots) console.log(`    in ${root.path}${root.repository ? "" : " (folder)"}`)
    }
    for (const choice of history.choices) console.log(`  picked ${choice.path} for ${choice.spelling}, ${time(choice.at)}`)
    if (outOption) {
      writeFileSync(outOption, json)
      console.log(`Written to ${outOption}: paths and kinds only, never file content or a command's text.`)
    }
    break
  }
  case "footprint": {
    const thread = rest[0]
    if (!thread) {
      console.error("Usage: npm run attribution -- footprint <thread id> [--turns 5]")
      process.exit(1)
    }
    const home = homedir()
    const short = (path: string) => (within(home, path) ? `~${path.slice(home.length)}` : path)
    const entries = store.footprint("thread", thread)
    for (const turn of store.footprintTurns(thread, Number(turnsOption ?? 5))) {
      const own = entries.filter((entry) => entry.session === turn.session && (entry.turn ?? undefined) === turn.turn)
      console.log(`turn ${turn.turn ?? "?"} of session ${turn.session}, ${time(turn.start)} to ${time(turn.end)}${turn.complete ? "" : " (the history may be incomplete)"}`)
      console.log(`  the history read ${turn.read} paths and left ${turn.ignored} out under rule folders in ${turn.ms.read} ms; the rules took ${turn.ms.classify} ms`)
      console.log(`  kept ${turn.kept.strong} strong, ${turn.kept.weak} weak; left out ${Object.entries(turn.excluded).map(([rule, count]) => `${rule} ${count}`).join(", ") || "nothing"}`)
      for (const group of turn.groups.slice(0, 12)) console.log(`    left out ${String(group.count).padStart(6)}  ${group.rule.padEnd(13)} ${short(group.folder)}${group.why ? `  (${group.why})` : ""}`)
      for (const entry of own.filter((item) => item.evidence === "strong")) console.log(`    kept ${entry.access.padEnd(5)} ${short(entry.path)}  (${FOOTPRINT_BASES[entry.basis ?? "named"]}${entry.secret ? "; looks like a secret, never carried" : ""})`)
      const weak = own.filter((item) => item.evidence === "weak")
      for (const entry of weak.slice(0, 10)) console.log(`    weak ${short(entry.path)}  (${FOOTPRINT_BASES.window})`)
      if (weak.length > 10) console.log(`    and ${weak.length - 10} more weak`)
    }
    const baseline = new NoiseBaseline(store, { roots: [home, "/private/tmp"], now: () => Date.now() })
    console.log(`\nlearned noise: ${baseline.size} keys, ${baseline.folders().length} folders a history read leaves out; strongest:`)
    for (const row of baseline.list(20)) console.log(`  ${row.score.toFixed(2).padStart(6)}  ${row.kind.padEnd(8)} idle ${row.idle.toFixed(1)}, weak ${row.weak.toFixed(1)} in ${row.threads.length} Threads  ${short(row.key)}`)
    for (const broad of baseline.broadFolders()) console.log(`  churn as a whole: ${short(broad.folder)} (${broad.folders} of its folders changed while no Thread ran, score ${broad.score.toFixed(1)})`)
    break
  }
  default:
    console.error("Usage: npm run attribution -- status | why <file>:<line> | thread <id> | partition <checkout> <thread> | restorable <file> | restorable --thread <id> | footprint <thread id> | files <thread id> <spelling>... | history <thread id> [--out <file>]")
    process.exit(1)
}
store.close()
