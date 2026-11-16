import { createHash } from "node:crypto"
import { contentRef } from "./content.js"
import type { JournalStore } from "./journal-store.js"
import { partition, storedView, type Partition, type PartitionFile } from "./queries.js"

/** The checkpoint input identity: HEAD and the Thread side of every file, in path order. */
export function threadFingerprint(head: string | null | undefined, partition: Partition, repoRoot: string): string {
  const side = (version: PartitionFile["thread"]) => (version.kind === "absent" ? "-" : version.kind === "text" ? `t${contentRef(Buffer.from(version.text, "utf8"))}` : `c${version.ref}`)
  const roots = new Set(partition.roots.filter((root) => root.path === repoRoot).map((root) => root.root))
  const files = partition.files.filter((file) => roots.has(file.root)).map((file) => `${file.path}\0${file.current ?? "-"}\0${side(file.thread)}`).sort()
  return [head ?? "-", ...files].join("\n")
}

/** Compact checkpoint identities on the journal reader, never partition text sent back to the host. */
export class CheckpointFingerprints {
  private version: string | undefined
  private readonly held = new Map<string, string>()

  private readonly store: JournalStore

  constructor(store: JournalStore) { this.store = store }

  read(checkout: string, thread: string): string {
    // Conservative: even another Thread's commit invalidates, since overlaps and attribution can change this side.
    const version = this.store.version()
    if (version !== this.version) {
      this.held.clear()
      this.version = version
    }
    const key = JSON.stringify([checkout, thread])
    const known = this.held.get(key)
    if (known !== undefined) return known
    const found = partition(storedView(this.store), checkout, thread)
    const head = found.roots.find((root) => root.path === checkout)?.head
    const fingerprint = createHash("sha256").update(threadFingerprint(head, found, checkout)).digest("hex")
    if (this.held.size >= 128) this.held.delete(this.held.keys().next().value!)
    this.held.set(key, fingerprint)
    return fingerprint
  }
}
