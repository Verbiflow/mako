import { ComposerActionButton } from "@/components/composer/composer-action-button"
import { ComposerAdditions } from "@/components/composer/composer-additions"
import { ComposerRouting } from "@/components/composer/composer-routing"
import { harnessTitle } from "@/components/composer/harness-title"
import { ROUTING_COMPACT_LEVELS, useCompactRow } from "@/components/composer/use-compact-row"
import { useAcp } from "@/state/acp"
import { scopedAcp, scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { useDrafts } from "@/state/drafts"
import { useSession } from "@/state/session"
import { useRef } from "react"

const noop = () => {}

/**
 * The composer of a chat pane without focus, drawn from that pane's Session:
 * its draft, harness, model and access, in the same boxes the live composer
 * uses. The pane turns a press anywhere on it (`data-pane-reply`) into
 * focus, and the live composer takes its place without a shift, caret in
 * the draft.
 */
export function PaneComposer() {
  const scope = useConversationScope()
  const ref = scope?.kind === "history" ? scope.ref : undefined
  const liveHarness = useAcp((state) => scopedAcp(state, scope)?.harness)
  const liveDraftKey = useAcp((state) => scopedAcp(state, scope)?.draftKey)
  const running = useAcp((state) => {
    const status = scopedLiveAcp(state, scope)?.session.status
    return status === "running" || status === "starting"
  })
  const meta = useSession((state) => state.meta)
  const routingRow = useRef<HTMLDivElement>(null)
  useCompactRow(routingRow, ROUTING_COMPACT_LEVELS)
  const draftKey = liveDraftKey ?? ref?.path
  const draft = useDrafts((state) =>
    draftKey ? (state.drafts.find((entry) => entry.key === draftKey)?.text ?? "") : ""
  )
  const harness = liveHarness ?? ref?.harness
  const title = harness ? harnessTitle(harness) : "the agent"
  const placeholder = running
    ? `Queue a message for ${title}`
    : liveHarness
      ? `Reply — ${title} answers live`
      : `Reply — ${title} answers`

  return (
    <div
      data-composer
      data-pane-reply
      onPointerDown={(event) => event.preventDefault()}
      className="flex max-h-[55dvh] min-h-0 shrink-0 cursor-text flex-col border-t border-hairline bg-surface"
    >
      <div className="relative min-h-0 max-h-[min(320px,35dvh)] overflow-hidden">
        <textarea
          readOnly
          tabIndex={-1}
          value={draft}
          rows={1}
          placeholder={placeholder}
          spellCheck={false}
          aria-label={`Reply to ${title}`}
          className="composer-input pointer-events-none relative block min-h-20 w-full resize-none overflow-hidden bg-transparent px-4 pt-4 pb-2 font-sans text-prose leading-[1.6] text-foreground placeholder:text-faint focus:outline-none"
        />
      </div>
      <div className="flex min-h-11 shrink-0 items-center gap-1 px-3 pb-3 [&_button]:pointer-events-none">
        <ComposerAdditions meta={meta} disabled={false} attachFiles={async () => {}} onAttach={noop} onReference={noop} />
        <div
          ref={routingRow}
          className="composer-routing flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
        >
          <ComposerRouting />
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          <ComposerActionButton
            action={running ? (draft.trim() ? "queue" : "stop") : "send"}
            ready={draft.trim().length > 0}
            stopping={false}
            onSend={noop}
            onStop={noop}
          />
        </div>
      </div>
    </div>
  )
}
