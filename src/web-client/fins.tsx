import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { CheckIcon, ChevronRightIcon, MinusIcon, PlusIcon } from "lucide-react"
import { errorMessage } from "@mako/host/contracts/error-message"
import { cloudWords, FIN_CEILING, FIN_CEILING_MAX, FIN_LIMIT_MAX, FIN_RULE_CHARS, FIN_RULES_LIMIT, finTuningLine, finTuningWords, resolveFinTuning, ROLE_RULES_CHARS, roleRulesPreview, type FinChoicesReading, type FinPolicy, type FinRule, type FinTarget, type RoleRules } from "@mako/host/contracts/fin-tuning"
import { ROLE_FIELDS, roughTokens } from "@/lib/role-rules"
import type { HarnessProfile } from "@mako/host/contracts/providers-acp"
import { modelByIdentity, optionDefault, settingsWithVariant, type ModelOption, type SessionSettings, type SettingValue } from "@mako/sessions/settings"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { WebHarnessIcon } from "./harness-icon"
import { WEB_HARNESSES, webHarnessLabel } from "./labels"
import { places, startable, type Place } from "./places"
import { Group, Row, Switch } from "./settings-rows"
import { Sheet, SheetScroll } from "./sheet"
import { macCall } from "./start"
import { SEA_MARK } from "@/lib/sea-mark"

type Mac = Extract<Place, { kind: "mac" }>

/**
 * Settings › Fins on the phone and the web: what each harness's Fins start on when their Apex names no model, as the
 * person's Mac they worked on last keeps it (`mako:fin-defaults`), with that Mac's own catalogs. The desk's Settings ›
 * Fins, in the touch layout.
 */
export function Fins() {
  const client = useWebClient()
  const list = useAccountList((state) => state)
  const mac = places(list, false).find((place): place is Mac => place.kind === "mac" && startable(place))
  const deviceId = mac?.deviceId
  const call = useMemo(
    () => (deviceId ? <Result,>(channel: string, args: readonly unknown[]) => macCall<Result>(client.gateway, client.deviceId, deviceId, channel, args) : undefined),
    [client, deviceId]
  )
  if (!mac || !call)
    return (
      <Group title="Fins" footer="Turn on a Mac of yours to choose what its Fins run on.">
        <Row label="What Fins run on" detail="Same as you, until a Mac is on" />
      </Group>
    )
  return <FinsGroup mac={mac.name} call={call} />
}

/** A call to the Mac whose Fins these are, as `macCall` makes one. */
export type MacCall = <Result>(channel: string, args: readonly unknown[]) => Promise<Result>

/** Each harness's Fins on one Mac: its choices and catalogs read from it, and each change written to it. */
export function FinsGroup({ mac, call, opened }: { mac: string; call: MacCall; opened?: string }) {
  const [reading, setReading] = useState<FinChoicesReading | undefined>(undefined)
  const [profiles, setProfiles] = useState<Record<string, HarnessProfile>>({})
  const [open, setOpen] = useState<string | undefined>(opened)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    call<FinChoicesReading>("mako:fin-defaults", []).then(
      (found) => current && setReading(found),
      (error) => current && setFailure(errorMessage({ error }))
    )
    for (const harness of WEB_HARNESSES)
      void call<HarnessProfile>("mako:harness-tuning", [harness, undefined, false]).then(
        (profile) => current && setProfiles((held) => ({ ...held, [harness]: profile })),
        () => undefined
      )
    return () => {
      current = false
    }
  }, [call])

  const choose = (harness: string, settings: SessionSettings | null) => {
    const before = reading
    if (before) {
      const chosen = { ...before.chosen }
      if (settings) chosen[harness] = settings
      else delete chosen[harness]
      setReading({ ...before, chosen })
    }
    call<FinChoicesReading>("mako:fin-default-choose", [harness, settings]).then(setReading, (error) => {
      setReading(before)
      toast.error(errorMessage({ error }))
    })
  }

  const savePolicy = (policy: FinPolicy) => {
    const before = reading
    if (before) setReading({ ...before, policy })
    call<FinChoicesReading>("mako:fin-policy-save", [policy]).then(setReading, (error) => {
      setReading(before)
      toast.error(errorMessage({ error }))
    })
  }

  const saveRoleRules = (role: RoleRules, text: string) => {
    const before = reading
    if (before) setReading({ ...before, policy: { ...before.policy, [role]: text || undefined } })
    call<FinChoicesReading>("mako:fin-role-rules-save", [role, text]).then(setReading, (error) => {
      setReading(before)
      toast.error(errorMessage({ error }))
    })
  }

  const save = (channel: string, value: number | null, next: FinChoicesReading) => {
    const before = reading
    setReading(next)
    call<FinChoicesReading>(channel, [value]).then(setReading, (error) => {
      setReading(before)
      toast.error(errorMessage({ error }))
    })
  }
  const setLimit = (limit: number | null) => {
    if (!reading) return
    const next = { ...reading }
    if (limit === null) delete next.limit
    else next.limit = limit
    save("mako:fin-limit-set", limit, next)
  }
  const setCeiling = (ceiling: number) => reading && save("mako:fin-ceiling-set", ceiling, { ...reading, ceiling })

  const signedIn = WEB_HARNESSES.filter((harness) => profiles[harness]?.available)
  const capacity = reading?.capacity
  const own = reading?.limit
  return (
    <>
      {reading && capacity ? (
        <Group title="Fins at once" footer="How many of your Fins run at the same time in each place, across every Apex. Past it, an Apex waits for one to end only when it asks to.">
          <Row
            label={mac}
            detail={own !== undefined ? `Your number · Auto would be ${capacity.auto}` : [capacity.pressure ?? capacity.why, ...capacity.measured ? [] : ["defaults so far"]].join(" · ")}
            end={
              <span className="flex shrink-0 items-center gap-2">
                <Switch label="Auto" on={own === undefined} onChange={(auto) => setLimit(auto ? null : capacity.atOnce)} />
                {own === undefined ? <span className="tabular w-7 text-center text-ui font-medium">{capacity.atOnce}</span> : <WebStepper label={`${mac}'s Fins at once`} value={own} most={FIN_LIMIT_MAX} onChange={setLimit} />}
              </span>
            }
          />
          {reading.cloud ? <Row label="Cloud" detail="A machine per Fin, so your plan sets it" end={<span className="shrink-0 text-ui text-faint">{cloudWords(reading.cloud)}</span>} /> : null}
          <Row label="Across every place" detail="A safety net over each place's own" end={<WebStepper label="Fins at once across every place" value={reading.ceiling ?? FIN_CEILING} most={FIN_CEILING_MAX} onChange={setCeiling} />} />
        </Group>
      ) : null}
      {reading ? <RulesGroup policy={reading.policy} profiles={profiles} signedIn={signedIn} onSave={savePolicy} {...(opened?.startsWith("rule:") && { opened: opened.slice(5) })} /> : null}
      {reading ? <RoleRulesGroups policy={reading.policy} target={(target) => targetWords(target, profiles)} onSave={saveRoleRules} /> : null}
      <Group
      title="Fins, per harness"
      footer={failure ?? `Once a harness is picked, the model it runs on when your rule or your words name none, on ${mac}. Same as you: the Apex's model on its own harness, else the one you last used there.`}
    >
      {signedIn.length === 0 ? <Row label="Asking your Mac…" /> : null}
      {signedIn.map((harness) => {
        const profile = profiles[harness]!
        const chosen = reading?.chosen[harness]
        const words = chosen ? finTuningWords(profile.models, chosen) : undefined
        return (
          <button key={harness} type="button" onClick={() => setOpen(harness)} className="web-row flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left">
            <WebHarnessIcon harness={harness} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-ui">{webHarnessLabel(harness)}</span>
              <span className={cn("block truncate text-label", chosen && !words ? "text-caution" : "text-faint")}>
                {chosen ? (words ? finTuningLine(words) : `${chosen.model} isn't listed anymore: same as you`) : "Same as you"}
              </span>
            </span>
            <ChevronRightIcon className="size-4 shrink-0 text-faint" />
          </button>
        )
      })}
      {open && profiles[open] ? (
        <FinSheet
          harness={open}
          profile={profiles[open]}
          chosen={reading?.chosen[open]}
          used={reading?.used[open]}
          onDismiss={() => setOpen(undefined)}
          onChoose={(settings) => choose(open, settings)}
        />
      ) : null}
    </Group>
    </>
  )
}

function FinSheet({ harness, profile, chosen, used, onDismiss, onChoose }: {
  harness: string
  profile: HarnessProfile
  chosen: SessionSettings | undefined
  used: SessionSettings | undefined
  onDismiss: () => void
  onChoose: (settings: SessionSettings | null) => void
}) {
  const label = webHarnessLabel(harness)
  const models = profile.models.filter((model) => !model.unavailable)
  const expanded = chosen ? settingsWithVariant(profile.models, chosen) : undefined
  const model = modelByIdentity(profile.models, expanded?.model)
  const elsewhere = resolveFinTuning({ label, models: profile.models, asked: {}, ...(used && { used }), ...(profile.settings && { recommended: profile.settings }) })
  const mine = !("refused" in elsewhere) && elsewhere.settings ? finTuningWords(profile.models, elsewhere.settings) : undefined
  const value = (option: ModelOption) => expanded?.options?.[option.id] ?? optionDefault(option)
  const set = (option: ModelOption, next: SettingValue) => model && onChoose({ model: model.id, options: { ...expanded?.options, [option.id]: next } })
  const reasoning = model?.options.find((option) => option.role === "reasoning" && !option.disabledReason && option.kind === "select")
  const speed = model?.options.find((option) => option.role === "speed" && !option.disabledReason)
  const fastValue = (on: boolean): SettingValue | undefined => !speed ? undefined : speed.kind === "boolean" ? on : speed.booleanValues ? (on ? speed.booleanValues.on : speed.booleanValues.off) : undefined
  const fast = speed !== undefined && value(speed) === fastValue(true)
  return (
    <Sheet open onDismiss={onDismiss} label={`${label}'s Fins`} tall>
      <h3 className="web-sheet-title">{label}'s Fins</h3>
      <SheetScroll className="flex flex-col gap-3 px-2 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        <button type="button" aria-pressed={!chosen} onClick={() => onChoose(null)} className="web-choice">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">Same as you</span>
            <span className="truncate text-label text-faint">Your Apex's model, or {mine ? finTuningLine(mine) : `${label}'s own default`}</span>
          </span>
          <CheckIcon aria-hidden className={cn("size-4 shrink-0", chosen && "invisible")} />
        </button>
        {model && reasoning?.kind === "select" ? (
          <div className="flex flex-col gap-1.5 px-2">
            <p className="text-label font-medium text-faint">Reasoning</p>
            <div role="radiogroup" aria-label="Reasoning" className="web-scroll flex gap-1.5 overflow-x-auto">
              {reasoning.values.map((choice) => (
                <button key={choice.value} type="button" role="radio" aria-checked={value(reasoning) === choice.value} onClick={() => set(reasoning, choice.value)} className="web-chip web-chip-tab shrink-0">
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {model && speed && fastValue(true) !== undefined ? (
          <div className="flex items-center gap-3 px-2">
            <span className="min-w-0 flex-1">
              <span className="block text-ui">Fast</span>
              <span className="block text-label text-faint">Quicker, and costs more</span>
            </span>
            <Switch on={fast} label="Fast" onChange={(on) => set(speed, fastValue(on)!)} />
          </div>
        ) : null}
        <div className="flex flex-col">
          <p className="px-2 pb-1 text-label font-medium text-faint">A model of its own</p>
          {models.map((each) => (
            <button key={each.id} type="button" aria-pressed={model?.id === each.id} onClick={() => onChoose({ model: each.id })} className="web-choice">
              <span className="min-w-0 flex-1 truncate">{each.label}</span>
              <CheckIcon aria-hidden className={cn("size-4 shrink-0", model?.id !== each.id && "invisible")} />
            </button>
          ))}
        </div>
      </SheetScroll>
    </Sheet>
  )
}

/**
 * The person's standing rules for every Fin and every Apex on the phone, one group each: their words, saved when the
 * field loses focus through the same host call as the desk's (`mako:fin-role-rules-save`), and the same toggle with
 * what they add to an agent's note (`roleRulesPreview`).
 */
export function RoleRulesGroups({ policy, target, onSave }: { policy: FinPolicy; target: (target: FinTarget) => string; onSave: (role: RoleRules, text: string) => void }) {
  return (
    <>
      {ROLE_FIELDS.map((field) => (
        <RoleRulesGroup key={field.role} {...field} policy={policy} target={target} onSave={onSave} />
      ))}
    </>
  )
}

function RoleRulesGroup({ role, label, description, placeholder, reads, policy, target, onSave }: (typeof ROLE_FIELDS)[number] & {
  policy: FinPolicy
  target: (target: FinTarget) => string
  onSave: (role: RoleRules, text: string) => void
}) {
  const saved = policy[role] ?? ""
  const [text, setText] = useState(saved)
  const [open, setOpen] = useState(false)
  const shown = roleRulesPreview(role, { ...policy, [role]: text.trim() || undefined }, target).join("\n")
  return (
    <Group title={label} footer={description}>
      <textarea
        aria-label={label}
        data-role-rules={role}
        value={text}
        rows={2}
        maxLength={ROLE_RULES_CHARS}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => text.trim() !== saved && onSave(role, text.trim())}
        className="min-h-14 w-full resize-none rounded-none bg-transparent px-4 py-3 text-ui leading-snug outline-none [field-sizing:content] placeholder:text-faint"
      />
      {shown ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)} className="web-row flex h-11 w-full items-center gap-3 px-4 text-left text-label text-faint">
          <span className="flex-1">{reads}</span>
          <ChevronRightIcon className={cn("size-4 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        </button>
      ) : null}
      {shown && open ? (
        <div data-role-preview={role} className="flex flex-col gap-1.5 px-4 py-3">
          <span className="text-label text-faint tabular">{roughTokens(shown)}</span>
          <pre className="font-mono text-label leading-relaxed whitespace-pre-wrap text-muted-foreground">{shown}</pre>
        </div>
      ) : null}
    </Group>
  )
}

/** What people tend to write first: tapped, it opens as a new rule to edit. */
const STARTERS = ["Anything that isn't frontend", "UI, CSS and visual polish", "Quick lookups and one-line fixes"]

/**
 * The person's rules on the phone: one row each, top first, its words and where it sends a Fin; a tap opens it in a
 * sheet to edit, move or remove; "When no rule fits" last. The desk's "How your Apex picks", in the touch layout.
 */
function RulesGroup({ policy, profiles, signedIn, onSave, opened }: {
  policy: FinPolicy
  profiles: Readonly<Record<string, HarnessProfile>>
  signedIn: readonly string[]
  onSave: (policy: FinPolicy) => void
  opened?: string
}) {
  // A rule's id, `new` with the words it starts from, or `otherwise`.
  const [open, setOpen] = useState<{ id: string; when?: string } | undefined>(opened ? { id: opened } : undefined)
  const editing = open && open.id !== "new" && open.id !== "otherwise" ? policy.rules.find((rule) => rule.id === open.id) : undefined
  const index = editing ? policy.rules.indexOf(editing) : -1
  const firstHarness = policy.otherwise?.harness ?? signedIn[0] ?? "claude"
  const close = () => setOpen(undefined)
  return (
    <Group title="How your Apex picks" footer="Rules in your own words, top first. When an Apex starts a Fin, it follows the first one that fits and names it on the Fin. A harness or model you name in chat still wins.">
      {policy.rules.map((rule, at) => (
        <button key={rule.id} type="button" data-fin-rule={at + 1} onClick={() => setOpen({ id: rule.id })} className="web-row flex min-h-14 w-full items-start gap-3 px-4 py-3 text-left">
          <span aria-hidden className="mt-0.5 flex size-5 shrink-0 items-center justify-center bg-fill-selected text-label font-medium tabular">{at + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-ui">{rule.when}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-label text-faint">
              <WebHarnessIcon harness={rule.target.harness} className="size-3.5 shrink-0" />
              <span className="truncate">{targetWords(rule.target, profiles)}</span>
            </span>
          </span>
          <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-faint" />
        </button>
      ))}
      <button type="button" onClick={() => setOpen({ id: "otherwise" })} className="web-row flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left">
        <span aria-hidden style={SEA_MARK} className="flex size-5 shrink-0 items-center justify-center text-label font-medium">∗</span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui text-muted-foreground">{policy.rules.length ? "When no rule fits" : "Every Fin, until you add a rule"}</span>
          <span className="block truncate text-label text-faint">{policy.otherwise ? targetWords(policy.otherwise, profiles) : "The Apex's own harness"}</span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-faint" />
      </button>
      {policy.rules.length < FIN_RULES_LIMIT ? (
        <div className="flex flex-col">
          <button type="button" onClick={() => setOpen({ id: "new" })} className="web-row flex h-12 w-full items-center gap-3 px-4 text-left text-ui">
            <PlusIcon className="size-4 text-muted-foreground" />
            Add a rule
          </button>
          {policy.rules.length === 0 ? (
            <div className="web-scroll flex gap-1.5 overflow-x-auto px-4 pb-3">
              {STARTERS.map((starter) => (
                <button key={starter} type="button" onClick={() => setOpen({ id: "new", when: starter })} className="web-chip web-chip-tab shrink-0">
                  {starter}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {open?.id === "otherwise" ? (
        <RuleSheet
          title="When no rule fits"
          target={policy.otherwise}
          apexOwn
          profiles={profiles}
          signedIn={signedIn}
          onDismiss={close}
          onDone={(_, target) => {
            onSave(target ? { ...policy, otherwise: target } : { rules: policy.rules })
            close()
          }}
        />
      ) : open?.id === "new" ? (
        <RuleSheet
          title="New rule"
          when={open.when ?? ""}
          done="Add"
          target={{ harness: firstHarness }}
          profiles={profiles}
          signedIn={signedIn}
          onDismiss={close}
          onDone={(when, target) => {
            if (when && target) onSave({ ...policy, rules: [...policy.rules, { id: crypto.randomUUID(), when, target }] })
            close()
          }}
        />
      ) : editing ? (
        <RuleSheet
          title={`Rule ${index + 1}`}
          when={editing.when}
          target={editing.target}
          profiles={profiles}
          signedIn={signedIn}
          onDismiss={close}
          onDone={(when, target) => {
            if (when && target) onSave({ ...policy, rules: policy.rules.map((rule) => (rule.id === editing.id ? { ...rule, when, target } : rule)) })
            close()
          }}
          {...(index > 0 && { onMoveUp: () => { onSave({ ...policy, rules: moved(policy.rules, index, -1) }); close() } })}
          {...(index < policy.rules.length - 1 && { onMoveDown: () => { onSave({ ...policy, rules: moved(policy.rules, index, 1) }); close() } })}
          onRemove={() => {
            onSave({ ...policy, rules: policy.rules.filter((rule) => rule.id !== editing.id) })
            close()
          }}
        />
      ) : null}
    </Group>
  )
}

function moved(rules: readonly FinRule[], index: number, by: number): FinRule[] {
  const next = [...rules]
  const [rule] = next.splice(index, 1)
  if (rule) next.splice(index + by, 0, rule)
  return next
}

/** A target in a row's words: the harness, then its model's words or "as you use it". */
function targetWords(target: FinTarget, profiles: Readonly<Record<string, HarnessProfile>>): string {
  const words = target.settings && finTuningWords(profiles[target.harness]?.models ?? [], target.settings)
  return `${webHarnessLabel(target.harness)} · ${words ? finTuningLine(words) : (target.settings?.model ?? "as you use it")}`
}

/**
 * One rule in a sheet: its words, then where it sends a Fin: a harness from the chips, "as you use it" or a model
 * of its own, with its reasoning and fast lane. Nothing is saved until Done.
 */
function RuleSheet({ title, when: start, done = "Done", target: initial, apexOwn = false, profiles, signedIn, onDismiss, onDone, onMoveUp, onMoveDown, onRemove }: {
  title: string
  when?: string
  done?: string
  target: FinTarget | undefined
  apexOwn?: boolean
  profiles: Readonly<Record<string, HarnessProfile>>
  signedIn: readonly string[]
  onDismiss: () => void
  onDone: (when: string, target: FinTarget | undefined) => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  onRemove?: () => void
}) {
  const [when, setWhen] = useState(start ?? "")
  const [target, setTarget] = useState<FinTarget | undefined>(initial)
  const worded = start === undefined || when.trim().length > 0
  const harness = target?.harness
  const profile = harness ? profiles[harness] : undefined
  const expanded = target?.settings ? settingsWithVariant(profile?.models ?? [], target.settings) : undefined
  const model = modelByIdentity(profile?.models ?? [], expanded?.model)
  const value = (option: ModelOption) => expanded?.options?.[option.id] ?? optionDefault(option)
  const set = (option: ModelOption, next: SettingValue) => harness && model && setTarget({ harness, settings: { model: model.id, options: { ...expanded?.options, [option.id]: next } } })
  const reasoning = model?.options.find((option) => option.role === "reasoning" && !option.disabledReason && option.kind === "select")
  const speed = model?.options.find((option) => option.role === "speed" && !option.disabledReason)
  const fastValue = (on: boolean): SettingValue | undefined => !speed ? undefined : speed.kind === "boolean" ? on : speed.booleanValues ? (on ? speed.booleanValues.on : speed.booleanValues.off) : undefined
  return (
    <Sheet open onDismiss={onDismiss} label={title} tall>
      <div className="flex items-center gap-2 pr-4">
        <h3 className="web-sheet-title flex-1">{title}</h3>
        <button type="button" disabled={!worded} onClick={() => onDone(when.trim(), target)} className="web-button h-9 rounded-none px-4">
          {done}
        </button>
      </div>
      <SheetScroll className="flex flex-col gap-4 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
        {start !== undefined ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-label font-medium text-faint">The work it's for</span>
            <textarea
              value={when}
              rows={3}
              maxLength={FIN_RULE_CHARS}
              autoFocus={!start}
              placeholder="Describe the work, as you'd tell a teammate"
              onChange={(event) => setWhen(event.target.value)}
              className="web-field min-h-20 w-full resize-none rounded-none py-2.5 leading-snug"
            />
          </label>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-medium text-faint">Goes to</span>
          <div role="radiogroup" aria-label="Harness" className="web-scroll -mx-4 flex gap-1.5 overflow-x-auto px-4">
            {apexOwn ? (
              <button type="button" role="radio" aria-checked={!target} onClick={() => setTarget(undefined)} className="web-chip web-chip-tab shrink-0">
                The Apex's own
              </button>
            ) : null}
            {signedIn.map((each) => (
              <button key={each} type="button" role="radio" aria-checked={harness === each} onClick={() => setTarget({ harness: each })} className="web-chip web-chip-tab shrink-0">
                <WebHarnessIcon harness={each} className="size-4" />
                {webHarnessLabel(each)}
              </button>
            ))}
          </div>
        </div>
        {harness ? (
          <div className="-mx-2 flex flex-col">
            <button type="button" aria-pressed={!target?.settings} onClick={() => setTarget({ harness })} className="web-choice">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">As you use it</span>
                <span className="truncate text-label text-faint">The Apex's model there, or the one you last used</span>
              </span>
              <CheckIcon aria-hidden className={cn("size-4 shrink-0", target?.settings && "invisible")} />
            </button>
            {(profile?.models ?? []).filter((each) => !each.unavailable).map((each) => (
              <div key={each.id} className={cn(model?.id === each.id && "bg-fill-hover")}>
                <button type="button" aria-pressed={model?.id === each.id} onClick={() => setTarget({ harness, settings: { model: each.id } })} className="web-choice">
                  <span className="min-w-0 flex-1 truncate">{each.label}</span>
                  <CheckIcon aria-hidden className={cn("size-4 shrink-0", model?.id !== each.id && "invisible")} />
                </button>
                {model?.id === each.id && reasoning?.kind === "select" ? (
                  <div role="radiogroup" aria-label={`${each.label}'s reasoning`} className="web-scroll flex gap-1.5 overflow-x-auto px-3 pb-2">
                    {reasoning.values.map((choice) => (
                      <button key={choice.value} type="button" role="radio" aria-checked={value(reasoning) === choice.value} onClick={() => set(reasoning, choice.value)} className="web-chip web-chip-tab shrink-0">
                        {choice.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {model?.id === each.id && speed && fastValue(true) !== undefined ? (
                  <div className="flex items-center gap-3 px-3 pb-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-ui">Fast</span>
                      <span className="block text-label text-faint">Quicker, and costs more</span>
                    </span>
                    <Switch on={value(speed) === fastValue(true)} label={`${each.label} on its fast lane`} onChange={(on) => set(speed, fastValue(on)!)} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {onMoveUp || onMoveDown || onRemove ? (
          <div className="flex items-center gap-2 pt-2">
            {onMoveUp ? <button type="button" onClick={onMoveUp} className="web-quiet-button h-10 rounded-none px-3">Move up</button> : null}
            {onMoveDown ? <button type="button" onClick={onMoveDown} className="web-quiet-button h-10 rounded-none px-3">Move down</button> : null}
            {onRemove ? <button type="button" onClick={onRemove} className="web-quiet-button ml-auto h-10 rounded-none px-3 text-negative">Remove</button> : null}
          </div>
        ) : null}
      </SheetScroll>
    </Sheet>
  )
}

function WebStepper({ label, value, most, onChange }: { label: string; value: number; most: number; onChange: (next: number) => void }) {
  return (
    <span role="group" aria-label={label} className="flex shrink-0 items-center gap-1">
      <button type="button" aria-label="One fewer" disabled={value <= 1} onClick={() => onChange(value - 1)} className="pressable flex size-9 items-center justify-center rounded-full text-muted-foreground disabled:opacity-40">
        <MinusIcon className="size-4" />
      </button>
      <output aria-live="polite" className="tabular w-7 text-center text-ui font-medium">{value}</output>
      <button type="button" aria-label="One more" disabled={value >= most} onClick={() => onChange(value + 1)} className="pressable flex size-9 items-center justify-center rounded-full text-muted-foreground disabled:opacity-40">
        <PlusIcon className="size-4" />
      </button>
    </span>
  )
}
