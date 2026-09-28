import type { CheckoutHead, CheckoutHeads } from "../../electron/contracts/checkout-heads.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * What each folder the window shows has checked out. A folder is read once
 * when something first asks for it; after that the host sends its changes,
 * so nothing here polls or runs Git.
 */
interface CheckoutHeadsState {
  /** Absent until read; null for a folder in no checkout. */
  heads: CheckoutHeads
}

export const checkoutHeadsStore = createStore<CheckoutHeadsState>({ heads: {} })
const useCheckoutHeads = createHook(checkoutHeadsStore)

const followed = new Set<string>()
let asking: Set<string> | null = null

async function ask(folders: string[]): Promise<void> {
  try {
    const heads = await getMako().checkoutHeads(folders)
    applyCheckoutHeads(heads)
  } catch {
    // A host that can't read them (a fixture desk) leaves the branches unshown.
  }
}

/** Follow these folders' checkouts; callers in the same task share one host call. */
export function followCheckouts(folders: Iterable<string>): void {
  if (!hasBridge()) return
  for (const folder of folders) {
    if (followed.has(folder)) continue
    followed.add(folder)
    if (asking) asking.add(folder)
    else {
      asking = new Set([folder])
      queueMicrotask(() => {
        const batch = [...(asking ?? [])]
        asking = null
        void ask(batch)
      })
    }
  }
}

/** After the host comes back it follows nothing; ask again for everything shown. */
export function refollowCheckouts(): void {
  if (followed.size && hasBridge()) void ask([...followed])
}

export function applyCheckoutHeads(heads: CheckoutHeads): void {
  const current = checkoutHeadsStore.get().heads
  const changed = Object.entries(heads).filter(([folder, head]) => !sameHead(current[folder], head))
  if (changed.length) checkoutHeadsStore.set({ heads: { ...current, ...Object.fromEntries(changed) } })
}

function sameHead(a: CheckoutHead | null | undefined, b: CheckoutHead | null): boolean {
  return a !== undefined && a?.kind === b?.kind && checkoutLabel(a) === checkoutLabel(b) && a?.linked?.path === b?.linked?.path
}

/** How a head reads in a line of text: the branch, or a short commit. */
export function checkoutLabel(head: CheckoutHead | null | undefined): string | undefined {
  if (!head) return undefined
  return head.kind === "detached" ? head.commit.slice(0, 7) : head.name
}

/** A head for a tip or a label: "main", "Rebasing main", "Detached at 1a2b3c4". */
export function checkoutSentence(head: CheckoutHead): string {
  return head.kind === "branch" ? head.name : head.kind === "rebasing" ? `Rebasing ${head.name}` : `Detached at ${checkoutLabel(head)}`
}

/** One folder's head; subscribing never asks the host, `followCheckouts` does. */
export function useCheckoutHead(folder: string | undefined): CheckoutHead | null | undefined {
  return useCheckoutHeads((state) => (folder ? state.heads[folder] : undefined))
}
