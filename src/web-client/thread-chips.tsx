import { useEffect, useState } from "react"
import { CheckIcon, ChevronDownIcon, ShieldIcon, TriangleAlertIcon } from "lucide-react"
import { accessTierInfo } from "@mako/host/contracts/access"
import { errorMessage } from "@mako/host/contracts/error-message"
import type { LiveSessionMode } from "@mako/host/contracts/providers-acp"
import type { ModelOption, SettingValue } from "@mako/sessions/settings"
import { optionLabel, settingValueLabel } from "@/components/composer/settings-source"
import { useComposerSettings, type ComposerSettingsView } from "@/components/composer/use-composer-settings"
import { Spinner } from "@/components/ui/spinner"
import { getMako } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { chooseComposerModel, chooseComposerOption, resolveComposerSettings, settingsTargetKey } from "@/state/composer-settings"
import { prefsStore, setPref } from "@/state/prefs"
import { accessInEffect, chooseAccess, orderedModes, readAccessChoices, type AccessChoices } from "./access"
import { record, switchedWords } from "./answered"
import { useWebClient } from "./client"
import { WebHarnessIcon } from "./harness-icon"
import { webHarnessLabel } from "./labels"
import { Sheet, SheetScroll } from "./sheet"
import { setPending, useSwitching } from "./switching"

/**
 * A Thread's model and access, as chips in its composer's bar, the desk composer's own controls on a phone:
 *
 * - The model and its reasoning effort are the desk's per-conversation choice (`composer-settings.ts`): kept for this
 *   Thread and sent with its next message, which switches the running Session to them, as the desk's composer does.
 *   A choice the harness can't take is put back at once, saying why.
 * - Access is the running Session's mode, changed on its owner now (`mako:live-mode`); Send waits while the change
 *   is on its way, so the next message runs under it. Refused, the chip stays where the Session is and says why.
 *   Every new session's access is the account's choice (`access.ts`): offered below the Thread's, never changed by it.
 *
 * Each change leaves a line at the end of the turn it was made in, as an answer from the dock does.
 */
export function ThreadChips({ conversation, harness }: { conversation: string; harness: string }) {
  const view = useComposerSettings(harness)
  const [open, setOpen] = useState<"model" | "access" | undefined>(undefined)
  const [chip, setChip] = useState<HTMLElement | null>(null)
  const show = (which: "model" | "access") => (event: React.MouseEvent<HTMLButtonElement>) => {
    setChip(event.currentTarget)
    setOpen(which)
  }
  const modes = useAcp((state) => (activeLiveAcp(state)?.key === conversation ? activeLiveAcp(state)?.session.modes : undefined))
  const current = useAcp((state) => (activeLiveAcp(state)?.key === conversation ? activeLiveAcp(state)?.session.currentMode : undefined))
  const switching = useSwitching((state) => state.pending.get(conversation))
  const shownMode = modes?.find((mode) => mode.id === (switching?.mode ?? current))
  const effort = reasoningOf(view)
  return (
    <>
      <button type="button" aria-label={`Model: ${view.modelLabel}${effort ? `, ${effort.label}` : ""}`} data-thread-chip="model" className="web-chip web-chip-shrinks web-chip-model" onClick={show("model")}>
        <span className="flex min-w-0 items-center gap-1.5">
          <WebHarnessIcon harness={harness} className="size-3.5 shrink-0" />
          <span className="truncate">{view.modelLabel}</span>
          {effort ? <span className="shrink-0 text-faint">{effort.label}</span> : null}
        </span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-50" />
      </button>
      {modes?.length ? (
        <button type="button" aria-label={`Access: ${shownMode ? modeLabel(shownMode) : "not reported"}`} data-thread-chip="access" className="web-chip web-chip-shrinks web-chip-access" onClick={show("access")}>
          <span className="flex min-w-0 items-center gap-1.5">
            {switching ? <Spinner className="size-3.5" /> : shownMode?.access === "full" ? <TriangleAlertIcon className="size-3.5 text-caution" /> : <ShieldIcon className="size-3.5" />}
            <span className="truncate">{shownMode ? modeLabel(shownMode) : "Access"}</span>
          </span>
          <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-50" />
        </button>
      ) : null}
      <ModelSheet anchor={chip} open={open === "model"} onDismiss={() => setOpen(undefined)} view={view} conversation={conversation} />
      {modes?.length ? <AccessSheet anchor={chip} open={open === "access"} onDismiss={() => setOpen(undefined)} conversation={conversation} harness={harness} modes={modes} current={switching?.mode ?? current ?? undefined} /> : null}
    </>
  )
}

/** The access chip's word for a mode: its tier's, "Read-only" for plan, else the harness's own name. */
function modeLabel(mode: LiveSessionMode): string {
  return mode.access ? (mode.access === "plan" ? "Read-only" : accessTierInfo(mode.access).label) : mode.name
}

function reasoningOf(view: ComposerSettingsView): { option: ModelOption; value: SettingValue | undefined; label: string } | undefined {
  const option = view.options.find((each) => each.role === "reasoning" && each.disabledReason === undefined)
  if (!option) return undefined
  const current = view.resolved.options[option.id]
  if (current?.kind !== "known") return undefined
  return { option, value: current.value, label: settingValueLabel(option, current.value) }
}

/** The newest turn's exchange, where a change's line goes. */
function lastExchange(): string | undefined {
  return activeLiveAcp(acpStore.get())?.projection?.exchanges.at(-1)?.id
}

function note(conversation: string, kind: "switched" | "not-switched", words: string, detail?: string): void {
  const exchange = lastExchange()
  if (exchange) record(conversation, { id: crypto.randomUUID(), exchange, kind, words, ...(detail && { detail }) })
}

/**
 * Makes a model or effort choice for this Thread, as the desk's composer does; one the harness refuses (an unavailable
 * model, an option it doesn't take) is put back as it was, and the line says why.
 */
function chooseSetting(view: ComposerSettingsView, conversation: string, choose: () => void, said: string): void {
  const key = settingsTargetKey(view.target)
  const before = prefsStore.get().settingsOverrides[key]
  choose()
  const issues = resolveComposerSettings(view.target).issues
  if (issues.length) {
    const overrides = { ...prefsStore.get().settingsOverrides }
    if (before) overrides[key] = before
    else delete overrides[key]
    setPref("settingsOverrides", overrides)
    note(conversation, "not-switched", switchedWords({ what: said, refused: true }), issues.map((issue) => issue.message).join(" "))
    return
  }
  note(conversation, "switched", switchedWords({ what: said, refused: false }), "from your next message")
}

function ModelSheet({ anchor, open, onDismiss, view, conversation }: { anchor: HTMLElement | null; open: boolean; onDismiss: () => void; view: ComposerSettingsView; conversation: string }) {
  const harness = view.target.harness
  const models = view.profile?.models ?? []
  const effort = reasoningOf(view)
  const reading = !view.profile || view.profile.pending
  useEffect(() => {
    if (open) void view.refresh().catch(() => undefined)
    // Asked again each time it opens, not each time the view changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Model" tall anchor={anchor}>
      <h3 className="web-sheet-title pb-0">Model</h3>
      <p className="web-sheet-note">For this Thread. {webHarnessLabel(harness)} switches with your next message.</p>
      {effort && effort.option.kind === "select" && effort.option.values.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto px-4 pb-3 web-scroll web-fade-x" role="radiogroup" aria-label={effort.option.label}>
          {effort.option.values.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={effort.value === choice.value}
              className="web-chip web-chip-tab"
              onClick={() => {
                if (effort.value === choice.value) return
                chooseSetting(view, conversation, () => chooseComposerOption(view.target, effort.option.id, choice.value), optionLabel(effort.option, { kind: "known", value: choice.value, source: "override" }))
              }}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
      <SheetScroll className="flex flex-col px-2 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        {reading && !models.length ? (
          <span className="mx-3 my-2 flex items-center gap-2 text-ui text-muted-foreground">
            <Spinner className="size-3.5" />
            Reading {webHarnessLabel(harness)}'s models…
          </span>
        ) : null}
        {view.error && !models.length ? <p className="px-3 py-2 text-ui text-muted-foreground">{view.error}</p> : null}
        {models.map((model) => {
          const chosen = view.model?.id === model.id
          return (
            <button
              key={model.id}
              type="button"
              aria-pressed={chosen}
              disabled={Boolean(model.unavailable)}
              className="web-choice"
              onClick={() => {
                onDismiss()
                if (chosen) return
                chooseSetting(view, conversation, () => chooseComposerModel(view.target, model.id), model.label)
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{model.label}</span>
                {model.unavailable ? <span className="truncate text-label text-faint">{model.unavailable}</span> : model.description ? <span className="truncate text-label text-faint">{model.description}</span> : null}
              </span>
              <CheckIcon aria-hidden className={cn("size-4 shrink-0", !chosen && "invisible")} />
            </button>
          )
        })}
      </SheetScroll>
    </Sheet>
  )
}

/** Changes the running Session's access on its owner now; says in the transcript what happened. */
async function switchAccess(conversation: string, mode: LiveSessionMode): Promise<void> {
  setPending(conversation, mode.id)
  try {
    await getMako().liveSetMode(conversation, mode.id)
    note(conversation, "switched", switchedWords({ what: modeLabel(mode), refused: false }), "access for this Thread")
  } catch (error) {
    note(conversation, "not-switched", switchedWords({ what: modeLabel(mode), refused: true }), errorMessage({ error }))
  } finally {
    setPending(conversation, undefined)
  }
}

function AccessSheet({ anchor, open, onDismiss, conversation, harness, modes, current }: { anchor: HTMLElement | null; open: boolean; onDismiss: () => void; conversation: string; harness: string; modes: readonly LiveSessionMode[]; current: string | undefined }) {
  const client = useWebClient()
  const name = webHarnessLabel(harness)
  const [choices, setChoices] = useState<AccessChoices | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    let alive = true
    readAccessChoices(client.gateway).then(
      (found) => alive && setChoices(found ?? {}),
      () => alive && setChoices({})
    )
    return () => {
      alive = false
    }
  }, [open, client])
  const forNew = choices ? accessInEffect(harness, choices, { modes }) : undefined
  const thread = modes.find((mode) => mode.id === current)
  return (
    <Sheet
      open={open}
      onDismiss={() => {
        setFailure(undefined)
        onDismiss()
      }}
      label="Access"
      anchor={anchor}
    >
      <h3 className="web-sheet-title pb-0">Access</h3>
      <p className="web-sheet-note">This Thread's {name} session, from now.</p>
      <SheetScroll className="flex flex-col px-2">
        {orderedModes(modes).map((mode) => (
          <button
            key={mode.id}
            type="button"
            aria-pressed={mode.id === current}
            data-access-mode={mode.id}
            className="web-choice"
            onClick={() => {
              onDismiss()
              if (mode.id !== current) void switchAccess(conversation, mode)
            }}
          >
            {mode.access === "full" ? <TriangleAlertIcon aria-hidden className="size-[18px] shrink-0 text-caution" /> : <ShieldIcon aria-hidden className="size-[18px] shrink-0 text-muted-foreground" />}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{modeLabel(mode)}</span>
              {mode.access ? <span className="line-clamp-2 text-label text-faint">{accessTierInfo(mode.access).summary}</span> : mode.description ? <span className="line-clamp-2 text-label text-faint">{mode.description}</span> : null}
            </span>
            <CheckIcon aria-hidden className={cn("size-4 shrink-0", mode.id !== current && "invisible")} />
          </button>
        ))}
      </SheetScroll>
      <div className="web-access-new" data-access-new>
        <p className="min-w-0 flex-1 text-label text-muted-foreground">
          New {name} sessions, on every device: <span className="text-foreground">{forNew ? forNew.label : "…"}</span>
        </p>
        {thread && forNew && forNew.mode !== thread.id ? (
          <button
            type="button"
            disabled={saving}
            className="web-quiet-button h-9 shrink-0 px-3 text-label font-medium"
            onClick={async () => {
              setSaving(true)
              setFailure(undefined)
              try {
                setChoices(await chooseAccess(client.gateway, harness, thread))
              } catch (error) {
                setFailure(`Not changed: ${errorMessage({ error })}`)
              } finally {
                setSaving(false)
              }
            }}
          >
            {saving ? "Saving…" : `Use ${modeLabel(thread)}`}
          </button>
        ) : null}
      </div>
      {failure ? <p role="alert" className="px-5 pb-2 text-label text-negative">{failure}</p> : null}
    </Sheet>
  )
}
