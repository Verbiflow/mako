import { limitResetAt } from "@mako/host/contracts/account-usage"
import { harnessLabel } from "@/lib/harness-label"
import { noteOutcome } from "@/state/notifications"
import { useAccounts, usageKey } from "@/state/accounts"
import { acpStore, useAcp } from "@/state/acp"
import { liveSubject } from "@/state/acp-live"
import { shallowEqual } from "@/state/store"

/**
 * When the account a live conversation runs on takes work again, read from
 * the harness's own usage reading: the latest reset among its windows at
 * their limit. Null while nothing is spent or no reading names a reset.
 */
export function useLimitReset(conversationKey: string | undefined): number | null {
  const target = useAcp((state) => {
    const conversation = conversationKey ? state.conversations[conversationKey] : undefined
    if (conversation?.kind !== "live") return null
    const account = conversation.session.executionContext?.account
    return { harness: conversation.harness, name: account?.kind === "configured" ? account.name : undefined }
  }, shallowEqual)
  return useAccounts((state) => {
    if (!target) return null
    const name = target.name ?? state.accounts.find((account) => account.harness === target.harness && account.active)?.name
    return name ? limitResetAt(state.usage[usageKey(target.harness, name)], Date.now()) : null
  })
}

/** Reminders asked for, by conversation and reset, so asking twice sets one. */
const reminders = new Map<string, ReturnType<typeof setTimeout>>()

/** The longest a timer waits in one step; a later reset is waited for in steps. */
const STEP_MS = 2 ** 31 - 1

/**
 * Tell the person when a limit resets, without sending anything: an
 * attention item for the conversation, announced as a finished answer is,
 * since what it says is that the thread can go on. Lives as long as this
 * window does.
 */
export function remindAtReset(conversationKey: string, at: number): void {
  const key = `${conversationKey}:${at}`
  if (reminders.has(key)) return
  const wait = () => {
    const left = at - Date.now()
    if (left > 0) {
      reminders.set(key, setTimeout(wait, Math.min(left, STEP_MS)))
      return
    }
    reminders.delete(key)
    const conversation = acpStore.get().conversations[conversationKey]
    if (conversation?.kind !== "live") return
    noteOutcome({
      kind: "finished",
      subject: liveSubject(conversation),
      marker: `limit-reset:${at}`,
      detail: `${harnessLabel(conversation.harness)}'s usage limit reset. You can send again.`,
    })
  }
  wait()
}

/** Whether a reminder for this reset is set, for the menu's checkmark. */
export function remindsAt(conversationKey: string, at: number): boolean {
  return reminders.has(`${conversationKey}:${at}`)
}
