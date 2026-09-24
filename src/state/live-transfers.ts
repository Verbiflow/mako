import { readLiveSnapshot } from "@/state/live-history"
import { toast } from "sonner"
import { getMako } from "@/lib/bridge"
import type { TransferInput } from "@/lib/types"
import { describeTransferRecovery } from "../../electron/contracts/operation-recovery"
import { acpStore } from "./acp-state"
import { applyLiveSnapshot } from "./live-recovery"
import { leaveViewerForLive } from "./thread-viewing"

export async function submitTransfer(id: string, input: TransferInput): Promise<boolean> {
  try {
    const snapshot = await getMako().liveTransfer(id, input)
    applyLiveSnapshot(snapshot, null)
    if (acpStore.get().activeKey === id) leaveViewerForLive(input.provider)
    return true
  } catch (error) {
    const snapshot = await readLiveSnapshot(id).catch(() => null)
    if (snapshot?.control?.transfers.some((transfer) => transfer.input.id === input.id)) {
      applyLiveSnapshot(snapshot)
      return true
    }
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
