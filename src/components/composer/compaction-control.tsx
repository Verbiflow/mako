import {
  compactionAvailable,
  UNAVAILABLE_RECOVERY,
} from "../../../electron/contracts/recovery"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"
import { descriptorFor } from "@/state/descriptors"

/** The same capability and admission rules serve the menu and failed messages. */
export function CompactionControl({
  requestId,
  onStart,
}: {
  requestId?: string
  onStart?: () => void
}) {
  const harness = useAcp((state) => activeLiveAcp(state)?.harness)
  const capability = useThreads(
    (state) =>
      (descriptorFor(state, harness)?.recovery ?? UNAVAILABLE_RECOVERY)
        .compaction
  )
  const enabled = useAcp((state) => {
    const live = activeLiveAcp(state)
    return Boolean(
      live &&
      compactionAvailable(
        live.session,
        live.control?.actions ?? [],
        live.requests?.some(
          (request) =>
            request.status === "queued" || request.status === "dispatching"
        ) ?? false
      )
    )
  })
  if (capability.kind === "unavailable")
    return (
      <p className="px-2 py-2 text-label text-faint">{capability.reason}</p>
    )
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => {
        onStart?.()
        void acp.compact(requestId)
      }}
      className="pressable flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-fill-hover disabled:opacity-40"
    >
      <span className="text-ui">Compact conversation</span>
      <span className="text-label text-faint">
        Summarize history to free context. Your saved message stays here.
      </span>
    </button>
  )
}
