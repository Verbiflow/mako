import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { appendFile, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import { emptyBroker } from "@mako/protocol/borrow"
import { inSlices } from "@mako/sessions/slices"
import { compactGrants, type BorrowingState } from "./borrowing-state.js"

const Envelope = z.object({ state: z.object({ account: z.string() }).loose() }).loose()
const EndedId = z.object({ account: z.string(), id: z.string() })
async function stamp(file: string) {
  const info = await stat(file, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error })
  return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : "missing"
}

/** Legacy JSON stays authoritative. Every method is called under LocalBorrowing's folder lock. */
export class BorrowingSnapshot {
  private readonly folder: string
  private readonly account: string
  private cached: BorrowingState | undefined
  private stamp: string | undefined
  private ended = new Set<string>()
  private endedInode: string | undefined
  private endedSize = 0

  constructor(folder: string, account: string) { this.folder = folder; this.account = account }
  hasEnded(id: string): boolean { return this.ended.has(id) }

  private async readEnded(): Promise<void> {
    const file = join(this.folder, "ended-grants.jsonl")
    const info = await stat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error })
    const inode = info ? `${info.dev}:${info.ino}` : "missing"
    if (inode !== this.endedInode || (info?.size ?? 0) < this.endedSize) { this.ended.clear(); this.endedSize = 0 }
    let size = info?.size ?? 0
    if (info && size > this.endedSize) {
      const stream = createReadStream(file, { encoding: "utf8", start: this.endedSize, end: info.size - 1 })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      let consumed = this.endedSize
      try {
        for await (const line of lines) {
          const next = consumed + Buffer.byteLength(line) + 1
          // A crashed append cannot have published a compacted snapshot without its final newline.
          if (next > size) { await truncate(file, consumed); size = consumed; break }
          consumed = next
          if (!line) continue
          const saved = EndedId.parse(JSON.parse(line))
          if (saved.account === this.account) this.ended.add(saved.id)
        }
      } finally { lines.close(); stream.destroy() }
    }
    this.endedInode = inode; this.endedSize = size
  }

  async read(): Promise<BorrowingState> {
    await this.readEnded()
    const file = join(this.folder, "state.json"), current = await stamp(file)
    if (this.cached && current === this.stamp) return this.cached
    const text = current === "missing" ? undefined : await readFile(file, "utf8")
    const value: unknown = text ? JSON.parse(text) : { state: emptyBroker(this.account), waiting: [], unanswered: [] }
    Envelope.parse(value)
    // SAFETY: the legacy broker writes this private snapshot whole, by rename, under the same folder lock.
    const saved = value as BorrowingState
    const kept = saved.state.account === this.account ? { ...saved, waiting: saved.waiting ?? [], unanswered: saved.unanswered ?? [] } : { state: emptyBroker(this.account), waiting: [], unanswered: [] }
    const count = Object.keys(kept.state.grants).length
    await this.rememberEnded(kept)
    await inSlices(compactGrants(kept))
    if (Object.keys(kept.state.grants).length !== count) await this.write(kept)
    else { this.cached = kept; this.stamp = current }
    return kept
  }

  private async rememberEnded(kept: BorrowingState): Promise<void> {
    const fresh: string[] = []
    const ids: string[] = []
    const account = this.account, ended = this.ended
    function* collect() {
      for (const [id, held] of Object.entries(kept.state.grants)) {
        if (held.ended && !ended.has(id)) { fresh.push(`${JSON.stringify({ account, id })}\n`); ids.push(id) }
        yield
      }
    }
    await inSlices(collect())
    if (!fresh.length) return
    const file = join(this.folder, "ended-grants.jsonl")
    await appendFile(file, fresh.join(""), { mode: 0o600 })
    for (const id of ids) this.ended.add(id)
    const info = await stat(file)
    this.endedInode = `${info.dev}:${info.ino}`; this.endedSize = info.size
  }

  /** Atomic legacy snapshot before answering; no deferred write escapes the folder lock. */
  async write(kept: BorrowingState): Promise<void> {
    try {
      await this.rememberEnded(kept)
      await inSlices(compactGrants(kept))
      const temporary = join(this.folder, `.state.${process.pid}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(kept), { flag: "wx", mode: 0o600 })
        await rename(temporary, join(this.folder, "state.json"))
      } finally { await rm(temporary, { force: true }) }
      this.cached = kept; this.stamp = await stamp(join(this.folder, "state.json"))
    } catch (error) { this.cached = undefined; this.stamp = undefined; throw error }
  }
}
