import { useState, type KeyboardEvent } from "react"
import { toast } from "sonner"
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, PlusIcon, XIcon } from "lucide-react"
import type { ResolvedSetting, SessionSettings } from "@mako/sessions/settings"
import { FIN_RULE_CHARS, FIN_RULES_LIMIT, finPolicyNote, finTuningLine, finTuningWords, type FinPolicy, type FinRule, type FinTarget } from "@mako/host/contracts/fin-tuning"
import { ModelList, ModelOptionRows, ModelSummary, type ModelChoice } from "@/components/composer/agent-model-picker"
import { IconAction } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import type { HarnessProfile } from "@/lib/types"
import { harnessDefaults } from "@/state/composer-settings"
import { saveFinPolicy, useFinDefaults } from "@/state/fin-defaults"
import { SEA_MARK } from "@/lib/sea-mark"
import { targetLine } from "./agent-reads"

/** What people tend to write first: tapped, it becomes a rule to edit. */
const STARTERS = ["Anything that isn't frontend", "UI, CSS and visual polish", "Quick lookups and one-line fixes", "Reviews and second opinions"]

/**
 * The person's rules for which work goes to which harness and model, in their own words. Every Thread's agent reads
 * them before the person's next message once they change (`finPolicyNote`); an Apex follows the first that fits and
 * names it on the Fin. Tiles on a recessed ground, no rules drawn between them.
 */
export function FinRules({ order, profiles }: { order: readonly string[]; profiles: Readonly<Record<string, HarnessProfile>> }) {
  const policy = useFinDefaults((state) => state.reading?.policy)
  const [preview, setPreview] = useState(false)
  const [fresh, setFresh] = useState<string | undefined>(undefined)
  // A rule being written that has no words yet: the host keeps a rule only once it says what work it's for.
  const [draft, setDraft] = useState<FinRule | undefined>(undefined)
  const signedIn = order.filter((harness) => profiles[harness]?.available)
  if (!policy) return null
  const save = (next: FinPolicy) => void saveFinPolicy(next).catch((error: Error) => toast.error(error.message || "Your rules couldn't be saved. Try again."))
  const setRule = (index: number, rule: FinRule) => save({ ...policy, rules: policy.rules.map((each, at) => (at === index ? rule : each)) })
  const move = (index: number, by: number) => {
    const rules = [...policy.rules]
    const [rule] = rules.splice(index, 1)
    if (!rule) return
    rules.splice(index + by, 0, rule)
    save({ ...policy, rules })
  }
  const newRule = (when: string): FinRule => ({ id: crypto.randomUUID(), when, target: { harness: policy.otherwise?.harness ?? signedIn[0] ?? order[0] ?? "claude" } })
  const add = (when: string) => {
    const rule = newRule(when)
    setFresh(rule.id)
    save({ ...policy, rules: [...policy.rules, rule] })
  }
  const note = finPolicyNote(policy, (target) => targetLine(target, profiles))
  const full = policy.rules.length + (draft ? 1 : 0) >= FIN_RULES_LIMIT

  return (
    <section className="flex flex-col gap-3" aria-label="Your rules for Fins">
      <div>
        <h3 className="text-ui font-medium">How your Apex picks</h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          Rules in your own words, top first. When an Apex starts a Fin, it follows the first one that fits and names it on
          the Fin. A harness or model you name in chat still wins.
        </p>
      </div>
      <div role="list" className="flex flex-col gap-px">
        {policy.rules.map((rule, index) => (
          <RuleRow
            key={rule.id}
            index={index}
            rule={rule}
            last={index === policy.rules.length - 1}
            focus={fresh === rule.id}
            profiles={profiles}
            signedIn={signedIn}
            onChange={(next) => setRule(index, next)}
            onMove={(by) => move(index, by)}
            onRemove={() => save({ ...policy, rules: policy.rules.filter((each) => each.id !== rule.id) })}
          />
        ))}
        {draft ? (
          <RuleRow
            key={draft.id}
            index={policy.rules.length}
            rule={draft}
            last
            focus
            profiles={profiles}
            signedIn={signedIn}
            onChange={(next) => {
              if (!next.when) return setDraft(next)
              setDraft(undefined)
              save({ ...policy, rules: [...policy.rules, next] })
            }}
            onMove={() => undefined}
            onRemove={() => setDraft(undefined)}
          />
        ) : null}
        <div role="listitem" className="flex items-center gap-3 bg-raised px-3 py-2.5">
          <span aria-hidden style={SEA_MARK} className="flex size-5 shrink-0 items-center justify-center text-label font-medium">∗</span>
          <span className="min-w-0 flex-1 text-ui text-muted-foreground">{policy.rules.length ? "When no rule fits" : "Every Fin, until you add a rule"}</span>
          <TargetPicker
            target={policy.otherwise}
            profiles={profiles}
            signedIn={signedIn}
            apexOwn
            onChoose={(target) => save({ ...policy, otherwise: target })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={full || draft !== undefined}
          onClick={() => setDraft(newRule(""))}
          className="pressable flex h-7 items-center gap-1.5 bg-fill-hover px-2.5 text-ui font-medium text-foreground/85 transition-colors duration-150 hover:bg-fill-selected disabled:opacity-50"
        >
          <PlusIcon className="size-3.5" />
          {full ? `${FIN_RULES_LIMIT} rules at most` : "Add a rule"}
        </button>
        {policy.rules.length === 0
          ? STARTERS.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => add(starter)}
                className="pressable h-7 px-2.5 text-ui text-muted-foreground transition-colors duration-150 hover:bg-fill-hover hover:text-foreground"
              >
                {starter}
              </button>
            ))
          : null}
        {note.length ? (
          <button
            type="button"
            aria-expanded={preview}
            onClick={() => setPreview((open) => !open)}
            className="pressable ml-auto flex h-7 items-center gap-1 px-2 text-label text-faint transition-colors duration-150 hover:text-muted-foreground"
          >
            What your Apex reads
            <ChevronDownIcon className={cn("size-3 transition-transform duration-150", preview && "rotate-180")} />
          </button>
        ) : null}
      </div>
      {preview && note.length ? (
        <pre data-fin-rules-preview className="bg-shell/55 px-3 py-2.5 font-mono text-label leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {note.join("\n")}
        </pre>
      ) : null}
    </section>
  )
}

function RuleRow({ index, rule, last, focus, profiles, signedIn, onChange, onMove, onRemove }: {
  index: number
  rule: FinRule
  last: boolean
  focus: boolean
  profiles: Readonly<Record<string, HarnessProfile>>
  signedIn: readonly string[]
  onChange(rule: FinRule): void
  onMove(by: number): void
  onRemove(): void
}) {
  const [text, setText] = useState(rule.when)
  const commit = () => {
    const when = text.trim()
    if (!when) {
      // A rule cleared and left empty keeps its words; one still being written waits for them, or its ✕.
      if (rule.when) setText(rule.when)
      return
    }
    if (when !== rule.when) onChange({ ...rule, when })
  }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.blur()
    }
    if (event.key === "Escape") {
      setText(rule.when)
      event.currentTarget.blur()
    }
  }
  return (
    <div role="listitem" data-fin-rule={index + 1} className="group/rule flex items-start gap-3 bg-raised px-3 py-2.5 transition-colors duration-150 focus-within:bg-fill-hover">
      <span aria-hidden className="mt-1 flex size-5 shrink-0 items-center justify-center bg-fill-selected text-label font-medium text-foreground/80 tabular">{index + 1}</span>
      <textarea
        aria-label={`Rule ${index + 1}: what work it's for`}
        value={text}
        rows={1}
        maxLength={FIN_RULE_CHARS}
        autoFocus={focus || !rule.when}
        placeholder="Describe the work, as you'd tell a teammate"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={keys}
        className="mt-0.5 min-h-6 min-w-0 flex-1 resize-none bg-transparent py-0.5 text-ui leading-snug text-foreground outline-none [field-sizing:content] placeholder:text-faint"
      />
      <div className="flex shrink-0 items-center gap-0.5">
        <span className="flex items-center opacity-0 transition-opacity duration-150 group-focus-within/rule:opacity-100 group-hover/rule:opacity-100">
          <IconAction size="xs" label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUpIcon />
          </IconAction>
          <IconAction size="xs" label="Move down" disabled={last} onClick={() => onMove(1)}>
            <ArrowDownIcon />
          </IconAction>
          <IconAction size="xs" label="Remove this rule" onClick={onRemove}>
            <XIcon />
          </IconAction>
        </span>
        <TargetPicker target={rule.target} profiles={profiles} signedIn={signedIn} onChoose={(target) => target && onChange({ ...rule, target })} />
      </div>
    </div>
  )
}

/**
 * Where a rule sends a Fin: a harness from the row of marks, then what the person uses there or a model of its own,
 * with its reasoning and speed, from that harness's catalog through the composer's picker. `apexOwn` offers the
 * Apex's own harness, which is what work no rule fits gets until the person picks.
 */
function TargetPicker({ target, profiles, signedIn, apexOwn = false, onChoose }: {
  target: FinTarget | undefined
  profiles: Readonly<Record<string, HarnessProfile>>
  signedIn: readonly string[]
  apexOwn?: boolean
  onChoose(target: FinTarget | undefined): void
}) {
  const [shown, setShown] = useState(target?.harness ?? signedIn[0])
  const profile = shown ? profiles[shown] : undefined
  const here = target && target.harness === shown ? target : undefined
  const { resolved, model, options } = harnessDefaults(shown ?? "", profile, here?.settings ? { source: "saved", settings: here.settings } : undefined)
  const choose = (settings: SessionSettings | undefined) => shown && onChoose({ harness: shown, ...(settings && { settings }) })
  const choice: ModelChoice = {
    harness: shown ?? "",
    models: profile?.models ?? [],
    model,
    options,
    resolved,
    chooseOption: (id, value) => choose({ ...resolved.settings, options: { ...resolved.settings.options, [id]: value } }),
    replaceModel: () => choose(undefined),
    source: (setting: ResolvedSetting) => (setting.kind !== "known" ? "The harness has not said" : setting.source === "saved" ? "This rule's choice" : "The model's default"),
  }
  const chooseModel = (id: string) => {
    const next = profile?.models.find((entry) => entry.id === id)
    const carried = Object.fromEntries(Object.entries(here?.settings?.options ?? {}).filter(([option]) => next?.options.some((entry) => entry.id === option && entry.role === "speed")))
    choose({ model: id, options: carried })
  }
  const words = target?.settings && finTuningWords(profiles[target.harness]?.models ?? [], target.settings)
  const summary: ModelChoice | undefined = target?.settings ? { ...choice, ...harnessDefaults(target.harness, profiles[target.harness], { source: "saved", settings: target.settings }), harness: target.harness } : undefined
  return (
    <Menu modal={false} onOpenChange={(open) => open && setShown(target?.harness ?? signedIn[0])}>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={target ? `Goes to ${harnessLabel(target.harness)}${words ? `, ${finTuningLine(words)}` : ""}` : "Goes to the Apex's own harness"}
          className={cn(
            "pressable flex h-7 max-w-[18rem] min-w-0 items-center gap-1.5 px-2 text-ui font-medium text-foreground/85",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "bg-fill-hover hover:bg-fill-selected data-[state=open]:bg-fill-selected"
          )}
        >
          {target ? <HarnessIcon harness={target.harness} className="size-3.5 shrink-0" /> : null}
          {target && summary ? (
            <ModelSummary choice={summary} label={words?.model ?? target.settings?.model ?? ""} />
          ) : (
            <span className="truncate">{target ? `${harnessLabel(target.harness)} · as you use it` : "The Apex's own harness"}</span>
          )}
          <ChevronDownIcon className="size-3 shrink-0 text-faint/70" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-[22rem]">
        <div role="group" aria-label="Harness" className="flex gap-0.5 px-1 pt-1 pb-1.5">
          {signedIn.map((harness) => (
            <MenuItem
              key={harness}
              aria-label={harnessLabel(harness)}
              aria-current={harness === shown || undefined}
              onSelect={(event) => {
                event.preventDefault()
                setShown(harness)
              }}
              className={cn("w-auto justify-center px-1.5", harness === shown && "bg-fill-selected")}
            >
              <HarnessIcon harness={harness} className="size-4" />
            </MenuItem>
          ))}
        </div>
        {apexOwn ? (
          <MenuItem onSelect={() => onChoose(undefined)}>
            <span className="flex-1 truncate">The Apex's own harness</span>
            {target ? null : <CheckIcon className="size-3.5 shrink-0" />}
          </MenuItem>
        ) : null}
        {shown ? (
          <>
            <MenuItem onSelect={() => choose(undefined)}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{harnessLabel(shown)}, as you use it</span>
                <span className="truncate text-label text-faint">The Apex's model there, or the one you last used</span>
              </span>
              {here && !here.settings ? <CheckIcon className="size-3.5 shrink-0" /> : null}
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>A model of its own</MenuLabel>
            <ModelList harness={shown} profile={profile} selected={here?.settings ? model?.id : undefined} onChoose={chooseModel} />
            {here?.settings ? <ModelOptionRows choice={choice} /> : null}
          </>
        ) : (
          <p className="px-2 py-1.5 text-label text-faint">Sign in to a harness in Settings › Agents to send work to it.</p>
        )}
      </MenuContent>
    </Menu>
  )
}
