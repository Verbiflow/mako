import { useMemo, useState, type ReactNode } from "react"
import { CheckIcon, CloudIcon, CopyIcon, LinkIcon, PlusIcon, RotateCwIcon, XIcon } from "lucide-react"
import { automations } from "@/state/automations"
import { confirmAction } from "@/state/confirm"
import { TRIGGER_ICONS } from "@/components/automations/trigger-icons"
import { SLACK_UNCONNECTED, type AutomationHook, type AutomationTrigger, type AutomationTriggerKind } from "@mako/host/contracts/automations"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import {
  cronOf,
  cronProblem,
  GITHUB_EVENT_LABELS,
  knownZones,
  LINEAR_EVENT_LABELS,
  localZone,
  MINUTE_STEPS,
  entriesOf,
  keyOf,
  nextRuns,
  omitKey,
  ordinal,
  presetOf,
  PRESET_LABELS,
  SENTRY_EVENT_LABELS,
  SLACK_EVENT_LABELS,
  switchPreset,
  triggerInCloud,
  triggerSentence,
  triggerWaits,
  WEEKDAY_NAMES,
  localTime,
  zoneDate,
  type SchedulePreset,
} from "@/lib/automation-words"
import { cn } from "@/lib/utils"

/**
 * An automation's triggers, each a sentence whose words are its controls ("Every [weekday] at [9:00] in
 * [Europe/London]", "When [a release is published] in [acme/app]"), with what it would wait for in a line of its own and
 * a schedule's next three runs under it. Added from a menu, removed by its own ×, at most eight.
 */

/** An inline control in a sentence: the raised plane, as wide as what it holds. */
const CHIP = "h-7 min-w-0 bg-raised px-1.5 text-ui text-foreground [field-sizing:content] placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border disabled:opacity-60"
const WORD = "text-ui text-muted-foreground"

const MAX_TRIGGERS = 8

const NEW_TRIGGER = {
  schedule: () => ({ kind: "schedule", cron: "0 9 * * 1-5", timezone: localZone() }),
  commit: () => ({ kind: "commit" }),
  manual: () => ({ kind: "manual" }),
  github: () => ({ kind: "github", event: "release", repo: "" }),
  slack: () => ({ kind: "slack", event: "message", channels: [] }),
  linear: () => ({ kind: "linear", event: "issue_created" }),
  sentry: () => ({ kind: "sentry", event: "issue_created" }),
  webhook: () => ({ kind: "webhook", secret: "" }),
} satisfies Record<Exclude<AutomationTriggerKind, "unsupported">, () => AutomationTrigger>

const ADD_LIVE: Array<[Exclude<AutomationTriggerKind, "unsupported">, string]> = [
  ["schedule", "On a schedule"],
  ["commit", "On a commit"],
  ["manual", "Only by Run now"],
]
const ADD_LATER: Array<[Exclude<AutomationTriggerKind, "unsupported">, string]> = [
  ["github", "GitHub event"],
  ["slack", "Slack event"],
  ["linear", "Linear event"],
  ["sentry", "Sentry event"],
  ["webhook", "Webhook"],
]

export function TriggerList({
  triggers,
  onChange,
  problems,
  cloudRegistered,
}: {
  /** Whether the cloud account registered this automation's cloud triggers. */
  cloudRegistered?: boolean
  triggers: AutomationTrigger[]
  onChange: (next: AutomationTrigger[]) => void
  /** Problems by trigger index, from validation. */
  problems: Record<number, string>
}) {
  const set = (index: number, next: AutomationTrigger) => onChange(triggers.map((each, at) => (at === index ? next : each)))
  const remove = (index: number) => onChange(triggers.filter((_, at) => at !== index))
  const add = (kind: Exclude<AutomationTriggerKind, "unsupported">) => {
    onChange([...triggers, NEW_TRIGGER[kind]()])
    // The new sentence's first control takes the keyboard.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-trigger-index="${triggers.length}"] select, [data-trigger-index="${triggers.length}"] input`)?.focus())
  }
  return (
    <div className="flex flex-col gap-1.5">
      {triggers.map((trigger, index) => (
        <TriggerRow key={index} index={index} trigger={trigger} cloudRegistered={cloudRegistered} problem={problems[index]} onChange={(next) => set(index, next)} onRemove={() => remove(index)} />
      ))}
      {triggers.length < MAX_TRIGGERS ? (
        <Menu modal={false}>
          <MenuTrigger asChild>
            <button type="button" data-add-trigger className="pressable flex h-8 w-fit items-center gap-1.5 px-2 text-ui text-muted-foreground hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover">
              <PlusIcon className="size-3.5" />
              Add a trigger
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="min-w-60">
            {ADD_LIVE.map(([kind, label]) => {
              const Icon = TRIGGER_ICONS[kind]
              return (
                <MenuItem key={kind} data-add-trigger-kind={kind} onSelect={() => add(kind)}>
                  <Icon className="size-3.5" />
                  {label}
                </MenuItem>
              )
            })}
            <MenuSeparator />
            <MenuLabel>Fired by your cloud account</MenuLabel>
            {ADD_LATER.map(([kind, label]) => {
              const Icon = TRIGGER_ICONS[kind]
              // Slack can't be added: Mako's cloud has no Slack app to hear it yet.
              const unconnected = kind === "slack"
              return (
                <MenuItem key={kind} data-add-trigger-kind={kind} disabled={unconnected} onSelect={() => add(kind)}>
                  <Icon className="size-3.5" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    {label}
                    {unconnected ? <span data-add-trigger-unconnected className="text-label text-faint">{SLACK_UNCONNECTED}</span> : null}
                  </span>
                  <CloudIcon aria-label="Delivered by the cloud" className="size-3 text-faint" />
                </MenuItem>
              )
            })}
          </MenuContent>
        </Menu>
      ) : (
        <p className="text-label text-faint">Eight triggers at most; remove one to add another.</p>
      )}
    </div>
  )
}

function TriggerRow({ index, trigger, cloudRegistered, problem, onChange, onRemove }: { index: number; trigger: AutomationTrigger; cloudRegistered?: boolean; problem?: string; onChange: (next: AutomationTrigger) => void; onRemove: () => void }) {
  const Icon = TRIGGER_ICONS[trigger.kind]
  const waits = triggerWaits(trigger, cloudRegistered)
  return (
    <div data-trigger-index={index} data-trigger-kind={trigger.kind} className="group/trigger flex flex-col gap-1.5 bg-shell/55 px-3 py-2.5 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
      <div className="flex min-w-0 items-start gap-2">
        <span className="flex h-7 shrink-0 items-center text-muted-foreground">
          <Icon aria-hidden className="size-3.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          <Sentence trigger={trigger} onChange={onChange} />
        </div>
        <button type="button" aria-label={`Remove “${triggerSentence(trigger)}”`} data-remove-trigger={index} onClick={onRemove} className="pressable flex size-7 shrink-0 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground">
          <XIcon className="size-3.5" />
        </button>
      </div>
      {trigger.kind === "schedule" ? <NextRuns cron={trigger.cron} timezone={trigger.timezone} /> : null}
      {"runWhen" in trigger || (trigger.kind !== "manual" && trigger.kind !== "unsupported") ? (
        <RunWhen value={"runWhen" in trigger ? trigger.runWhen : undefined} onChange={(runWhen) => onChange({ ...trigger, runWhen })} />
      ) : null}
      {trigger.kind === "webhook" ? (
        <label className="flex min-w-0 items-center gap-1.5 pl-[22px] text-label text-faint">
          <span className="shrink-0">Gather deliveries for</span>
          <input
            type="number"
            min={1}
            max={3600}
            aria-label="Seconds to gather deliveries"
            data-webhook-window
            className={cn(CHIP, "h-6 w-16 text-label tabular")}
            placeholder="off"
            value={trigger.coalesce?.windowS ?? ""}
            onChange={(event) => {
              const windowS = Number(event.target.value)
              const rest = omitKey(trigger, "coalesce")
              onChange(event.target.value && Number.isInteger(windowS) ? { ...rest, coalesce: { windowS } } : rest)
            }}
          />
          <span>seconds into one run</span>
        </label>
      ) : null}
      {trigger.kind === "webhook" ? <WebhookAddress name={trigger.secret} /> : null}
      {waits || triggerInCloud(trigger) ? (
        <p data-trigger-waits className="flex items-center gap-1.5 pl-[22px] text-label text-faint">
          <CloudIcon aria-hidden className="size-3" />
          {waits ?? "Fired by your cloud account, whether or not this Mac is on."}
        </p>
      ) : null}
      {problem ? <p role="alert" data-trigger-problem className="pl-[22px] text-label text-negative">{problem}</p> : null}
    </div>
  )
}

/** The trigger's sentence, its variable words as controls. */
function Sentence({ trigger, onChange }: { trigger: AutomationTrigger; onChange: (next: AutomationTrigger) => void }) {
  switch (trigger.kind) {
    case "schedule":
      return <ScheduleSentence cron={trigger.cron} timezone={trigger.timezone} onChange={(cron, timezone) => onChange({ ...trigger, cron, timezone })} />
    case "commit":
      return (
        <>
          <span className={WORD}>When a commit lands on</span>
          <input aria-label="Branch" className={cn(CHIP, "font-mono text-label")} placeholder="any branch" value={trigger.branch ?? ""} onChange={(event) => onChange({ kind: "commit", ...(event.target.value.trim() && { branch: event.target.value.trim() }), ...(trigger.runWhen && { runWhen: trigger.runWhen }) })} />
          <span className={WORD}>in this project</span>
        </>
      )
    case "manual":
      return <span className="flex h-7 items-center text-ui text-foreground">Only when you press Run now, or an agent asks to</span>
    case "github":
      return (
        <>
          <span className={WORD}>When</span>
          <EventSelect label="GitHub event" value={trigger.event} options={GITHUB_EVENT_LABELS} onChange={(event) => onChange({ ...trigger, event })} />
          <span className={WORD}>in</span>
          <input aria-label="Repository" className={cn(CHIP, "font-mono text-label")} placeholder="owner/repo" value={trigger.repo} onChange={(event) => onChange({ ...trigger, repo: event.target.value.trim() })} />
        </>
      )
    case "slack":
      return (
        <>
          <span className={WORD}>When</span>
          <EventSelect label="Slack event" value={trigger.event} options={SLACK_EVENT_LABELS} onChange={(event) => onChange({ ...trigger, event })} />
          <span className={WORD}>on Slack in</span>
          <input
            aria-label="Channels"
            className={CHIP}
            placeholder="any channel"
            defaultValue={trigger.channels.join(", ")}
            onBlur={(event) => onChange({ ...trigger, channels: event.target.value.split(/[\s,]+/).map((each) => each.trim()).filter(Boolean) })}
          />
        </>
      )
    case "linear":
      return (
        <>
          <span className={WORD}>When</span>
          <EventSelect label="Linear event" value={trigger.event} options={LINEAR_EVENT_LABELS} onChange={(event) => onChange({ ...trigger, event })} />
          <span className={WORD}>in Linear for</span>
          <input aria-label="Team" className={CHIP} placeholder="any team" value={trigger.team ?? ""} onChange={(event) => onChange({ ...omitKey(trigger, "team"), ...(event.target.value.trim() && { team: event.target.value.trim() }) })} />
        </>
      )
    case "sentry":
      return (
        <>
          <span className={WORD}>When</span>
          <EventSelect label="Sentry event" value={trigger.event} options={SENTRY_EVENT_LABELS} onChange={(event) => onChange({ ...trigger, event })} />
          <span className={WORD}>in Sentry for</span>
          <input aria-label="Sentry project" className={CHIP} placeholder="any project" value={trigger.project ?? ""} onChange={(event) => onChange({ ...omitKey(trigger, "project"), ...(event.target.value.trim() && { project: event.target.value.trim() }) })} />
        </>
      )
    case "webhook":
      return (
        <>
          <span className={WORD}>When a webhook signed with the secret</span>
          <input aria-label="Secret name" className={cn(CHIP, "font-mono text-label")} placeholder="SECRET_NAME" value={trigger.secret} onChange={(event) => onChange({ ...trigger, secret: event.target.value.trim() })} />
          <span className={WORD}>arrives</span>
        </>
      )
    case "unsupported":
      return (
        <span className="flex min-w-0 flex-col gap-1 py-1">
          <span className="text-ui text-foreground">A trigger this Mako can't read</span>
          <span className="text-label text-muted-foreground">{trigger.why}</span>
          <code className="truncate text-label text-faint">{JSON.stringify(trigger.raw)}</code>
        </span>
      )
  }
}

function EventSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Record<T, string>; onChange: (next: T) => void }) {
  return (
    <select aria-label={label} className={cn(CHIP, "pr-1")} value={value} onChange={(event) => {
      const next = keyOf(options, event.target.value)
      if (next) onChange(next)
    }}>
      {entriesOf(options).map(([key, words]) => (
        <option key={key} value={key}>
          {words}
        </option>
      ))}
    </select>
  )
}

const MINUTES_OF_HOUR = Array.from({ length: 12 }, (_, index) => index * 5)
const DATES = Array.from({ length: 28 }, (_, index) => index + 1)

/** "Every [weekday] at [9:00] in [Europe/London]", or a custom cron and its timezone. */
export function ScheduleSentence({ cron, timezone, onChange }: { cron: string; timezone: string; onChange: (cron: string, timezone: string) => void }) {
  // Custom stays custom while its cron happens to read as a preset, until another is picked.
  const [custom, setCustom] = useState(() => presetOf(cron).kind === "custom")
  const preset: SchedulePreset = custom ? { kind: "custom", cron } : presetOf(cron)
  const zones = useMemo(() => knownZones(), [])
  const write = (next: SchedulePreset) => onChange(cronOf(next), timezone)
  const time = "hour" in preset ? (
    <>
      <span className={WORD}>at</span>
      <input
        type="time"
        aria-label="Time"
        className={cn(CHIP, "tabular")}
        value={`${String(preset.hour).padStart(2, "0")}:${String(preset.minute).padStart(2, "0")}`}
        onChange={(event) => {
          const [hour, minute] = event.target.value.split(":").map(Number)
          if (Number.isInteger(hour) && Number.isInteger(minute)) write({ ...preset, hour: hour!, minute: minute! })
        }}
      />
    </>
  ) : null
  let middle: ReactNode
  switch (preset.kind) {
    case "minutes":
      middle = (
        <select aria-label="Minutes between runs" className={CHIP} value={preset.every} onChange={(event) => write({ kind: "minutes", every: Number(event.target.value) })}>
          {MINUTE_STEPS.map((step) => (
            <option key={step} value={step}>
              {step} minutes
            </option>
          ))}
        </select>
      )
      break
    case "hourly":
      middle = (
        <>
          <span className={WORD}>at</span>
          <select aria-label="Minute past the hour" className={cn(CHIP, "tabular")} value={preset.minute} onChange={(event) => write({ kind: "hourly", minute: Number(event.target.value) })}>
            {[...new Set([...MINUTES_OF_HOUR, preset.minute])].sort((a, b) => a - b).map((minute) => (
              <option key={minute} value={minute}>
                :{String(minute).padStart(2, "0")}
              </option>
            ))}
          </select>
        </>
      )
      break
    case "weekly":
      middle = (
        <>
          <span className={WORD}>on</span>
          <select aria-label="Day of the week" className={CHIP} value={preset.day} onChange={(event) => write({ ...preset, day: Number(event.target.value) })}>
            {WEEKDAY_NAMES.map((name, day) => (
              <option key={name} value={day}>
                {name}
              </option>
            ))}
          </select>
          {time}
        </>
      )
      break
    case "monthly":
      middle = (
        <>
          <span className={WORD}>on the</span>
          <select aria-label="Day of the month" className={CHIP} value={preset.date} onChange={(event) => write({ ...preset, date: Number(event.target.value) })}>
            {DATES.map((date) => (
              <option key={date} value={date}>
                {ordinal(date)}
              </option>
            ))}
          </select>
          {time}
        </>
      )
      break
    case "custom":
      middle = (
        <input
          aria-label="Cron schedule"
          data-cron-input
          className={cn(CHIP, "min-w-36 font-mono text-label", cronProblem(cron) && "ring-1 ring-negative/60")}
          placeholder="minute hour day month weekday"
          spellCheck={false}
          value={preset.cron}
          onChange={(event) => onChange(event.target.value, timezone)}
        />
      )
      break
    default:
      middle = time
  }
  return (
    <>
      <select
        aria-label="How often"
        data-schedule-preset
        className={CHIP}
        value={preset.kind}
        onChange={(event) => {
          const kind = keyOf(PRESET_LABELS, event.target.value)
          if (!kind) return
          setCustom(kind === "custom")
          if (kind === "custom") requestAnimationFrame(() => document.activeElement?.closest("[data-trigger-index]")?.querySelector<HTMLInputElement>("[data-cron-input]")?.focus())
          write(switchPreset(custom ? presetOf(cron) : preset, kind))
        }}
      >
        {entriesOf(PRESET_LABELS).map(([kind, label]) => (
          <option key={kind} value={kind}>
            {label}
          </option>
        ))}
      </select>
      {middle}
      <span className={WORD}>in</span>
      <select aria-label="Timezone" data-schedule-zone className={cn(CHIP, "max-w-56")} value={timezone} onChange={(event) => onChange(cron, event.target.value)}>
        {(zones.includes(timezone) ? zones : [timezone, ...zones]).map((zone) => (
          <option key={zone} value={zone}>
            {zone.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </>
  )
}

/** The schedule's next three runs, as this Mac's clock reads them, from the same cron the host schedules by. */
export function NextRuns({ cron, timezone }: { cron: string; timezone: string }) {
  const problem = cronProblem(cron)
  const times = useMemo(() => (problem ? [] : nextRuns(cron, timezone, 3)), [cron, timezone, problem])
  if (problem) return <p data-cron-problem className="pl-[22px] text-label text-negative">{problem}</p>
  if (!times.length) return <p className="pl-[22px] text-label text-caution">This schedule never comes round in the next eight years.</p>
  return (
    <div data-next-runs className="flex items-baseline gap-2 pl-[22px] text-label text-faint">
      <span className="shrink-0">Next</span>
      <ol className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5">
        {times.map((at) => {
          const local = localTime(at, timezone)
          return (
            <li key={at} className="flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="tabular text-muted-foreground">{zoneDate(at, timezone)}</span>
              {local ? <span data-next-local className="text-faint">{local}</span> : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * Where the sender delivers a webhook: the account's address for this secret's name, and the secret itself, shown once
 * when it's made or rotated (the account keeps it sealed after), with Copy beside each and Rotate for a new one.
 */
function WebhookAddress({ name }: { name: string }) {
  const [hook, setHook] = useState<AutomationHook | undefined>()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | undefined>()
  const ask = async (rotate: boolean) => {
    if (rotate && !(await confirmAction({ title: "Rotate this webhook's secret?", body: "The old secret keeps working for 24 hours, then stops; give the sender the new one before then.", confirm: "Rotate secret" }))) return
    setBusy(true)
    const answer = await automations.hook(name, "webhook", rotate)
    setBusy(false)
    if (answer) setHook(answer)
  }
  const copy = (what: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => setCopied(what))
  }
  if (!name) return null
  if (!hook || hook.name !== name)
    return (
      <div className="pl-[22px]">
        <button type="button" data-webhook-address disabled={busy} onClick={() => void ask(false)} className="pressable flex h-7 items-center gap-1.5 bg-fill-hover px-2.5 text-label text-foreground hover:bg-fill-selected disabled:opacity-50">
          <LinkIcon className="size-3" />
          Get its address
        </button>
      </div>
    )
  return (
    <div data-webhook-hook className="ml-[22px] flex flex-col gap-1.5 bg-raised px-2.5 py-2 text-label">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-14 shrink-0 text-faint">Address</span>
        <code data-webhook-url className="min-w-0 flex-1 truncate font-mono text-foreground">{hook.url}</code>
        <button type="button" data-webhook-copy="url" onClick={() => copy("url", hook.url)} className="pressable flex h-6 items-center gap-1 px-1.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground">
          {copied === "url" ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {copied === "url" ? "Copied" : "Copy"}
        </button>
      </div>
      {hook.secret ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-14 shrink-0 text-faint">Secret</span>
          <code data-webhook-secret className="min-w-0 flex-1 truncate font-mono text-foreground">{hook.secret}</code>
          <button type="button" data-webhook-copy="secret" onClick={() => copy("secret", hook.secret ?? "")} className="pressable flex h-6 items-center gap-1 px-1.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground">
            {copied === "secret" ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            {copied === "secret" ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
      <p data-webhook-signing className="text-faint">
        The sender signs each delivery: <code className="font-mono text-muted-foreground">Mako-Timestamp</code> (Unix seconds), <code className="font-mono text-muted-foreground">Mako-Delivery</code> (its own ID, one per delivery), and <code className="font-mono text-muted-foreground">Mako-Signature: v1=</code> the hex HMAC-SHA256, under the secret, of <code className="font-mono text-muted-foreground">timestamp.delivery.body</code>.
      </p>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-faint">{hook.secret ? "Shown this once: give it to the sender now. Your cloud account keeps it sealed." : "Its secret was shown when it was made. Rotate for a new one; the old one stops working."}</span>
        <button type="button" data-webhook-rotate disabled={busy} onClick={() => void ask(true)} className="pressable flex h-6 shrink-0 items-center gap-1 px-1.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground disabled:opacity-50">
          <RotateCwIcon className="size-3" />
          Rotate secret
        </button>
      </div>
    </div>
  )
}

/** "Only if …": the sentence a fast model holds each event to before a run starts. */
function RunWhen({ value, onChange }: { value: string | undefined; onChange: (next: string | undefined) => void }) {
  return (
    <label className="flex min-w-0 items-center gap-1.5 pl-[22px]">
      <span className="shrink-0 text-label text-faint">Only if</span>
      <input
        data-run-when
        className="h-7 min-w-0 flex-1 bg-transparent px-1 text-label text-foreground placeholder:text-faint focus:bg-raised focus:outline-none"
        placeholder="it's worth a run, in a sentence a fast model checks first (optional)"
        maxLength={500}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value ? event.target.value : undefined)}
      />
    </label>
  )
}

