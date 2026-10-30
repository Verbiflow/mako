import { recoveryGlyph } from "@/components/transcript/recovery-glyph"
import type { ComposerNotice, ComposerNoticeAction } from "@/extend/notices"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { holdUntil } from "@/state/acp-queue"
import { failureKey, revealFailure, useFailureVisibility } from "@/state/failure-visibility"
import { useLimitReset } from "@/state/limit-reset"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { endsOnFailureRow, turnWords } from "@/state/prompt-delivery"
import { requestRecovery } from "@/state/request-recovery"
import { shallowEqual } from "@/state/store"

const NONE: never[] = []

/**
 * One line above the composer for the newest message that ended without an
 * answer, only while its row in the transcript isn't on screen: scrolled
 * away, or in a turn not drawn. Show brings the row into view, where its
 * recovery is; a usage limit with a known reset offers the timed send here
 * too. Dismissing it hides this occurrence and changes nothing about the
 * message.
 */
export function useFailureNotice(): ComposerNotice | null {
  useHarnessIdentity()
  // Read from the requests alone, so a streamed token doesn't run it: the newest message since the last answer
  // whose turn ends on a failure row (`endsOnFailureRow`).
  const live = useAcp((state) => {
    const current = activeLiveAcp(state)
    if (!current) return null
    const requests = current.requests ?? NONE
    const answered = requests.findLastIndex((request) => request.status === "completed")
    const latest = requests.slice(answered + 1).findLast(endsOnFailureRow)
    const waiting = latest !== undefined && requests.some((request) => request.status === "held" && request.wake?.after === latest.id)
    // Which message, by its words: a continuation's are Mako's, so it is named by the turn it continued.
    return { key: current.key, harness: current.harness, latest, waiting, words: latest ? turnWords(requests, latest) : "" }
  }, shallowEqual)
  const latest = live?.latest
  const key = live && latest ? failureKey(live.key, latest.id) : ""
  const visible = useFailureVisibility((state) => state.visible.has(key))
  const dismissed = usePrefs((state) => state.dismissedRecoveryRequests[key])
  const resetAt = useLimitReset(live?.key)
  // A timed send already waiting for this one has said what happens next.
  if (!live || !latest || visible || live.waiting || dismissed === latest.status) return null
  const provider = harnessLabel(live.harness)
  const recovery = requestRecovery(latest, { provider, resetAt })
  const actions: ComposerNoticeAction[] = []
  if (recovery.primary?.kind === "resume-at") {
    const at = recovery.primary.at
    actions.push({ label: recovery.primary.label, primary: true, onClick: () => void holdUntil(live.key, latest.id, at) })
  }
  const glyph = recoveryGlyph(recovery)
  const Glyph = glyph.icon
  // Which message: its words, since an earlier one may say the same thing on screen.
  const words = live.words
  const quoted = words ? `“${words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words}”` : "Your last message"
  actions.push({ label: "Show", title: `Show ${quoted} in the conversation`, onClick: () => revealFailure(key) })
  return {
    id: `failure:${key}`,
    tone: recovery.tone,
    icon: <Glyph className={glyph.className} />,
    title: recovery.title,
    // The reset is on the button; the line names the message.
    description: quoted,
    detail: recovery.guidance || recovery.description ? <p>{[recovery.description && `The limit ${recovery.description}.`, recovery.guidance].filter(Boolean).join(" ")}</p> : undefined,
    actions,
    onDismiss: () => setPref("dismissedRecoveryRequests", { ...prefsStore.get().dismissedRecoveryRequests, [key]: latest.status }),
    dismissLabel: "Dismiss",
    data: { "data-recovery-notice": latest.id },
  }
}
