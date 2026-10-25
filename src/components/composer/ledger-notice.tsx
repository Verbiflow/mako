import { useEffect } from "react"
import { ledgerReplyWords } from "@mako/host/contracts/thread-continuation"
import { useUpdateMakoAction } from "@/components/shell/use-update-mako"
import type { ComposerNotice } from "@/extend/notices"
import { harnessLabel } from "@/lib/harness-label"
import { activeAcp, useAcp } from "@/state/acp"
import { loadLedgerPlan, useLedgerPlans, useStoreFormats } from "@/state/store-formats"
import { useThreads } from "@/state/threads"

/**
 * Above the composer, while a newer Mako changed the session ledger and
 * replying here would resume a session: a catalogued one, or a
 * conversation of this host's whose provider isn't running (hibernated or
 * disconnected). The host's plan for its session says what a reply does,
 * in the same words the send follows (`ledgerReply`), with Update. Nothing
 * shows while this build writes the ledger or the conversation is running.
 */
export function useLedgerNotice(): ComposerNotice | null {
  const update = useUpdateMakoAction()
  const newer = useStoreFormats((state) => state.stores.some((row) => row.store === "session-memory" && row.access !== "write"))
  const viewed = useThreads((state) => (state.opening ? null : state.viewing?.ref?.path ?? null))
  const live = useAcp((state) => {
    const active = activeAcp(state)
    if (!active) return null
    return active.kind === "live" && active.session.connection !== "connected" && active.session.connection !== "starting"
      ? active.session.nativePath ?? ""
      : ""
  })
  // A running conversation resumes nothing; a resting one is asked by its session's path.
  const path = live === null ? viewed : live || null
  const plan = useLedgerPlans((state) => (path ? state.plans[path] : undefined))

  useEffect(() => {
    if (path && newer) void loadLedgerPlan(path)
  }, [path, newer])

  if (!path || !newer || !plan) return null
  if (plan.transport !== "handoff" && plan.transport !== "refused" && plan.transport !== "attached") return null
  if (!plan.makoUpdate || !plan.notice) return null
  return {
    id: "newer-ledger",
    tone: "caution",
    title: plan.notice.line,
    description: ledgerReplyWords(plan.notice, harnessLabel(plan.notice.harness)),
    actions: [{ ...update, primary: true }],
    data: { "data-ledger-notice": plan.transport },
  }
}
