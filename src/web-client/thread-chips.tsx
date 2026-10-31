import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowLeftRightIcon, CheckIcon, ChevronDownIcon, SearchIcon, ShieldIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { errorMessage } from "@mako/host/contracts/error-message"
import type { LiveSessionMode } from "@mako/host/contracts/providers-acp"
import type { SettingValue } from "@mako/sessions/settings"
import { rankModels } from "@/components/composer/model-rank"
import { optionLabel } from "@/components/composer/settings-source"
import { useComposerSettings, type ComposerSettingsView } from "@/components/composer/use-composer-settings"
import { Spinner } from "@/components/ui/spinner"
import { getMako } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { chooseComposerModel, chooseComposerOption, resolveComposerSettings, settingsTargetKey } from "@/state/composer-settings"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { accessInEffect, chooseAccess, orderedModes, readAccessChoices, type AccessChoices } from "./access"
import { switchedWords, type RecordedSwitch } from "./answered"
import { useWebClient } from "./client"
import { WebHarnessIcon } from "./harness-icon"
import { webHarnessLabel } from "./labels"
import { Sheet, SheetScroll } from "./sheet"
import { setPending, useSwitching } from "./switching"
import { chipReading, effortControl, modeLabel, modeSummary, riskyMode, type SettingsReading } from "./thread-settings"

/** Past this many models the sheet offers a search, as the desk's picker does. */
const SEARCH_FROM = 8

/**
 * A Thread's model, effort and access in its composer's bar: one chip that says what the next message runs on
 * ("GPT-5.6 Sol · High", a caution mark while nothing waits for approval) and one sheet that changes any of it.
 *
 * - The model and its effort are the desk's per-conversation choice (`composer-settings.ts`): kept for this Thread and
 *   sent with its next message, which switches the running Session to them, as the desk's composer does. A choice the
 *   harness can't take is put back at once, saying why.
 * - Access is the running Session's mode, changed on its owner now (`mako:live-mode`); Send waits while the change is
 *   on its way, so the next message runs under it. Refused, the chip stays where the Session is and says why. Every new
 *   session's access is the account's choice (`access.ts`): offered under the Thread's, never changed by it.
 *
 * What each harness offers comes from its own catalog and ladder, so no harness has a branch here: a model without
 * effort has no effort control, a harness without a ladder no access row.
 */
export function ThreadChips({ conversation, harness }: { conversation: string; harness: string }) {
  const view = useComposerSettings(harness)
  const [open, setOpen] = useState(false)
  const [chip, setChip] = useState<HTMLElement | null>(null)
  const modes = useAcp((state) => (activeLiveAcp(state)?.key === conversation ? activeLiveAcp(state)?.session.modes : undefined))
  const current = useAcp((state) => (activeLiveAcp(state)?.key === conversation ? activeLiveAcp(state)?.session.currentMode : undefined))
  const switching = useSwitching((state) => state.pending.get(conversation))
  const shownMode = modes?.find((mode) => mode.id === (switching?.mode ?? current))
  const reading = readingOf(view)
  const said = chipReading(reading, shownMode)
  return (
    <>
      <button
        type="button"
        aria-label={said.spoken}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-thread-chip="settings"
        data-risky={said.risky || undefined}
        className="web-chip web-chip-shrinks web-settings-chip"
        onClick={(event) => {
          setChip(event.currentTarget)
          setOpen(true)
        }}
      >
        {switching ? <Spinner aria-hidden className="size-3.5 shrink-0" /> : said.risky ? <TriangleAlertIcon aria-hidden data-risky-mark className="size-3.5 shrink-0 text-caution" /> : null}
        <span className="truncate">{said.model}</span>
        {said.effort ? <span className="web-settings-chip-effort">· {said.effort}</span> : null}
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-50" />
      </button>
      <SettingsSheet anchor={chip} open={open} onDismiss={() => setOpen(false)} view={view} reading={reading} conversation={conversation} harness={harness} modes={modes} current={switching?.mode ?? current ?? undefined} switching={Boolean(switching)} />
    </>
  )
}

function readingOf(view: ComposerSettingsView): SettingsReading {
  return { models: view.profile?.models ?? [], model: view.model, modelLabel: view.modelLabel, options: view.options, resolved: view.resolved }
}

/** A switch refused, said where it was asked: nothing changed, so the transcript has nothing to keep of it. */
function refused(what: string, why: string): void {
  toast.error(switchedWords({ what, refused: true }), { description: why })
}

/**
 * Where the model, its effort or the access changed after a turn, as the Session's record keeps it (`recordedSwitches`):
 * one line each, at the end of that turn, in the chip's own words.
 */
export function SwitchLines({ harness, switches }: { harness: string; switches: readonly RecordedSwitch[] }) {
  const view = useComposerSettings(harness)
  const modes = useAcp((state) => activeLiveAcp(state)?.session.modes)
  const lines = switches.flatMap((each): { key: string; what: string }[] => {
    if (each.kind === "model") return [{ key: `model:${each.model}`, what: view.profile?.models.find((model) => model.id === each.model)?.label ?? each.model }]
    if (each.kind === "mode") {
      const mode = modes?.find((candidate) => candidate.id === each.mode)
      return mode ? [{ key: `mode:${each.mode}`, what: modeLabel(mode) }] : []
    }
    const option = view.options.find((candidate) => candidate.id === each.option)
    return option ? [{ key: `option:${each.option}`, what: optionLabel(option, { kind: "known", value: each.value, source: "override" }) }] : []
  })
  return lines.map(({ key, what }) => (
    <p key={key} data-switched={key} className="web-answered">
      <ArrowLeftRightIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{switchedWords({ what, refused: false })}</span>
    </p>
  ))
}

/**
 * Makes a model or effort choice for this Thread, as the desk's composer does; one the harness refuses (an unavailable
 * model, an option it doesn't take) is put back as it was, saying why.
 */
function chooseSetting(view: ComposerSettingsView, choose: () => void, said: string): void {
  const key = settingsTargetKey(view.target)
  const before = prefsStore.get().settingsOverrides[key]
  choose()
  const issues = resolveComposerSettings(view.target).issues
  if (issues.length) {
    const overrides = { ...prefsStore.get().settingsOverrides }
    if (before) overrides[key] = before
    else delete overrides[key]
    setPref("settingsOverrides", overrides)
    refused(said, issues.map((issue) => issue.message).join(" "))
  }
}

interface SheetProps {
  anchor: HTMLElement | null
  open: boolean
  onDismiss: () => void
  view: ComposerSettingsView
  reading: SettingsReading
  conversation: string
  harness: string
  modes: readonly LiveSessionMode[] | undefined
  current: string | undefined
  switching: boolean
}

/**
 * The one sheet: the harness's models by name, the chosen one's effort under them, and the Session's access as the
 * last row, opened in place. It stays open while choices are made, each taking effect as it's tapped; a drag down, a
 * tap outside or Back closes it.
 */
function SettingsSheet({ anchor, open, onDismiss, view, reading, conversation, harness, modes, current, switching }: SheetProps) {
  const [accessOpen, setAccessOpen] = useState(false)
  const [query, setQuery] = useState("")
  // Each opening starts as the sheet first did: the access closed, no search.
  const [opened, setOpened] = useState(open)
  if (opened !== open) {
    setOpened(open)
    if (open) {
      setAccessOpen(false)
      setQuery("")
    }
  }
  const list = useRef<HTMLDivElement>(null)
  // The harness is asked for its models again each time the sheet opens, not each time the view changes.
  const refresh = useRef(view.refresh)
  useEffect(() => {
    refresh.current = view.refresh
  })
  useEffect(() => {
    if (open) void refresh.current().catch(() => undefined)
  }, [open])
  // Opened on a long list, the chosen model is in the middle of it.
  useLayoutEffect(() => {
    const row = open ? list.current?.querySelector<HTMLElement>("[aria-checked='true']") : null
    const scroller = row?.closest<HTMLElement>("[data-sheet-scroll]")
    if (!row || !scroller) return
    const at = row.getBoundingClientRect()
    const shown = scroller.getBoundingClientRect()
    if (at.top >= shown.top && at.bottom <= shown.bottom) return
    scroller.scrollTop += at.top - shown.top - (shown.height - at.height) / 2
  }, [open])
  const name = webHarnessLabel(harness)
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Model and access" anchor={anchor}>
      <div className="web-settings-head">
        <WebHarnessIcon harness={harness} className="size-4 shrink-0" />
        <h3 className="min-w-0 flex-1 truncate text-ui font-semibold">{name}</h3>
        <span className="shrink-0 text-label text-faint">Switches with your next message</span>
      </div>
      {reading.models.length > SEARCH_FROM ? (
        <label className="web-settings-search">
          <SearchIcon aria-hidden className="size-4 shrink-0 text-faint" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${name} models`} aria-label={`Search ${name} models`} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
        </label>
      ) : null}
      <SheetScroll className="web-settings-models">
        <div ref={list} role="radiogroup" aria-label="Model">
          <ModelRows view={view} query={query} />
        </div>
      </SheetScroll>
      <div className="web-settings-foot">
        <EffortRow view={view} reading={reading} />
        {modes?.length ? <AccessRow open={accessOpen} onToggle={() => setAccessOpen((was) => !was)} onChosen={() => setAccessOpen(false)} conversation={conversation} harness={harness} modes={modes} current={current} switching={switching} sheetOpen={open} /> : null}
      </div>
    </Sheet>
  )
}

function ModelRows({ view, query }: { view: ComposerSettingsView; query: string }) {
  const harness = view.target.harness
  const favorites = usePrefs((prefs) => prefs.favoriteModels)
  const catalog = view.profile?.models
  const models = useMemo(() => rankModels(catalog ?? [], query, favorites, harness), [catalog, query, favorites, harness])
  const reading = !view.profile || view.profile.pending
  if (reading && !models.length)
    return (
      <p role="status" className="web-settings-quiet">
        <Spinner className="size-3.5" />
        Reading {webHarnessLabel(harness)}'s models…
      </p>
    )
  if (view.error && !models.length) return <p className="web-settings-quiet">{view.error}</p>
  if (!models.length) return <p className="web-settings-quiet">{query ? "No models match." : `${webHarnessLabel(harness)} reported no models.`}</p>
  return models.map((model) => {
    const chosen = view.model?.id === model.id
    const note = model.unavailable ?? model.description
    return (
      <button
        key={model.id}
        type="button"
        role="radio"
        aria-checked={chosen}
        data-model={model.id}
        disabled={Boolean(model.unavailable)}
        className="web-choice web-settings-model"
        onClick={() => {
          if (!chosen) chooseSetting(view, () => chooseComposerModel(view.target, model.id), model.label)
        }}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate", chosen && "font-medium")}>{model.label}</span>
          {note ? <span className="truncate text-label text-faint">{note}</span> : null}
        </span>
        <CheckIcon aria-hidden className={cn("size-[18px] shrink-0", !chosen && "invisible")} />
      </button>
    )
  })
}

/**
 * The chosen model's effort as one segmented control of the levels it offers. A model without effort, in a harness
 * whose other models have it, says so in the control's place; a harness without any draws nothing.
 */
function EffortRow({ view, reading }: { view: ComposerSettingsView; reading: SettingsReading }) {
  const control = effortControl(reading)
  if (control.kind === "none") return null
  return (
    <section className="web-settings-effort" aria-label="Effort" data-effort={control.kind}>
      <h4 className="web-settings-label">Effort</h4>
      {control.kind === "choose" ? (
        <Segmented
          label="Effort"
          choices={control.choices}
          current={control.current}
          onChoose={(value) => chooseSetting(view, () => chooseComposerOption(view.target, control.option.id, value), optionLabel(control.option, { kind: "known", value, source: "override" }))}
        />
      ) : (
        <p className="web-settings-effort-note">
          {control.kind === "absent" ? `${control.model} has no effort setting` : [control.label ?? "Not reported", control.reason].filter(Boolean).join(" · ")}
        </p>
      )}
    </section>
  )
}

/**
 * Choices side by side, the chosen one raised on a thumb that slides to the next one tapped, as iOS draws a segmented
 * control. The thumb is placed from the chosen segment's own box, so segments keep their words' widths.
 */
function Segmented({ label, choices, current, onChoose }: { label: string; choices: readonly { value: SettingValue; label: string }[]; current: SettingValue | undefined; onChoose: (value: SettingValue) => void }) {
  const track = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  const index = choices.findIndex((choice) => choice.value === current)
  const placed = useRef(false)
  useLayoutEffect(() => {
    const segment = track.current?.querySelectorAll<HTMLElement>("[role='radio']")[index]
    const mark = thumb.current
    if (!mark) return
    if (!segment) {
      mark.style.opacity = "0"
      return
    }
    // The first placement is where it is; every later one slides there.
    mark.style.transitionDuration = placed.current ? "" : "0ms"
    mark.style.opacity = "1"
    mark.style.width = `${segment.offsetWidth}px`
    mark.style.transform = `translate3d(${segment.offsetLeft}px, 0, 0)`
    placed.current = true
  }, [index, choices])
  return (
    <div ref={track} role="radiogroup" aria-label={label} className="web-segmented">
      <span ref={thumb} aria-hidden className="web-segmented-thumb" />
      {choices.map((choice) => (
        <button
          key={String(choice.value)}
          type="button"
          role="radio"
          aria-checked={choice.value === current}
          data-value={String(choice.value)}
          className="web-segment"
          onClick={() => {
            if (choice.value !== current) onChoose(choice.value)
          }}
        >
          {choice.label}
        </button>
      ))}
    </div>
  )
}

/** Changes the running Session's access on its owner now; a refusal says why where it was asked. */
async function switchAccess(conversation: string, mode: LiveSessionMode): Promise<void> {
  setPending(conversation, mode.id)
  try {
    await getMako().liveSetMode(conversation, mode.id)
  } catch (error) {
    refused(modeLabel(mode), errorMessage({ error }))
  } finally {
    setPending(conversation, undefined)
  }
}

/**
 * The Session's access as one row saying what it allows; tapped, the other levels open under it, each with its own
 * sentence, and under them what new sessions of this harness start in, on every device.
 */
function AccessRow({ open, onToggle, onChosen, conversation, harness, modes, current, switching, sheetOpen }: { open: boolean; onToggle: () => void; onChosen: () => void; conversation: string; harness: string; modes: readonly LiveSessionMode[]; current: string | undefined; switching: boolean; sheetOpen: boolean }) {
  const shown = modes.find((mode) => mode.id === current)
  const others = orderedModes(modes).filter((mode) => mode.id !== current)
  const summary = shown ? modeSummary(shown) : "This session hasn't said."
  const said = (
    <>
      <AccessMark mode={shown} switching={switching} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{shown ? modeLabel(shown) : "Access"}</span>
        {summary ? <span className="line-clamp-2 text-label text-faint">{summary}</span> : null}
      </span>
    </>
  )
  // A harness with one level has nothing to open: the row only says it.
  if (!others.length)
    return (
      <section className="web-settings-access" aria-label="Access">
        <div data-access-row className="web-choice web-settings-access-row">
          {said}
        </div>
      </section>
    )
  return (
    <section className="web-settings-access" aria-label="Access" data-open={open || undefined}>
      <button type="button" aria-expanded={open} data-access-row className="web-choice web-settings-access-row" onClick={onToggle}>
        {said}
        <ChevronDownIcon aria-hidden className="web-settings-access-chevron size-4 shrink-0 text-faint" />
      </button>
      <div className="web-settings-access-more" inert={!open}>
        <div className="min-h-0 overflow-hidden">
          {others.map((mode) => (
            <button
              key={mode.id}
              type="button"
              data-access-mode={mode.id}
              className="web-choice web-settings-access-row"
              onClick={() => {
                onChosen()
                void switchAccess(conversation, mode)
              }}
            >
              <AccessMark mode={mode} switching={false} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{modeLabel(mode)}</span>
                {modeSummary(mode) ? <span className="line-clamp-2 text-label text-faint">{modeSummary(mode)}</span> : null}
              </span>
            </button>
          ))}
          <NewSessions harness={harness} modes={modes} thread={shown} asked={sheetOpen && open} />
        </div>
      </div>
    </section>
  )
}

function AccessMark({ mode, switching }: { mode: LiveSessionMode | undefined; switching: boolean }) {
  if (switching) return <Spinner aria-hidden className="size-[18px] shrink-0" />
  return riskyMode(mode) ? <TriangleAlertIcon aria-hidden className="size-[18px] shrink-0 text-caution" /> : <ShieldIcon aria-hidden className="size-[18px] shrink-0 text-muted-foreground" />
}

/** What every new session of this harness starts in, as the account keeps it, and making this Session's that. */
function NewSessions({ harness, modes, thread, asked }: { harness: string; modes: readonly LiveSessionMode[]; thread: LiveSessionMode | undefined; asked: boolean }) {
  const client = useWebClient()
  const name = webHarnessLabel(harness)
  const [choices, setChoices] = useState<AccessChoices | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!asked) return
    let alive = true
    readAccessChoices(client.gateway).then(
      (found) => alive && setChoices(found ?? {}),
      () => alive && setChoices({})
    )
    return () => {
      alive = false
    }
  }, [asked, client])
  const forNew = choices ? accessInEffect(harness, choices, { modes }) : undefined
  return (
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
      {failure ? <p role="alert" className="basis-full text-label text-negative">{failure}</p> : null}
    </div>
  )
}
