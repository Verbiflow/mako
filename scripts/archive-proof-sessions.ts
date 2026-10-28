import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import { threadArchiveKey } from "@mako/host/contracts/thread-lifecycle"
import { invokeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"
import { proofFolder } from "./lib/proof-folders.ts"

/**
 * Archives, through a running Mako (this Mac's own by default), the sessions Mako's own tests and proofs left in the
 * person's harness stores before proofs ran in scratch homes: the rows of its sidebar whose working folder is a proof
 * folder (`lib/proof-folders.ts`). It's the sidebar's own archive (`mako:thread-archive`, by harness and native id):
 * per device and reversible, each comes back from Archived. Nothing is deleted.
 *
 *   npx tsx scripts/archive-proof-sessions.ts                    lists them, one a line, and changes nothing
 *   npx tsx scripts/archive-proof-sessions.ts --archive <list>   archives exactly the sessions a list names, once read
 *   … --data-root <dir>                                          a host of that data root instead
 *
 * A list is tab-separated lines as the first form prints (folder kind, harness, native id, updated, native file,
 * sidebar, working folder, …); `#` starts a comment. A session it names is archived only while that host lists it in a
 * proof folder (in its sidebar, or in its working folder past the sidebar's cap), so a line naming the person's own
 * work archives nothing. Run again, it does nothing twice: each archive's request id is the session's.
 */
const { values } = parseArgs({ options: { archive: { type: "string" }, "data-root": { type: "string" } } })
const { socket } = runtimeLocation(values["data-root"] ?? runtimeDataRoot(appDataFolder(), {}))
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)

const Row = z.object({ harness: z.string(), nativeId: z.string(), path: z.string(), cwd: z.string().optional(), title: z.string().optional(), updatedAt: z.string().optional() }).loose()
const Listed = z.object({ ready: z.boolean(), threads: z.array(Row) }).loose()
const Archives = z.object({ keys: z.array(z.string()) }).loose()

/** The host's sidebar list, once it has read its whole catalog; with `cwd`, every session there, past the list's cap too. */
async function rows(filter?: { cwd: string }): Promise<z.infer<typeof Row>[]> {
  for (const deadline = Date.now() + 120_000; ; await new Promise((resolve) => setTimeout(resolve, 1_000))) {
    const listed = Listed.parse(await call("mako:threads", filter ? [filter] : []))
    if (listed.ready) return listed.threads
    if (Date.now() > deadline) throw new Error("the host hasn't read its whole catalog within two minutes")
  }
}
const archived = new Set(Archives.parse(await call("mako:thread-archives", [])).keys)
const key = (row: { harness: string; nativeId: string }) => threadArchiveKey({ kind: "native", provider: row.harness, nativeId: row.nativeId })
/** Archived already, by the sidebar or this script: under its native id or its file. */
const isArchived = (row: z.infer<typeof Row>) => archived.has(key(row)) || archived.has(threadArchiveKey({ kind: "file", path: row.path }))
/** The rows among `listed` in a proof folder, by archive key. */
const inProofFolders = (listed: readonly z.infer<typeof Row>[]) => new Map(listed.flatMap((row) => {
  const folder = proofFolder(row.cwd)
  return folder ? [[key(row), { ...row, folder }] as const] : []
}))

if (!values.archive) {
  const proofs = inProofFolders(await rows())
  const shown = [...proofs.values()].filter((row) => !isArchived(row))
  const kinds = new Map<string, number>()
  for (const row of shown) kinds.set(`${row.folder} ${row.harness}`, (kinds.get(`${row.folder} ${row.harness}`) ?? 0) + 1)
  const counts = [...kinds].map(([kind, count]) => `${kind} ${count}`)
  console.log(`# ${shown.length} sessions in proof folders shown in the sidebar (${counts.join(", ") || "none"}); ${proofs.size - shown.length} already archived`)
  console.log("# folder\tharness\tnative id\tupdated\tnative file\tsidebar\tworking folder\tnative path\ttitle")
  for (const row of shown.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "")))
    console.log([row.folder, row.harness, row.nativeId, row.updatedAt ?? "", existsSync(row.path.split("#")[0]!) ? "kept" : "gone", "shown", row.cwd ?? "", row.path, (row.title ?? "").replace(/\s+/g, " ").slice(0, 80)].join("\t"))
} else {
  const named = (await readFile(values.archive, "utf8")).split("\n").filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("\t")).map(([, harness = "", nativeId = "", , , , cwd = ""]) => ({ harness, nativeId, cwd }))
  // The sidebar's list, and every session in each proof folder the list names, past the list's cap too.
  const proofs = inProofFolders(await rows())
  for (const cwd of new Set(named.map((target) => target.cwd).filter((cwd) => proofFolder(cwd))))
    for (const [found, row] of inProofFolders(await rows({ cwd }))) proofs.set(found, row)
  let done = 0, before = 0
  const skipped: string[] = []
  for (const target of named) {
    const row = proofs.get(key(target))
    if (!row) skipped.push(`${target.harness} ${target.nativeId}: not listed in a proof folder now`)
    else if (isArchived(row)) before += 1
    else {
      await call("mako:thread-archive", [{ id: `archive-proof-sessions:${row.harness}:${row.nativeId}`, target: { kind: "native", provider: row.harness, nativeId: row.nativeId }, archived: true }])
      archived.add(key(row))
      done += 1
    }
  }
  console.log(`Archived ${done} of the ${named.length} sessions named; ${before} were archived already; ${skipped.length} not listed in a proof folder now, left alone. Each comes back from Archived.`)
  for (const line of skipped.slice(0, 20)) console.log(`  ${line}`)
  if (skipped.length > 20) console.log(`  … and ${skipped.length - 20} more`)
}
