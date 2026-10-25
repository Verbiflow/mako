import { useMemo } from "react"
import { harnessLabel } from "@/lib/harness-label"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { continueTurn, sendTo } from "@/state/acp-queue"
import { useLimitReset } from "@/state/limit-reset"
import { turnStops } from "@/state/prompt-delivery"
import { composerResume, type ComposerResume } from "@/state/request-recovery"
import { shallowEqual } from "@/state/store"

const NONE: never[] = []

/**
 * What the empty composer's button does when the newest turn can be picked
 * up: "Continue turn" for one Mako's exit or the provider cut short,
 * "Send again" or "Send another copy" for a message a repeat can fix.
 * Null while anything runs, or when there's nothing to pick up.
 */
export function useComposerResume(idle: boolean): { resume: ComposerResume; run(): Promise<boolean> } | null {
  const live = useAcp((state) => {
    const current = activeLiveAcp(state)
    if (!current) return null
    const requests = current.requests ?? NONE
    const newest = requests.findLast((request) => request.status !== "canceled")
    const compacted = Boolean(newest && current.control?.actions?.some((action) =>
      action.input.kind === "compact" && action.input.requestId === newest.id && action.state.kind === "completed"))
    return { key: current.key, harness: current.harness, requests, compacted }
  }, shallowEqual)
  const resetAt = useLimitReset(live?.key)
  return useMemo(() => {
    if (!live || !idle) return null
    const resume = composerResume(live.requests, turnStops(live.requests, false), { provider: harnessLabel(live.harness), compacted: live.compacted, resetAt })
    if (!resume) return null
    return {
      resume,
      run: () => resume.kind === "continue"
        ? continueTurn(live.key, resume.reason)
        : sendTo(live.key, resume.request.text, resume.request.attachments),
    }
  }, [live, idle, resetAt])
}
