import { watch, type FSWatcher } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { CheckoutHead, CheckoutHeads, LinkedCheckout } from "../contracts/checkout-heads.js"
import { locateCheckout, type CheckoutLocation } from "../base/checkout-location.js"

/** Checkouts followed at once; the one asked about longest ago is let go first. */
const MAX_CHECKOUTS = 48

interface Checkout {
  gitDir: string
  linked: LinkedCheckout | undefined
  folders: Set<string>
  head: CheckoutHead | null
  watcher: FSWatcher | null
  usedAt: number
  reading: Promise<void> | null
  stale: boolean
  announce: boolean
}

function branchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref.replace(/^refs\//, "")
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, "utf8").then((text) => text.trim(), () => null)
}

/** HEAD as Git leaves it on disk: a symbolic ref, or a commit while detached or mid-rebase. */
async function readHead(gitDir: string): Promise<CheckoutHead | null> {
  const head = await readText(join(gitDir, "HEAD"))
  if (head === null) return null
  if (head.startsWith("ref: ")) return { kind: "branch", name: branchName(head.slice("ref: ".length)) }
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const onto = await readText(join(gitDir, state, "head-name"))
    if (onto?.startsWith("refs/")) return { kind: "rebasing", name: branchName(onto) }
  }
  return /^[0-9a-f]{40,64}$/.test(head) ? { kind: "detached", commit: head } : null
}

function headKey(head: CheckoutHead | null): string {
  return head === null ? "" : head.kind === "detached" ? `detached:${head.commit}` : `${head.kind}:${head.name}`
}

function shown(checkout: Checkout): CheckoutHead | null {
  if (!checkout.head || !checkout.linked) return checkout.head
  return { ...checkout.head, linked: checkout.linked }
}

/**
 * What each project folder's checkout has checked out, kept current without
 * polling or running Git: HEAD is read from disk and watched as a file. A
 * branch switched in any terminal or editor arrives as one event.
 */
export class CheckoutHeadService {
  private readonly checkouts = new Map<string, Checkout>()
  private readonly locations = new Map<string, CheckoutLocation>()
  private readonly changed: (heads: CheckoutHeads) => void
  private closed = false

  constructor(changed: (heads: CheckoutHeads) => void) {
    this.changed = changed
  }

  async read(folders: readonly string[]): Promise<CheckoutHeads> {
    const usedAt = Date.now()
    const entries = await Promise.all(
      folders.map(async (folder): Promise<[string, CheckoutHead | null]> => {
        const location = this.locations.get(folder) ?? (await locateCheckout(folder))
        if (!location || this.closed) return [folder, null]
        this.locations.set(folder, location)
        const checkout = this.follow(location)
        checkout.folders.add(folder)
        checkout.usedAt = usedAt
        await (checkout.reading ?? Promise.resolve())
        return [folder, shown(checkout)]
      })
    )
    this.trim()
    return Object.fromEntries(entries)
  }

  /**
   * What a folder read before has checked out, without reading anything: undefined for a folder not followed (or let
   * go since), or whose first read hasn't finished. The account's list says it beside each project (`ownedSessions`).
   */
  known(folder: string): CheckoutHead | null | undefined {
    const location = this.locations.get(folder)
    const checkout = location && this.checkouts.get(location.gitDir)
    if (!checkout || (checkout.reading && checkout.head === null)) return undefined
    return shown(checkout)
  }

  close(): void {
    this.closed = true
    for (const checkout of this.checkouts.values()) checkout.watcher?.close()
    this.checkouts.clear()
    this.locations.clear()
  }

  private follow({ gitDir, linked }: CheckoutLocation): Checkout {
    const known = this.checkouts.get(gitDir)
    if (known) return known
    const checkout: Checkout = { gitDir, linked, folders: new Set(), head: null, watcher: null, usedAt: 0, reading: null, stale: false, announce: false }
    this.checkouts.set(gitDir, checkout)
    this.watchHead(checkout)
    this.refresh(checkout, false)
    return checkout
  }

  /**
   * Watches HEAD itself, not its directory: the directory hears every index
   * write, and on macOS its stream starts late enough to miss a change made
   * right after. Git replaces HEAD by renaming HEAD.lock over it, which ends
   * a watch on the old file, so each event moves the watch to the new file
   * before HEAD is read again; nothing can change unseen in between.
   */
  private watchHead(checkout: Checkout): void {
    checkout.watcher?.close()
    checkout.watcher = null
    if (this.closed) return
    try {
      const watcher = watch(join(checkout.gitDir, "HEAD"), { persistent: false }, () => {
        if (checkout.watcher !== watcher) return
        this.watchHead(checkout)
        this.refresh(checkout, true)
      })
      watcher.on("error", () => {
        if (checkout.watcher === watcher) this.forget(checkout)
      })
      checkout.watcher = watcher
    } catch {
      // Unwatchable (HEAD vanished, or no watch handles left): it is still
      // read whenever the rail asks.
    }
  }

  /** Reads HEAD again, once more if it moves mid-read; `announce` tells the windows when it changed. */
  private refresh(checkout: Checkout, announce: boolean): void {
    checkout.stale = true
    checkout.announce ||= announce
    checkout.reading ??= (async () => {
      const before = headKey(checkout.head)
      while (checkout.stale) {
        checkout.stale = false
        checkout.head = await readHead(checkout.gitDir)
      }
      checkout.reading = null
      const tell = checkout.announce && headKey(checkout.head) !== before
      checkout.announce = false
      if (this.closed || this.checkouts.get(checkout.gitDir) !== checkout) return
      if (tell) this.changed(Object.fromEntries([...checkout.folders].map((folder) => [folder, shown(checkout)])))
      // A checkout that is gone is found again, or not, on the next read.
      if (checkout.head === null) this.forget(checkout)
    })()
  }

  private forget(checkout: Checkout): void {
    checkout.watcher?.close()
    checkout.watcher = null
    if (this.checkouts.get(checkout.gitDir) === checkout) this.checkouts.delete(checkout.gitDir)
    for (const folder of checkout.folders) if (this.locations.get(folder)?.gitDir === checkout.gitDir) this.locations.delete(folder)
  }

  private trim(): void {
    if (this.checkouts.size <= MAX_CHECKOUTS) return
    const oldest = [...this.checkouts.values()].sort((a, b) => a.usedAt - b.usedAt)
    for (const checkout of oldest.slice(0, this.checkouts.size - MAX_CHECKOUTS)) this.forget(checkout)
  }
}
