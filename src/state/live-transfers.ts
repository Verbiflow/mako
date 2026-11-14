import { readLiveSnapshot } from "@/state/live-history"
import { toast } from "sonner"
import { getMako } from "@/lib/bridge"
import type { LiveSnapshot, TransferInput } from "@/lib/types"
import { describeTransferRecovery } from "@mako/host/contracts/operation-recovery"
import { acpStore } from "./acp-state"
import { applyLiveSnapshot, readLive } from "./live-recovery"
import { leaveViewerForLive } from "./thread-viewing"

export async function submitTransfer(id: string, input: TransferInput): Promise<boolean> {
  try {
    await readLive(id, () => getMako().liveTransfer(id, input), (snapshot) => applyLiveSnapshot(snapshot, null))
    if (acpStore.get().activeKey === id) leaveViewerForLive(input.provider)
    return true
  } catch (error) {
    const tookIt = (snapshot: LiveSnapshot | null) => Boolean(snapshot?.control?.transfers.some((transfer) => transfer.input.id === input.id))
    const snapshot = await readLive(id, () => readLiveSnapshot(id).catch(() => null), (read) => {
      if (tookIt(read)) applyLiveSnapshot(read)
    })
    if (tookIt(snapshot)) return true
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

const retrying = new Map<string, Promise<boolean>>()

/** An intentional new operation preserves the selected destination and settings. */
export function retryTransfer(id: string, transferId: string): Promise<boolean> {
  const key = `${id}:${transferId}`
  const pending = retrying.get(key)
  if (pending) return pending
  const live = acpStore.get().conversations[id]
  const transfer = live?.kind === "live" ? live.control?.transfers.find((item) => item.input.id === transferId) : undefined
  if (!transfer || !describeTransferRecovery(transfer, transfer.input.provider).retryLabel)
    return Promise.resolve(false)
  const result = submitTransfer(id, { ...transfer.input, id: crypto.randomUUID() })
    .finally(() => retrying.delete(key))
  retrying.set(key, result)
  return result
}
