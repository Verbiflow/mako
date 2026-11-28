import { AgentsToggle } from "@/components/inspector/agents-panel"
import { useState } from "react"
import { RadioGroup } from "radix-ui"
import { CheckIcon, ShieldAlertIcon, ShieldIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ACCESS_TIERS, accessTierInfo } from "@mako/host/contracts/access"
import type { LiveSessionMode } from "@/lib/types"
import { useAccessChoices } from "@/state/access-choices"
import {
  chooseProviderMode,
  chooseThreadMode,
  providerAccessModes,
  savedProviderMode,
  threadAccessMode,
} from "@/state/provider-access"
import { useThreads } from "@/state/threads"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ConversationRelations } from "@/components/viewer/conversation-relations"
import { acp, useAcp } from "@/state/acp"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { useSwitching } from "@/state/live-mode"

/**
 * What the composer bar carries for a live conversation: its access, its Fins, and the conversations it relates to.
 * Nothing else: compaction is in the context meter beside it, a message that wasn't answered is its own row in the
 * transcript, a switch or a steering message that is under way or went wrong is a notice above the composer while it
 * stands, and an idle provider closes on its own after ten minutes.
 */
export function LiveComposerControls() {
  const scope = useConversationScope()
  const conversationId = useAcp((state) => state.activeKey)
  // A pane without focus shows its Session's access; the rest act on the active conversation.
  if (scope) return <ModePicker />
  return (
    <>
      <ModePicker />
      <AgentsToggle />
      <ConversationRelations key={conversationId} />
    </>
  )
}

const TIER_ORDER = new Map(ACCESS_TIERS.map((info, index) => [info.tier, index]))

/** The ladder first, in a fixed order; a provider's own unplaced modes after it. */
function orderedModes(modes: readonly LiveSessionMode[]): LiveSessionMode[] {
  return [...modes].sort((left, right) => {
    const a = left.access ? (TIER_ORDER.get(left.access) ?? 99) : 100
    const b = right.access ? (TIER_ORDER.get(right.access) ?? 99) : 100
    return a - b
  })
}

function modeLabel(mode: LiveSessionMode): string {
  return mode.access ? accessTierInfo(mode.access).label : mode.name
}

/**
 * The provider's own name for a tier when it differs, and who enforces it.
 */
function modeDetail(mode: LiveSessionMode, harness: string): string | null {
  const parts: string[] = []
  if (mode.access && mode.name !== accessTierInfo(mode.access).label)
    parts.push(`${harness}: ${mode.name}`)
  if (mode.enforcement === "launch") parts.push("Set when the session starts")
  if (mode.enforcement === "mako") parts.push("Mako approves each request")
  if (!mode.access && mode.description) parts.push(mode.description)
  return parts.length ? parts.join(" · ") : null
}

/** The ladder as a list, rendered inside the picker and testable on its own. */
export function AccessModeList({
  modes,
  current,
  harness,
  onSelect,
}: {
  modes: readonly LiveSessionMode[]
  current: string | null
  harness: string
  onSelect: (modeId: string) => void
}) {
  return (
    <RadioGroup.Root aria-label="Access" value={current ?? ""} onValueChange={onSelect}>
      {orderedModes(modes).map((mode) => {
        const detail = modeDetail(mode, harness)
        const summary = mode.access ? accessTierInfo(mode.access).summary : null
        return (
          <RadioGroup.Item
            key={mode.id}
            value={mode.id}
            className="pressable flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-fill-hover data-[state=checked]:bg-fill-selected"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-ui">
                {mode.access === "full" ? (
                  <ShieldAlertIcon className="size-3 shrink-0 text-caution" />
                ) : null}
                <span className="truncate">{modeLabel(mode)}</span>
              </span>
              {summary ? <span className="text-label text-faint">{summary}</span> : null}
              {detail ? <span className="text-label text-faint">{detail}</span> : null}
            </span>
            <RadioGroup.Indicator className="mt-0.5">
              <CheckIcon className="size-3.5" />
            </RadioGroup.Indicator>
          </RadioGroup.Item>
        )
      })}
    </RadioGroup.Root>
  )
}

/** The running session's ladder; a pick applies now and is kept for the provider's next session. */
function ModePicker() {
  const scope = useConversationScope()
  const modes = useAcp((state) => scopedLiveAcp(state, scope)?.session.modes)
  const key = useAcp((state) => scopedLiveAcp(state, scope)?.key)
  const session = useAcp((state) => scopedLiveAcp(state, scope)?.session.currentMode)
  // The person's pick shows from the click; the session's own word of it follows (`live-mode.ts`).
  const current = useSwitching((state) => (key ? state.pending.get(key)?.mode : undefined)) ?? session
  const harness = useAcp((state) => scopedLiveAcp(state, scope)?.harness ?? "")
  if (!modes?.length) return null
  return (
    <AccessPicker
      modes={modes}
      current={current ?? null}
      harness={harness}
      heading="Access"
      onSelect={(value) => void acp.setMode(value)}
    />
  )
}

/**
 * The same ladder before a session exists: what the selected provider offers
 * a new session, with the level a send will run under current. The pick is
 * kept per provider and travels with the first prompt; when nothing was
 * picked, native configuration decides the level. Its effective value is
 * reported after connection; a declared factory default cannot certify it.
 */
export function NextSessionModePicker({
  planned,
  onChoose,
}: {
  /** The plan mode chosen for the next session, which outranks the saved level. */
  planned?: string
  onChoose?: () => void
}) {
  const scope = useConversationScope()
  const scopedRef = scope?.kind === "history" ? scope.ref : undefined
  const harness = useThreads((state) => scopedRef?.harness ?? state.composerHarness)
  const modes = useThreads((state) => providerAccessModes(state, harness))
  // The thread on screen remembers the tier its last turn ran under; that
  // is what a reply resumes with, so it is what the picker shows.
  const globalViewing = useThreads((state) => state.opening?.ref ?? state.viewing?.ref)
  const viewing = scope ? scopedRef : globalViewing
  const remembered = threadAccessMode(viewing, modes, harness)
  const saved = useAccessChoices((choices) =>
    savedProviderMode(choices.modes, modes, harness)
  )
  if (!modes.length) return null
  const thread = viewing?.harness === harness ? viewing : undefined
  return (
    <AccessPicker
      modes={modes}
      current={planned ?? remembered ?? saved ?? null}
      unresolvedLabel="Native default"
      unresolvedDetail="The agent uses its native configuration. Choose an access level to override it; the effective level appears after connection."
      harness={harness}
      heading={thread ? "Access when this thread continues" : "Access for the next session"}
      onSelect={(value) => {
        onChoose?.()
        if (thread) chooseThreadMode(thread, value)
        else chooseProviderMode(harness, value)
      }}
    />
  )
}

function AccessPicker({
  modes,
  current,
  harness,
  heading,
  onSelect,
  unresolvedLabel = "Access not reported",
  unresolvedDetail = "The agent has not reported its effective access level.",
}: {
  modes: readonly LiveSessionMode[]
  current: string | null
  harness: string
  heading: string
  unresolvedLabel?: string
  unresolvedDetail?: string
  onSelect: (modeId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected =
    modes.find((mode) => mode.id === current) ??
    (modes.length === 1 ? modes[0] : undefined)
  // The Plan toggle beside it already names plan mode; the chip says what it allows.
  const label = selected ? (selected.access === "plan" ? "Read-only" : modeLabel(selected)) : unresolvedLabel
  const full = selected?.access === "full"
  // The level in words, in the status line under the composer. Only full access is coloured, the one level that
  // never waits for the person; a warning glyph on every message read as an alarm that never went away.
  const reading = (
    <>
      {full ? <ShieldAlertIcon className="size-3 shrink-0" /> : <ShieldIcon className="size-3 shrink-0" />}
      <span data-collapse={full ? undefined : "1"} className="truncate">
        {selected ? label : "Default access"}
      </span>
    </>
  )
  if (modes.length === 1 && selected) {
    // A one-mode provider offers nothing to choose: the line states the one
    // level there is rather than opening a ladder of a single rung.
    const title = [modeDetail(selected, harness), selected.access ? accessTierInfo(selected.access).summary : null]
      .filter(Boolean)
      .join(" · ")
    return (
      <span
        aria-label={`Access: ${label}`}
        title={title || label}
        data-access={selected.access ?? selected.id}
        className={cn("flex h-7 min-w-0 shrink-0 items-center gap-1.5 px-2 text-ui", full ? "text-caution" : "text-faint")}
      >
        {reading}
      </span>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Access: ${label}`}
          title={selected ? (modeDetail(selected, harness) ?? (selected.access ? accessTierInfo(selected.access).summary : label)) : unresolvedDetail}
          data-access={selected ? (selected.access ?? selected.id) : "default"}
          className={cn(
            "pressable flex h-7 min-w-0 shrink-0 items-center gap-1.5 px-2 text-ui hover:bg-fill-hover data-[state=open]:bg-fill-selected",
            full ? "text-caution" : "text-faint hover:text-foreground"
          )}
        >
          {reading}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-1">
        <p className="px-2 py-1.5 text-label text-faint">{heading}</p>
        {!selected ? <p className="px-2 pb-2 text-label text-faint">{unresolvedDetail}</p> : null}
        <AccessModeList
          modes={modes}
          current={current}
          harness={harness}
          onSelect={(value) => {
            onSelect(value)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
