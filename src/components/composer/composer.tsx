import { GIT_CONFLICT_CONTEXT } from "@/lib/git-conflict-context"
import { gitConflictAttachment } from "@/state/git-conflicts"
import { PULL_REQUEST_CONTEXT } from "@/lib/pull-request-context"
import { pullRequestAttachment } from "@/state/github"
import { APP_SETUP_CONTEXT } from "@/lib/app-setup-context"
import { appSetupAttachment } from "@/state/project-setup"
import { AttachmentStrip } from "./attachments"
import { useComposerClipboard } from "./composer-clipboard"
import { InterruptedSends } from "./interrupted-sends"
import {
  preserveSendingDraft,
  settleSendingDraft,
  interruptSendingDraft,
} from "@/state/send-recovery"
import { PromptQueue } from "./prompt-queue"
import { promptDelivery } from "@/state/prompt-delivery"
import { savedMessageDraft, type RestoreSavedMessageEvent } from "@/lib/saved-message-draft"
import type { ProposedPlan } from "@mako/sessions/content"
import type { ContextInput } from "@/lib/context-detail"
import { parsePlanContext } from "@/lib/proposed-plan"
import { PlanContextChips } from "@/components/composer/plan-context"
import { PlanDecisionBar } from "@/components/composer/plan-decision"
import { hostConnectionStore, useHostConnection } from "@/state/host-connection"
import { toast } from "sonner"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import {
  attachmentReference,
  removeAttachmentReference,
  restoreAttachmentReferences,
} from "@/lib/attachment-references"
import { recordLabel, writeDraft } from "@/lib/context/draft"
import { Banner } from "@/components/composer/banner"
import { ComposerActionButton } from "@/components/composer/composer-action-button"
import { ComposerRouting } from "@/components/composer/composer-routing"
import { ContextMeter } from "@/components/composer/context-meter"
import type { PlanHandle } from "@/components/composer/plan-toggle"
import { keepPlanning, planTakesFeedback, recordSentPlanBuilds, usePlanDecision } from "@/state/plan-mode"
import { steeringTitle } from "@/components/composer/steering"
import { ROUTING_COMPACT_LEVELS, useCompactRow } from "@/components/composer/use-compact-row"

/** Access to its glyph, then the harness to its glyph; see the routing row. */
import { usePrefs } from "@/state/prefs"
import { takeComposerFocus } from "@/state/session-panes"
import { ComposerAdditions } from "@/components/composer/composer-additions"
import { harnessTitle } from "@/components/composer/harness-title"
import { MentionMenu } from "@/components/composer/mention-menu"
import { ReferenceOverlay } from "@/components/composer/reference-overlay"
import { Chip, IconAction } from "@/components/ui/kit"
import { Slot } from "@/extend/slot"
import {
  useAttachments,
  type Attachment,
  type AttachmentInput,
} from "@/lib/attachments"
import {
  composerActionKind,
  composerEnterAction,
  composerRunningPlaceholder,
  composerTurnRunning,
} from "@/lib/composer-action"
import { textOf } from "@/lib/format"
import { mentionAt, replaceMention, type ActiveMention } from "@/lib/mentions"
import {
  prefetchThreadReferences,
  prepareThreadReferences,
  threadLabelKey,
  threadLabelMap,
} from "@/lib/thread-references"
import {
  chipLabel,
  draftView,
  editDraftView,
  spanInside,
  toDraftOffset,
  toViewOffset,
  type DraftView,
} from "@/lib/draft-view"
import type { PromptAttachment } from "@/lib/types"
import { cn } from "@/lib/utils"
import { acp, acpStore, activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import { noteComposing } from "@/state/prewarm"
import { openSessionDraft, sessionDraftKey, threadGroupsStore, useThreadGroups } from "@/state/thread-groups"
import { startInThread } from "@/state/thread-sessions"
import { useTabDrag } from "@/state/tab-drag"
import { readGoalLine } from "@/state/goals"
import { goalRoute, sendGoalLine } from "@/state/goal-commands"
import { GoalBar } from "@/components/composer/goal-bar"
import { SidePanel } from "@/components/composer/side-panel"
import { ReviewPicker } from "@/components/composer/review-picker"
import { readSideLine, sendSideLine } from "@/state/side-questions"
import { isReviewLine, openReviewPicker, REVIEW_COMMAND } from "@/state/reviews"
import {
  draftText,
  projectDraftKey,
  rememberDraft,
  clearCapturedDraft,
  restoreEmptyDraft,
  appendRecoveredDraft,
  removeDraftPlan,
  replaceDraftPlans,
  retainRejectedDraft,
  takeRejectedDraft,
  useDrafts,
} from "@/state/drafts"
import {
  actions,
  shallowEqual,
  store as sessionStore,
  useSession,
} from "@/state/session"
import { skills } from "@/state/skills"
import { threads, threadsStore, useThreads } from "@/state/threads"
import { useRestorePlans } from "@/state/restore-plan"
import { descriptorFor } from "@/state/descriptors"
import { XIcon, Maximize2Icon, Minimize2Icon } from "lucide-react"

type ComposerTextEvent = CustomEvent<string>
type ComposerDraftEvent = CustomEvent<{
  text: string
  attachments?: Attachment[]
  plans?: ProposedPlan[]
}>

/** Files to attach, and the words that go with them, given the references they were filed under. */
type ComposerAttachEvent = CustomEvent<{
  files: AttachmentInput[]
  text: (references: string) => string
}>

interface RestorableDraft {
  plans?: ProposedPlan[]
  text: string
  attachments: Attachment[]
}

declare global {
  interface WindowEventMap {
    "mako:compose": ComposerDraftEvent
    "mako:insert": ComposerTextEvent
    "mako:attach": ComposerAttachEvent
  }
}

/**
 * Focus the composer on the next frame and place the caret — unless another
 * element has taken focus in the meantime, in which case leave it there.
 * A blind deferred focus once pulled focus back from the + menu the user had
 * opened in that same frame, and a non-modal popover reads that as focus
 * leaving, so it closed before its item could be clicked. Focus that moved
 * to nothing (the body, because the focused element unmounted) still counts
 * as ours to take.
 */
function focusComposerSoon(
  node: RefObject<HTMLTextAreaElement | null>,
  caret: number,
  view: RefObject<DraftView>
): void {
  const before = document.activeElement
  requestAnimationFrame(() => {
    const textarea = node.current
    const now = document.activeElement
    if (!textarea || (now && now !== before && now !== document.body)) return
    textarea.focus()
    const at = toViewOffset(view.current, caret)
    textarea.setSelectionRange(at, at)
  })
}

/** The menu for the reference being typed, never for a conversation the caret sits beside. */
function mentionIn(draft: string, view: DraftView, caret: number): ActiveMention | null {
  if (view.spans.some((span) => span.viewStart < caret && caret <= span.viewEnd)) return null
  return mentionAt(draft, toDraftOffset(view, caret))
}

function toAcpPromptAttachment(item: Attachment): PromptAttachment {
  return {
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    data: item.kind === "image" ? item.data : undefined,
    path: item.stagedPath,
  }
}


export function Composer() {
  const hostConnected = useHostConnection((state) => state.kind === "connected")
  const workspaceCwd = useSession((state) => state.meta?.cwd ?? "")
  const viewingPath = useThreads(
    (state) => state.opening?.ref.path ?? state.viewing?.ref.path
  )
  const opening = useThreads((state) => state.opening)
  const liveDraftKey = useAcp((state) => activeAcp(state)?.draftKey)
  const newSessionKey = useThreadGroups((state) => sessionDraftKey(openSessionDraft(state)))
  const draftKey = liveDraftKey ?? viewingPath ?? newSessionKey ?? projectDraftKey(workspaceCwd)
  const draftReady = Boolean(liveDraftKey || viewingPath || newSessionKey || workspaceCwd)
  const status = useSession(
    useCallback(
      (state) => ({
        streaming: state.meta?.isStreaming ?? false,
        compacting: state.meta?.isCompacting ?? false,
        retrying: state.meta?.isRetrying ?? false,
        queued:
          (state.meta?.queued.steering.length ?? 0) +
          (state.meta?.queued.followUp.length ?? 0),
      }),
      []
    ),
    shallowEqual
  )
  const meta = useSession((state) => state.meta)
  const cwd = meta?.cwd

  const savedDraft = useDrafts((state) =>
    state.drafts.find((entry) => entry.key === draftKey)
  )
  const attachments = useAttachments(draftKey)
  const restoredMessages = useRef(new Set<string>())
  const { reattach, paste: pasteAttachments } = attachments
  const storedDraft = savedDraft?.text ?? ""
  const draft = restoreAttachmentReferences(storedDraft, attachments.items)
  // What the textarea holds: the draft with each conversation token shown as
  // its label (`draftView`). Everything else here works on the draft; offsets
  // cross between the two only at the textarea.
  const labelKey = useThreads((state) => threadLabelKey(draft, state.threads, state.loaded))
  const labels = useMemo(() => {
    const all = new Map(threadLabelMap(labelKey))
    for (const record of attachments.items) all.set(attachmentReference(record), chipLabel(recordLabel(record)))
    return all
  }, [labelKey, attachments.items])
  const view = useMemo(() => draftView(draft, labels), [draft, labels])
  const viewRef = useRef(view)
  /** A caret for the textarea once its new text is in, when that text isn't what was typed. */
  const pendingCaret = useRef<number | null>(null)
  /** The last selection, in the draft, kept across a label arriving under it. */
  const keptSelection = useRef<{ draft: string; start: number; end: number } | null>(null)
  const lastCaret = useRef<number | null>(null)
  const draftPlans = savedDraft?.plans
  const [mention, setMention] = useState<ActiveMention | null>(null)
  // The menu can be open with nothing to show (`$5`); then the textarea keeps
  // its keys, so Enter still sends.
  const [menuVisible, setMenuVisible] = useState(false)
  const [dragging, setDragging] = useState(false)
  // A conversation dragged from the sidebar is over the composer (`tab-drag.ts`).
  const referencing = useTabDrag((state) => state.zone !== null && "composer" in state.zone)
  const [expanded, setExpanded] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const routingRow = useRef<HTMLDivElement>(null)
  useCompactRow(routingRow, ROUTING_COMPACT_LEVELS)
  const filePicker = useRef<HTMLInputElement>(null)
  const activeAttachmentDraft = useRef(draftKey)
  const preparingSends = useRef(new Set<string>())
  useLayoutEffect(() => {
    activeAttachmentDraft.current = draftKey
  }, [draftKey])
  const rejectedDrafts = useDrafts((state) =>
    state.rejected.filter((item) => item.key === draftKey)
  )

  /**
   * Up-arrow prompt recall, the way every terminal taught your hands: with
   * the caret at the very start, ↑ steps back through what you asked in
   * this conversation — the open thread's turns, or the native session's —
   * and ↓ walks forward until your unfinished draft comes back. Typing
   * anything ends the walk.
   */
  const promptHistory = useRef<{
    list: string[]
    at: number
    stash: string
  } | null>(null)
  const collectPromptHistory = useCallback((): string[] => {
    const viewing = threadsStore.get().viewing
    if (viewing) {
      return viewing.entries
        .filter(
          (entry): entry is Extract<typeof entry, { type: "user" }> =>
            entry.type === "user"
        )
        .map((entry) => entry.text.trim())
        .filter(Boolean)
    }
    return sessionStore
      .get()
      .messages.filter((message) => message.role === "user")
      .map((message) => textOf(message.blocks).trim())
      .filter(Boolean)
  }, [])

  /** Insert the markers the attachments produced at the caret. */
  const attach = useCallback(
    async (files: AttachmentInput[]) => {
      if (files.length === 0) return
      const markers = attachments.add(files)
      if (markers && activeAttachmentDraft.current !== draftKey) {
        toast.info("Attachments were saved to the original task’s draft.")
        return
      }
      if (markers)
        window.dispatchEvent(
          new CustomEvent("mako:insert", { detail: `${markers} ` })
        )
    },
    [attachments, draftKey]
  )

  /** Drop an attachment and the marker that stands for it, from either surface. */
  const removeAttachment = (id: string) => {
    update(removeAttachmentReference(draft, attachments.items, id))
    attachments.remove(id)
    textarea.current?.focus()
  }

  // Swap in the draft belonging to whichever session just became active.
  const [lastDraftKey, setLastDraftKey] = useState(draftKey)
  if (lastDraftKey !== draftKey) {
    setLastDraftKey(draftKey)
    setMention(null)
  }

  const update = useCallback(
    (value: string) => {
      rememberDraft(draftKey, value)
      noteComposing(value)
    },
    [draftKey]
  )
  const draftRef = useRef(draft)
  const updateRef = useRef(update)
  useEffect(() => {
    draftRef.current = draft
    updateRef.current = update
  }, [draft, update])
  /** The selection the next edit replaces, read before it lands, with the text it was read in. */
  const replacing = useRef<{ start: number; end: number; text: string } | null>(null)
  const noteReplacing = useCallback((node: HTMLTextAreaElement) => {
    replacing.current = { start: node.selectionStart, end: node.selectionEnd, text: node.value }
  }, [])
  useEffect(() => {
    const node = textarea.current
    if (!node) return
    const before = () => noteReplacing(node)
    node.addEventListener("beforeinput", before)
    return () => node.removeEventListener("beforeinput", before)
  }, [noteReplacing])
  const clipboard = useComposerClipboard(
    attachments,
    () => ({ draft: draftRef.current, view: viewRef.current }),
    noteReplacing
  )
  // The attachment tiles are memoised; one callback for their lifetime keeps a
  // keystroke from rendering every tile again.
  const removeAttachmentRef = useRef(removeAttachment)
  useEffect(() => {
    removeAttachmentRef.current = removeAttachment
  })
  const removeAttachmentTile = useCallback((id: string) => removeAttachmentRef.current(id), [])
  // Files show as tiles above the words too; a comment, quote or pull request
  // is its chip alone.
  const stripItems = useMemo(
    () => attachments.items.filter((item) => !item.detail || item.stagedPath || item.pending),
    [attachments.items]
  )
  // A press on a chat pane's resting composer moved this composer there.
  useEffect(() => {
    if (!takeComposerFocus()) return
    const node = textarea.current
    node?.focus({ preventScroll: true })
    node?.setSelectionRange(node.value.length, node.value.length)
  }, [])

  /** Re-read the token under the caret after any caret move. */
  const syncMention = useCallback(() => {
    const node = textarea.current
    if (!node) return
    setMention(mentionIn(draftRef.current, viewRef.current, node.selectionStart ?? 0))
  }, [])

  useLayoutEffect(() => {
    const before = viewRef.current
    viewRef.current = view
    const node = textarea.current
    if (!node) return
    const pending = pendingCaret.current
    pendingCaret.current = null
    if (pending !== null) {
      node.setSelectionRange(pending, pending)
      return
    }
    // A label came in, or went, under an unchanged draft: the textarea's new
    // text put the caret at its end, so put back where it was.
    const kept = keptSelection.current
    if (before.text === view.text || !kept || kept.draft !== draft || document.activeElement !== node) return
    node.setSelectionRange(toViewOffset(view, kept.start, true), toViewOffset(view, kept.end))
  }, [view, draft])

  /*
   * Autogrow, measured in a layout effect so the row never flashes at the
   * wrong height between the keystroke and the paint.
   *
   * The textarea itself never scrolls — it is always exactly as tall as its
   * content, and the wrapper around it is what clips and scrolls. That is not
   * a style choice: the chips are painted on a layer *behind* a transparent
   * textarea, and if the textarea scrolled on its own the painted glyphs would
   * stay put while the real ones moved. Pasting anything over ~15 lines used to
   * tear the two layers apart completely. Both layers now live inside one
   * scroller, so they cannot drift by construction.
   */
  useLayoutEffect(() => {
    const node = textarea.current
    if (!node) return
    if (!CSS.supports("field-sizing", "content")) {
      node.style.height = "0px"
      node.style.height = `${node.scrollHeight}px`
    }

    // Keep the caret in view. After typing or pasting at the end — which is
    // nearly always — that means the bottom. Anywhere else and the browser has
    // already scrolled the wrapper to reveal it.
    const box = scroller.current
    if (box && (node.selectionStart ?? 0) >= node.value.length) {
      box.scrollTop = box.scrollHeight
    }
  }, [draft])

  useEffect(() => {
    const focus = () => textarea.current?.focus()
    const setText = (event: ComposerDraftEvent) => {
      const { detail } = event
      // Text from an older build may still carry its plans inline.
      const parsed = parsePlanContext(detail.text)
      const body = parsed.body
      const plans = detail.plans ?? parsed.plans
      if (detail.attachments) reattach(detail.attachments)
      updateRef.current(body)
      replaceDraftPlans(activeAttachmentDraft.current, plans)
      // The menu follows the token under the caret, whoever moved it. Text
      // set from outside never passes through the textarea's own key and
      // click handlers, so a menu opened for the old text stayed open over
      // the new one until the next keystroke.
      setMention(mentionAt(body, body.length))
      focusComposerSoon(textarea, body.length, viewRef)
    }
    const insert = (event: ComposerTextEvent) => {
      const { detail } = event
      const node = textarea.current
      const current = draftRef.current
      const at = node ? toDraftOffset(viewRef.current, node.selectionStart ?? 0) : current.length
      const caret = at + detail.length
      const next = `${current.slice(0, at)}${detail}${current.slice(at)}`
      updateRef.current(next)
      setMention(mentionAt(next, caret))
      focusComposerSoon(textarea, caret, viewRef)
    }
    const restoreSaved = (event: RestoreSavedMessageEvent) => {
      const live = activeLiveAcp(acpStore.get())
      if (live?.key !== event.detail.conversationId || live.draftKey !== activeAttachmentDraft.current) return
      const request = live.requests?.find((entry) => entry.id === event.detail.requestId)
      if (!request || !["failed", "uncertain", "interrupted"].includes(request.status)) return
      const receipt = `${live.key}:${request.id}`
      // A handled event acknowledges draft preparation, never native delivery.
      event.preventDefault()
      if (restoredMessages.current.has(receipt)) return
      const saved = savedMessageDraft(request)
      const body = saved.text
      const plans = saved.plans
      const restored = pasteAttachments(body, saved.attachments)
      const text = [draftRef.current, restored].filter(Boolean).join("\n\n")
      appendRecoveredDraft(live.draftKey, { id: request.id, key: live.draftKey, text: restored, attachments: [], plans })
      updateRef.current(text)
      setMention(null)
      restoredMessages.current.add(receipt)
      const oldest = restoredMessages.current.values().next().value
      if (restoredMessages.current.size > 128 && oldest !== undefined)
        restoredMessages.current.delete(oldest)
      focusComposerSoon(textarea, text.length, viewRef)
    }
    window.addEventListener("mako:focus-composer", focus)
    window.addEventListener("mako:compose", setText)
    window.addEventListener("mako:insert", insert)
    window.addEventListener("mako:restore-saved-message", restoreSaved)
    return () => {
      window.removeEventListener("mako:focus-composer", focus)
      window.removeEventListener("mako:compose", setText)
      window.removeEventListener("mako:insert", insert)
      window.removeEventListener("mako:restore-saved-message", restoreSaved)
    }
  }, [reattach, pasteAttachments])

  // Something on screen asked for a chip (`addContext`): a comment on lines,
  // a picked element, a quote, a pull request. It goes where the person
  // was typing, or at the end, with a space either side.
  const addRecord = attachments.addRecord
  useEffect(() => {
    const add = (event: WindowEventMap["mako:add-context"]) => {
      const anchor = addRecord(event.detail)
      if (!anchor) return
      const current = draftRef.current
      const kept = keptSelection.current
      const at = kept && kept.draft === current ? kept.end : current.length
      const before = current.slice(0, at)
      const after = current.slice(at)
      const inserted = `${before && !/\s$/.test(before) ? " " : ""}${anchor}${event.detail.text ? ` ${event.detail.text}` : ""}${/^\s/.test(after) ? "" : " "}`
      const next = before + inserted + after
      updateRef.current(next)
      // Several chips can arrive in one moment (a pick of three elements):
      // each goes after the last, so the draft and caret move with them now,
      // not a render later.
      draftRef.current = next
      keptSelection.current = { draft: next, start: at + inserted.length, end: at + inserted.length }
      setMention(null)
      focusComposerSoon(textarea, at + inserted.length, viewRef)
      // Sent once the draft holding the chip has rendered; staging is waited
      // out by the send itself.
      if (event.detail.send)
        requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event("mako:composer-send"))))
    }
    window.addEventListener("mako:add-context", add)
    return () => window.removeEventListener("mako:add-context", add)
  }, [addRecord])

  const addAttachments = attachments.add
  useEffect(() => {
    const attach = (event: ComposerAttachEvent) => {
      const references = event.detail.files.length ? addAttachments(event.detail.files) : ""
      if (event.detail.files.length && !references) return
      // Taken: a sender that must know it landed (an Appshot from another app) dispatches it cancelable.
      event.preventDefault()
      const body = event.detail.text(references)
      const current = draftRef.current.trimEnd()
      const next = current ? `${current}\n\n${body}` : body
      updateRef.current(next)
      setMention(null)
      focusComposerSoon(textarea, next.length, viewRef)
    }
    window.addEventListener("mako:attach", attach)
    return () => window.removeEventListener("mako:attach", attach)
  }, [addAttachments])

  const submitDraft = useCallback(
    /** `deliver` takes the message instead of the routing below; false keeps the draft. */
    async (mode?: "steer" | "followUp", deliver?: (message: string) => Promise<boolean>) => {
      if (hostConnectionStore.get().kind === "disconnected") {
        toast.error(
          "Reconnect the Mako host before sending. Your draft is saved."
        )
        return
      }
      if (threadsStore.get().opening) {
        toast.error(
          "Wait for this conversation to load before sending. Your draft is saved."
        )
        return
      }
      const submittedDraftKey = draftKey
      const text = draft.trim()
      if (!text && attachments.items.length === 0) return

      const goalLine = deliver ? null : readGoalLine(text)
      if (goalLine) {
        if (attachments.items.length > 0) {
          toast.error("A goal is words only. Remove the attachments to set it, or send them as a message.")
          return
        }
        if (await sendGoalLine(goalLine, goalRoute(cwd))) {
          clearCapturedDraft(submittedDraftKey, storedDraft, draftPlans)
          draftRef.current = draftText(submittedDraftKey)
          setMention(null)
        }
        return
      }

      if (!deliver && isReviewLine(text)) {
        if (attachments.items.length > 0) {
          toast.error("A review reads the changes in this checkout. Remove the attachments to start it, or send them as a message.")
          return
        }
        clearCapturedDraft(submittedDraftKey, storedDraft, draftPlans)
        draftRef.current = draftText(submittedDraftKey)
        setMention(null)
        openReviewPicker()
        return
      }

      const sideLine = deliver ? null : readSideLine(text)
      if (sideLine) {
        if (attachments.items.length > 0) {
          toast.error("A side question is words only. Remove the attachments to ask it, or send them as a message.")
          return
        }
        if (await sendSideLine(sideLine, (question, key) => acp.sideQuestion({ kind: "ask", question }, key))) {
          clearCapturedDraft(submittedDraftKey, storedDraft, draftPlans)
          draftRef.current = draftText(submittedDraftKey)
          setMention(null)
        }
        return
      }

      // One composer, routed. A live agent gets the message directly; an
      // open conversation resumes through the provider that owns it; a new
      // conversation starts through that provider's richest live protocol.
      // Attachments ride as staged file paths so every local CLI reads the
      // same bytes without base64 crossing IPC.
      const activeConversation = activeAcp(acpStore.get())
      const live = activeLiveAcp(acpStore.get())
      const liveSession = live?.session
      const liveThreadPath = activeConversation?.threadPath
      const viewingRef = threadsStore.get().viewing?.ref
      const viewingOwnsComposer = Boolean(
        viewingRef && viewingRef.path !== liveThreadPath
      )
      const harness = threadsStore.get().composerHarness
      const sessionDraft = openSessionDraft(threadGroupsStore.get())
      // Wait out staging — a screenshot mid-copy must not race the send
      // and leave a dead [Attachment N] marker with no file behind it —
      // then put even inline-shaped images on disk, since a CLI reads
      // files, not base64.
      const settledItems = attachments.items.some((item) => item.pending)
        ? await attachments.settled()
        : attachments.items
      // A file needs its staged copy; a comment, quote or pull request is its detail.
      if (
        settledItems.some(
          (item) => item.pending || item.error || (!item.stagedPath && !item.detail)
        )
      ) {
        toast.error(
          "Your attachments are not ready. Wait for staging or remove the failed attachment."
        )
        return
      }
      const staged = settledItems
      // Skills: the provider that answers decides what each `/skill` needs,
      // and a body already carried into this conversation is pointed at, not
      // repeated. "This conversation" follows the routing below exactly: a
      // reply on the same harness continues one, and a handoff, a move to
      // another harness or a fresh start begins one that has been handed
      // nothing.
      const continuesViewing =
        viewingRef && (!liveSession || viewingOwnsComposer)
      const skillKey = continuesViewing
        ? harness === viewingRef.harness &&
          !viewingRef.copyOnly &&
          !viewingRef.resumeUnavailable
          ? viewingRef.path
          : null
        : activeConversation && harness === activeConversation.harness
          ? activeConversation.key
          : null
      const liveCommands = new Set(
        liveSession?.commands?.map((command) => command.name)
      )
      const [conversations, resolvedSkills] = await Promise.all([
        prepareThreadReferences(text, threadsStore.get().threads),
        skills.resolve(text, harness, skillKey, liveCommands),
      ])
      if (resolvedSkills.failed !== undefined) {
        toast.error(
          `The skills in this message could not be resolved: ${resolvedSkills.failed.replace(/\.?$/, ".")} Your draft is saved.`
        )
        return
      }
      // One message: the words with a marker per chip, and one block saying
      // what each is (`src/lib/context/`).
      const written = writeDraft({
        draft: text,
        records: staged,
        conversations,
        plans: draftPlans,
        skills: resolvedSkills.items,
      })
      const full = written.text
      if (!full.trim()) return
      const acpAttachments = written.files.map(toAcpPromptAttachment)
      const recoveryId = preserveSendingDraft({
        key: submittedDraftKey,
        text: draft,
        plans: draftPlans,
        attachments: staged,
      })
      if (!recoveryId) return
      const restorableDraft: RestorableDraft = {
        text: draft,
        plans: draftPlans,
        attachments: attachments.detach(),
      }
      clearCapturedDraft(submittedDraftKey, storedDraft, draftPlans)
      draftRef.current = draftText(submittedDraftKey)
      setMention(null)
      let ok: boolean
      try {
        if (deliver) {
          ok = await deliver(full)
        } else if (continuesViewing) {
          // A session its harness deleted resumes natively when Mako keeps
          // its records: the host restores them first. Only Mako's copy has
          // nothing to resume, and goes on from its transcript.
          ok =
            harness === viewingRef.harness &&
            !viewingRef.copyOnly &&
            !viewingRef.resumeUnavailable
              ? await threads.reply(viewingRef, full, acpAttachments)
              : await threads.moveAndSend(
                  viewingRef,
                  harness,
                  full,
                  acpAttachments
                )
        } else if (activeConversation) {
          if (harness !== activeConversation.harness) {
            if (liveSession)
              ok = await acp.handoff(harness, full, acpAttachments)
            else {
              acp.deactivate()
              ok = await acp.startFresh(
                harness,
                cwd ?? activeConversation.cwd,
                full,
                acpAttachments
              )
            }
          } else {
            if (
              mode === "steer" &&
              liveSession?.status === "running" &&
              acp.canSteer()
            ) {
              ok = await acp.steer(full, acpAttachments)
            } else {
              ok = await acp.send(full, acpAttachments)
            }
          }
        } else if (sessionDraft) {
          ok = await startInThread(sessionDraft, harness, { prompt: full, attachments: acpAttachments })
        } else if (descriptorFor(threadsStore.get(), harness)?.live) {
          ok = await acp.startThread(harness, cwd ?? "", full, acpAttachments)
        } else {
          ok = await threads.startNew(harness, full)
        }
      } catch (error) {
        interruptSendingDraft(recoveryId)
        toast.error(error instanceof Error ? error.message : String(error))
        return
      }
      if (ok) {
        attachments.discard(restorableDraft.attachments)
        skills.rememberHanded(skillKey, resolvedSkills.handed)
        recordSentPlanBuilds(text, draftPlans, continuesViewing
          ? { thread: viewingRef.path }
          : { conversation: activeAcp(acpStore.get())?.key })
      } else {
        const currentDraftKey =
          activeAcp(acpStore.get())?.draftKey ??
          threadsStore.get().opening?.ref.path ??
          threadsStore.get().viewing?.ref.path ??
          sessionDraftKey(openSessionDraft(threadGroupsStore.get())) ??
          projectDraftKey(sessionStore.get().meta?.cwd ?? "")
        // This callback still owns the submitted attachment bucket, even after navigation.
        const restored = restoreEmptyDraft(
          submittedDraftKey,
          restorableDraft.text,
          restorableDraft.plans
        )
        if (restored) {
          attachments.reattach(restorableDraft.attachments)
        } else {
          retainRejectedDraft(
            submittedDraftKey,
            restorableDraft.text,
            restorableDraft.attachments,
            restorableDraft.plans
          )
        }
        if (currentDraftKey === submittedDraftKey && restored) {
          draftRef.current = restorableDraft.text
        } else {
          toast.error(
            "The message was not sent. Your original draft is saved in its conversation."
          )
        }
      }
      settleSendingDraft(recoveryId)
      return
    },
    [attachments, draft, storedDraft, draftKey, draftPlans, cwd]
  )

  const planDecision = usePlanDecision()
  const submit = useCallback(async (mode?: "steer" | "followUp") => {
    if (preparingSends.current.has(draftKey)) return
    preparingSends.current.add(draftKey)
    try {
      // A reply to a plan the harness is waiting on asks for changes. A
      // harness that takes words with its refusal gets them there, the way
      // its own terminal sends them; otherwise the plan is turned down first,
      // so the reply isn't queued behind its approval.
      if (planDecision?.approval && draft.trim() && attachments.items.length === 0 && planTakesFeedback(planDecision.approval)) {
        await submitDraft(mode, (message) => keepPlanning(planDecision, message))
        return
      }
      if (planDecision?.approval && (draft.trim() || attachments.items.length > 0)) await keepPlanning(planDecision)
      await submitDraft(mode)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      preparingSends.current.delete(draftKey)
    }
  }, [draftKey, submitDraft, planDecision, draft, attachments.items.length])
  // A chip that asked to be sent (`ContextInput.send`) sends the draft it joined.
  useEffect(() => {
    const send = () => void submit()
    window.addEventListener("mako:composer-send", send)
    return () => window.removeEventListener("mako:composer-send", send)
  }, [submit])

  const pick = useCallback(
    (value: string, context?: ContextInput) => {
      if (!mention) return
      // A row that names a record (a pull request from `#`) becomes its chip.
      if (context) {
        const anchor = attachments.addRecord(context)
        const next = replaceMention(draft, mention, anchor)
        update(next.text)
        setMention(null)
        focusComposerSoon(textarea, next.caret, viewRef)
        return
      }
      if (value === REVIEW_COMMAND) {
        const left = replaceMention(draft, mention, "").text
        update(left.trim() ? left : "")
        setMention(null)
        openReviewPicker()
        return
      }
      let replacement = value
      if (value === GIT_CONFLICT_CONTEXT) {
        const file = gitConflictAttachment()
        if (!file) { toast.info("No conflicts remain in the selected repository."); return }
        replacement = attachments.add([file])
        if (!replacement) return
      }
      if (value === PULL_REQUEST_CONTEXT) {
        const file = pullRequestAttachment()
        if (!file) { toast.info("This branch has no pull request on GitHub."); return }
        replacement = attachments.add([file])
        if (!replacement) return
      }
      if (value === APP_SETUP_CONTEXT) {
        const file = appSetupAttachment()
        if (!file) { toast.info("The app is being set up already."); return }
        replacement = attachments.add([file])
        if (!replacement) return
      }      const next = replaceMention(draft, mention, replacement)
      update(next.text)
      if (value.startsWith("@thread:")) {
        prefetchThreadReferences(value, threadsStore.get().threads)
      }
      setMention(null)
      focusComposerSoon(textarea, next.caret, viewRef)
    },
    [attachments, draft, mention, update]
  )

  const stopCurrentTurn = useCallback(() => actions.stopCurrentTurn(), [])
  const plan = useRef<PlanHandle>(null)
  const [planning, setPlanning] = useState(false)

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    // The mention menu owns navigation keys while it is showing rows.
    if (
      mention &&
      menuVisible &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
    )
      return
    const node = textarea.current
    if (node && (event.key === "Backspace" || event.key === "Delete")) {
      const start = node.selectionStart
      const end = node.selectionEnd
      const units = view.spans.map((span) => ({ start: span.viewStart, end: span.viewEnd }))
      const touched = units.filter(
        (range) =>
          start !== end
            ? range.start < end && range.end > start
            : event.key === "Backspace"
              ? range.start < start && range.end >= start
              : range.start <= start && range.end > start
      )
      if (touched.length)
        node.setSelectionRange(
          Math.min(start, ...touched.map((range) => range.start)),
          Math.max(end, ...touched.map((range) => range.end))
        )
    }
    if (
      event.key === "ArrowUp" &&
      node &&
      node.selectionStart === 0 &&
      node.selectionEnd === 0
    ) {
      if (!promptHistory.current) {
        const list = collectPromptHistory()
        if (list.length > 0)
          promptHistory.current = { list, at: list.length, stash: draft }
      }
      const history = promptHistory.current
      if (history && history.at > 0) {
        event.preventDefault()
        history.at -= 1
        const recalled = history.list[history.at]!
        update(recalled)
        requestAnimationFrame(() => node.setSelectionRange(0, 0))
        return
      }
    }
    if (event.key === "ArrowDown" && promptHistory.current) {
      const history = promptHistory.current
      event.preventDefault()
      history.at += 1
      if (history.at >= history.list.length) {
        update(history.stash)
        promptHistory.current = null
      } else {
        update(history.list[history.at]!)
      }
      return
    }
    if (
      event.key === "Tab" &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      plan.current?.toggle()
    ) {
      event.preventDefault()
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      promptHistory.current = null
      event.preventDefault()
      const modified = event.metaKey || event.ctrlKey
      void submit(modified !== steerOnEnter ? "steer" : undefined)
    }
    if (event.key === "Escape" && turnRunning) {
      event.preventDefault()
      void stopCurrentTurn()
    }
  }

  const busy = status.streaming || status.compacting
  const liveHarness = useAcp((state) => activeAcp(state)?.harness ?? null)
  // Another device's conversation read from its copy while that device is off: where it waits to be sent.
  const copyOn = useAcp((state) => {
    const active = activeAcp(state)
    return active?.kind === "live" && active.copy ? (active.elsewhere ?? "its computer") : null
  })
  const steeringKind = useThreads((state) => {
    const steering = descriptorFor(state, liveHarness)?.capabilities.steering
    return steering?.state === "implemented" ? steering.lands : null
  })
  const supportsSteering = steeringKind !== null
  const steerOnEnter = usePrefs((state) => state.steerOnEnter)
  const steerTitle = steeringTitle(steeringKind)
  const liveRunning = useAcp((state) => {
    const active = activeAcp(state)
    return (
      active?.kind === "starting" ||
      Boolean(
        active &&
        (active.session.status === "running" ||
          active.requests?.some(
            (request) => request.status === "dispatching"
          ) ||
          promptDelivery(active).starting)
      )
    )
  })
  const liveStarting = useAcp((state) => {
    const active = activeAcp(state)
    return (
      active?.kind === "starting" ||
      Boolean(
        active &&
        active.session.status !== "running" &&
        (active.session.status === "starting" ||
          active.requests?.some(
            (request) => request.status === "dispatching"
          ) ||
          promptDelivery(active).starting)
      )
    )
  })
  const liveWorking = useAcp(
    (state) => activeLiveAcp(state)?.session.status === "running"
  )
  const canSteer = supportsSteering && liveWorking
  const stopping = useAcp((state) => activeLiveAcp(state)?.canceling ?? false)
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const routedHarness = useThreads(
    (state) => state.opening?.ref.harness ?? state.viewing?.ref.harness ?? null
  )
  const routedPath = useThreads((state) => state.viewing?.ref.path)
  const liveOwnsComposer = Boolean(
    liveHarness && (!routedPath || routedPath === liveThreadPath)
  )
  const viewingRunning = useThreads((state) => state.run?.status === "running")
  const turnRunning = composerTurnRunning({
    builtinRunning: status.streaming,
    livePresent: Boolean(liveHarness),
    liveRunning,
    liveThreadPath,
    viewingPath: routedPath,
    viewingRunning,
  })
  const hasContent = Boolean(draft.trim()) || attachments.items.length > 0
  const enterAction = composerEnterAction({
    canSteer: liveOwnsComposer && canSteer,
    steerOnEnter,
  })
  const primaryAction = composerActionKind({
    running: turnRunning && hostConnected && !opening,
    hasContent,
    steer: enterAction === "steer",
  })
  const viewingResumeUnavailable = useThreads(
    (state) => state.viewing?.ref.resumeUnavailable
  )
  const viewingKept = useThreads((state) =>
    state.viewing?.ref.archived ? (state.viewing.ref.copyOnly ? "copy" : "records") : null
  )
  // A session whose records a newer version of its harness wrote goes on from its transcript until the harness is updated (`RestorePlan`).
  const viewingOutdated = useRestorePlans((state) => viewingPath !== undefined && state.plans[viewingPath]?.kind === "update")
  const newHarness = useThreads((state) => state.composerHarness)
  const placeholder = planDecision && !opening
    ? `Tell ${harnessTitle(planDecision.harness ?? newHarness)} what to change in the plan`
    : planning && !opening && !turnRunning
    ? `Describe what to plan — ${harnessTitle(newHarness)} proposes a plan before changing anything`
    : opening
    ? opening.kind !== "loading"
      ? `Draft a reply for ${harnessTitle(newHarness)} — conversation could not load`
      : newHarness === opening.ref.harness
        ? `Draft a reply for ${harnessTitle(newHarness)} — loading conversation…`
        : `Draft a reply — moves this conversation to ${harnessTitle(newHarness)} once it loads`
    : liveOwnsComposer && liveHarness
      ? copyOn
        ? `Message — waits for ${copyOn} to come back`
        : liveStarting
        ? `Queue a message for ${harnessTitle(liveHarness)}`
        : liveRunning
          ? composerRunningPlaceholder(harnessTitle(liveHarness), enterAction, canSteer)
          : newHarness !== liveHarness
            ? `Reply — moves this conversation to ${harnessTitle(newHarness)}`
            : `Reply — ${harnessTitle(liveHarness)} answers live`
      : routedHarness
        ? newHarness !== routedHarness
          ? `Reply — moves this conversation to ${harnessTitle(newHarness)}`
          : viewingResumeUnavailable
            ? `Reply — continues in a new ${harnessTitle(routedHarness)} session`
            : viewingKept === "copy"
              ? `Reply — continues from this transcript in a new ${harnessTitle(routedHarness)} session`
              : viewingKept === "records" && viewingOutdated
              ? `Reply — continues from its transcript in a new ${harnessTitle(routedHarness)} session`
              : viewingKept === "records"
              ? `Reply — Mako restores this session and ${harnessTitle(routedHarness)} resumes it`
              : viewingRunning
                ? `Queue a message for ${harnessTitle(routedHarness)}`
                : `Reply — ${harnessTitle(routedHarness)} answers`
        : newSessionKey
          ? `Start a ${harnessTitle(newHarness)} session in this Thread`
          : `Ask ${harnessTitle(newHarness)} for a change`

  // The composer is a structural pane, not a floating card: it tiles the full
  // width of the conversation under one hairline, like every other pane, so
  // the queue, permissions and the input share one edge and the control row
  // has the room it needs.
  return (
    <div data-composer inert={!draftReady} aria-busy={!draftReady} className={cn("flex min-h-0 shrink-0 flex-col border-t border-hairline bg-surface", expanded ? "max-h-[80dvh]" : "max-h-[55dvh]")}>
      <div className="flex min-h-0 w-full flex-col">
        <Slot name="composer.above" meta={meta} />
        <GoalBar />
        <SidePanel />
        <ReviewPicker cwd={cwd} />
        <PromptQueue />

        {status.compacting ? (
          <Banner text="Compacting the conversation…" />
        ) : null}
        {status.retrying ? (
          <Banner text="Retrying after a provider error…" />
        ) : null}
        {status.queued > 0 ? (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-label text-faint">
            <Chip>{status.queued} queued</Chip>
            <span>will be sent when this turn ends</span>
            <button
              type="button"
              onClick={() => void actions.clearQueue()}
              className="pressable ml-auto flex items-center gap-1 rounded px-1 hover:text-foreground"
            >
              <XIcon className="size-3" />
              Clear
            </button>
          </div>
        ) : null}

        {planDecision ? <PlanDecisionBar key={planDecision.plan.id} decision={planDecision} /> : null}

        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void attach([...(event.target.files ?? [])])
            event.target.value = ""
          }}
        />

        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void attach([...event.dataTransfer.files])
          }}
          className={cn(
            "relative flex min-h-0 flex-col",
            (dragging || referencing) && "ring-1 ring-foreground/40 ring-inset"
          )}
        >
          {referencing ? (
            <div aria-live="polite" className="pointer-events-none absolute inset-x-0 top-1 z-10 flex justify-center">
              <span className="rounded-md bg-raised px-2 py-1 text-label text-muted-foreground ring-1 ring-hairline">
                Drop to reference this conversation
              </span>
            </div>
          ) : null}
          {mention ? (
            <MentionMenu
              kind={mention.sigil}
              leading={!draft.slice(0, mention.start).trim()}
              query={mention.query}
              onPick={pick}
              onVisibility={setMenuVisible}
              onDismiss={() => {
                setMention(null)
                textarea.current?.focus()
              }}
            />
          ) : null}

          {/*
           * The chips are painted behind a transparent textarea, glyph for
           * glyph. Keeping the real <textarea> as the input is what preserves
           * native caret, IME, undo, and spellcheck — a contenteditable would
           * trade all four for the same visual result.
           */}
          <InterruptedSends
            onRestore={(recovered) => {
              appendRecoveredDraft(draftKey, recovered)
              attachments.reattach(recovered.attachments)
              textarea.current?.focus()
            }}
          />
          {rejectedDrafts.map((rejected) => (
            <button
              key={rejected.id}
              type="button"
              className="pressable mx-2 mb-1 text-left text-ui text-caution"
              onClick={() => {
                const recovered = takeRejectedDraft(rejected.id)
                if (!recovered) return
                appendRecoveredDraft(draftKey, recovered)
                attachments.reattach(recovered.attachments)
              }}
            >
              Restore unsent message:{" "}
              {rejected.text.slice(0, 80) || "Attachments"}
            </button>
          ))}
          <PlanContextChips
            plans={draftPlans ?? []}
            onRemove={(plan) => removeDraftPlan(draftKey, plan)}
          />
          <AttachmentStrip
            items={stripItems}
            onRemove={removeAttachmentTile}
          />

          <div
            ref={scroller}
            className={cn("relative min-h-0 overflow-y-auto overscroll-contain", expanded ? "max-h-[60dvh]" : "max-h-[min(320px,35dvh)]")}
          >
            <ReferenceOverlay
              text={draft}
              attachments={attachments.items}
              labels={labels}
            />
            <textarea
              ref={textarea}
              value={view.text}
              rows={1}
              onChange={(event) => {
                promptHistory.current = null
                const node = event.target
                const replaced = replacing.current?.text === view.text ? replacing.current : undefined
                replacing.current = null
                // A chip an edit reached into went whole; its record goes with
                // it, and one whose anchor came back (an undo) returns.
                const typed = editDraftView(draft, view, node.value, node.selectionEnd, replaced)
                update(typed.draft)
                attachments.restoreRemoved(typed.draft)
                for (const id of clipboard.edit(typed.draft)) attachments.remove(id)
                const next = draftView(typed.draft, labels)
                const caret = toViewOffset(next, typed.caret)
                keptSelection.current = null
                if (next.text !== node.value) {
                  // The draft didn't change, so nothing will render: put the
                  // textarea back by hand.
                  if (typed.draft === draft) {
                    node.value = next.text
                    node.setSelectionRange(caret, caret)
                  } else pendingCaret.current = caret
                }
                setMention(mentionIn(typed.draft, next, caret))
              }}
              onSelect={(event) => {
                // A label is one unit: the caret steps over it, never into it.
                const node = event.currentTarget
                const current = viewRef.current
                let start = node.selectionStart
                let end = node.selectionEnd
                const span = start === end ? spanInside(current, start) : undefined
                if (span) {
                  const from = lastCaret.current
                  start = end =
                    from === span.viewStart ? span.viewEnd
                    : from === span.viewEnd ? span.viewStart
                    : start - span.viewStart < span.viewEnd - start ? span.viewStart : span.viewEnd
                  node.setSelectionRange(start, end)
                }
                lastCaret.current = start === end ? start : null
                keptSelection.current = {
                  draft: draftRef.current,
                  start: toDraftOffset(current, start, true),
                  end: toDraftOffset(current, end),
                }
              }}
              onKeyUp={syncMention}
              onClick={syncMention}
              onBlur={() => {
                // Let a click inside the menu land before it unmounts. Only
                // the menu open at the blur closes: the + menu takes focus,
                // inserts a sigil and opens its menu a frame before focus
                // returns, and this timer can fire in between.
                const open = mention
                setTimeout(() => {
                  if (document.activeElement !== textarea.current)
                    setMention((current) => (current === open ? null : current))
                }, 120)
              }}
              onKeyDown={onKeyDown}
              onCopy={clipboard.onCopy}
              onCut={clipboard.onCut}
              onPaste={clipboard.onPaste}
              readOnly={!draftReady}
              placeholder={draftReady ? placeholder : "Opening workspace…"}
              spellCheck={false}
              className={cn(
                // No max-height and no scrolling of its own — the wrapper owns
                // both, so the painted layer behind it stays in register.
                "composer-input relative block min-h-20 w-full resize-none overflow-hidden bg-transparent px-4 pt-4 pb-2",
                "font-sans text-prose leading-[1.6] placeholder:text-faint focus:outline-none",
                // Transparent glyphs let the overlay show through; the caret
                // and selection stay native and visible.
                "text-transparent caret-ember selection:bg-fill-selected selection:text-transparent"
              )}
            />
          </div>

          <div className="flex min-h-11 shrink-0 items-center gap-1 px-3 pb-3">
            <ComposerAdditions
              meta={meta}
              disabled={!draftReady}
              attachFiles={attach}
              onAttach={() => filePicker.current?.click()}
              onReference={(sigil) => {
                // A sigil opens its menu only at a word boundary, so one put
                // after a word gets a space before it.
                const node = textarea.current
                const before = node ? node.value.slice(0, node.selectionStart) : ""
                const gap = before && !/\s$/.test(before) ? " " : ""
                window.dispatchEvent(new CustomEvent("mako:insert", { detail: `${gap}${sigil}` }))
              }}
            />
            {/*
             * The row gives way in a fixed order as the pane narrows, found
             * by measuring rather than by a width breakpoint: access drops
             * to its glyph first (level 1), then the harness (level 2). The
             * model and its reasoning are what people read here, so they
             * are never shortened; whatever still does not fit scrolls
             * behind a faded edge instead of being cut off with no sign
             * that anything is missing.
             */}
            <div
              ref={routingRow}
              className="composer-routing flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
            >
              <ComposerRouting plan={plan} onPlanning={setPlanning} />
            </div>

            <div className="ml-2 flex shrink-0 items-center gap-1">
              <Slot
                name="composer.trailing"
                meta={meta}
                disabled={busy}
                attachFiles={attach}
              />
              {liveOwnsComposer ? <ContextMeter /> : null}
              {draft.length > 0 || expanded ? <IconAction label={expanded ? "Collapse draft" : "Expand draft"} size="xs" side="top" onClick={() => { setExpanded((value) => !value); textarea.current?.focus({ preventScroll: true }) }}>
                {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
              </IconAction> : null}
              {/*
               * What Enter does is said once, by the placeholder, and shown
               * by the button's icon; Cmd+Enter does the other thing. The
               * preference itself is a row in Settings > Conversation. A
               * toggle here once sat 4px from the primary action at three
               * times its width and made the pair read as one lump.
               */}
              <ComposerActionButton
                action={primaryAction}
                ready={hasContent && !opening && hostConnected}
                stopping={liveOwnsComposer && stopping}
                steerTitle={steerTitle}
                onSend={() => void submit(primaryAction === "steer" ? "steer" : undefined)}
                onStop={() => void stopCurrentTurn()}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
