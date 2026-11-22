import { createHash } from "node:crypto"
import { contentRef } from "./content.js"
import type { JournalStore } from "./journal-store.js"
import { partition, storedView, type Partition, type PartitionFile } from "./queries.js"
import { kept } from "../base/path-style.js"

/** The checkpoint input identity: HEAD and the Thread side of every file, in path order. */
export function threadFingerprint(head: string | null | undefined, partition: Partition, repoRoot: string): string {
  const side = (version: PartitionFile["thread"]) => (version.kind === "absent" ? "-" : version.kind === "text" ? `t${contentRef(Buffer.from(version.text, "utf8"))}` : `c${version.ref}`)
  const roots = new Set(partition.roots.filter((root) => root.path === repoRoot).map((root) => root.root))
  const files = partition.files.filter((file) => roots.has(file.root)).map((file) => `${file.path}\0${file.current ?? "-"}\0${side(file.thread)}`).sort()
  return [head ?? "-", ...files].join("\n")
}

/** Compact checkpoint identities on the journal reader, never partition text sent back to the host. */
export class CheckpointFingerprints {
  private readonly held = new Map<string, { version: string; fingerprint: string }>()

  private readonly store: JournalStore

  constructor(store: JournalStore) { this.store = store }

  read(checkout: string, thread: string): string {
    // A content or attribution change in this root can affect this side; another checkout and bookkeeping cannot.
    const version = this.store.checkpointVersion(checkout)
    const key = JSON.stringify([checkout, thread])
    const known = this.held.get(key)
    if (known?.version === version) return known.fingerprint
    this.held.delete(key)
    const view = storedView(this.store)
    const roots = [...view.roots()]
    const found = partition({ ...view, roots: () => roots }, checkout, thread)
    // Active base/current blobs are immutable and retained by collection. A missing text body can arrive later
    // without another file write, so don't cache that incomplete input. It is revisited until the body arrives.
    const complete = roots.filter(({ root }) => root.path === kept(checkout)).every(({ files }) => [...files.values()].every(file =>
      !file.text || ((!file.base || this.store.hasBlob(file.base)) && (!file.current || this.store.hasBlob(file.current)))))
    const head = found.roots.find((root) => root.path === kept(checkout))?.head
    const fingerprint = createHash("sha256").update(threadFingerprint(head, found, checkout)).digest("hex")
    if (this.held.size >= 128) this.held.delete(this.held.keys().next().value!)
    if (complete) this.held.set(key, { version, fingerprint })
    return fingerprint
  }
}
