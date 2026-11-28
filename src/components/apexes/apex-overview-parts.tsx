import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { CheckIcon, ChevronRightIcon, MessageCircleQuestionIcon, PencilLineIcon, XIcon } from "lucide-react"
import { PlanQuestionAnswers } from "@/components/apexes/plan-question"
import { FIN_WORD } from "@mako/host/contracts/agents"
import { APEX_PURPOSE_CHARS, DIGEST_HEADINGS, RULE_LAYER_CHARS, parsePlan, planQuestion, type ApexEntry, type Plan, type ApexRulesReading, type DigestItem, type Memory, type RuleLayer, type RulePart } from "@mako/host/contracts/apexes"
import { stoodFor } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { OverviewHeading } from "@/components/inspector/apex-overview"
import { LastKnownLine } from "@/components/apexes/last-known"
import { useTickingText } from "@/components/ui/second-clock"
import { FIELD, Segmented } from "@/components/ui/kit"
import { roughTokens } from "@/lib/role-rules"
import { cn } from "@/lib/utils"
import { useRailAcp, threadChildren } from "@/state/acp-state"
import { checkPlan, forgetMemory, markSeen, readPlan, readRules, savePlan, saveRule, updateApex, useApexDigest, useApexElsewhere, useApexes, useSeenSince, type ApexElsewhere } from "@/state/apexes"
import { toggleOverviewFold, toggleOverviewOpened, useOverviewFolds, foldKey } from "@/state/apex-overview"

/** Escape puts back what's saved; ⌘↩ saves. */
function editKeys(save: () => void, cancel: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !(event.currentTarget instanceof HTMLTextAreaElement))) {
      event.preventDefault()
      save()
    }
  }
}

/**
 * A deliberate Apex's name and what it covers, at the top of its Overview: each its own field in place, saved on
 * Enter or leaving it, Escape putting it back.
 */
export function ApexHeader({ apex }: { apex: ApexEntry }) {
  const elsewhere = useApexElsewhere(apex.thread)
  if (elsewhere) return <ApexElsewhereHeader apex={apex} elsewhere={elsewhere} />
  // Each field starts over from what the host says once it says something new.
  return <ApexFields key={`${apex.name}\n${apex.purpose ?? ""}`} apex={apex} />
}

/**
 * An Apex another device keeps, as a browser shows it: its name and purpose as that device lists them, which are its
 * to change, and while it's quiet, that this is the last it said and since when.
 */
function ApexElsewhereHeader({ apex, elsewhere }: { apex: ApexEntry; elsewhere: ApexElsewhere }) {
  const folder = apex.folder?.split("/").filter(Boolean).at(-1)
  return (
    <div data-apex-header data-apex-elsewhere={elsewhere.device} className="flex flex-col gap-0.5 px-2 pt-2 pb-3">
      <span data-apex-name className="min-w-0 truncate text-title font-semibold text-foreground">{apex.name}</span>
      {apex.purpose ? <span data-apex-purpose className="text-ui leading-snug text-muted-foreground">{apex.purpose}</span> : null}
      <span className="pt-1 text-label text-faint">{[folder, `on ${elsewhere.device}`].filter(Boolean).join(" · ")}</span>
      {elsewhere.quietSince ? <LastKnownLine device={elsewhere.device} since={elsewhere.quietSince} /> : null}
    </div>
  )
}


function ApexFields({ apex }: { apex: ApexEntry }) {
  const [name, setName] = useState(apex.name)
  const [purpose, setPurpose] = useState(apex.purpose ?? "")
  const saveName = () => {
    const next = name.trim()
    if (!next) return setName(apex.name)
    if (next !== apex.name) void updateApex(apex.thread, { name: next })
  }
  const savePurpose = () => {
    const next = purpose.trim()
    if (next !== (apex.purpose ?? "")) void updateApex(apex.thread, { purpose: next || null })
  }
  const folder = apex.folder?.split("/").filter(Boolean).at(-1)
  const run = apex.fins?.run?.startsWith("device:") ? `on ${apex.fins.run.slice("device:".length)}` : "here"
  return (
    <div data-apex-header className="flex flex-col gap-0.5 px-2 pt-2 pb-3">
      <input
        aria-label="Name"
        data-apex-name
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={saveName}
        onKeyDown={editKeys(() => leaveField(), () => setName(apex.name))}
        className="-mx-1 min-w-0 bg-transparent px-1 text-title font-semibold text-foreground outline-none hover:bg-fill-hover focus:bg-raised"
      />
      <textarea
        aria-label="What it covers"
        data-apex-purpose
        rows={1}
        value={purpose}
        maxLength={APEX_PURPOSE_CHARS}
        placeholder="Say what it covers, in a line"
        onChange={(event) => setPurpose(event.target.value.replace(/\n/g, " "))}
        onBlur={savePurpose}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            leaveField()
          } else if (event.key === "Escape") {
            event.preventDefault()
            setPurpose(apex.purpose ?? "")
            leaveField()
          }
        }}
        className="-mx-1 min-w-0 resize-none bg-transparent px-1 text-ui leading-snug text-muted-foreground outline-none [field-sizing:content] placeholder:text-faint hover:bg-fill-hover focus:bg-raised"
      />
      <span className="px-0 pt-1 text-label text-faint">{[folder, `${FIN_WORD}s run ${run}`].filter(Boolean).join(" · ")}</span>
    </div>
  )
}

/** Enter in a one-line field leaves it, which saves it. */
function leaveField(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

/** The plan as the Overview last read it, read once it's shown and kept by the host's `apex-plan`. */
function usePlan(apex: ApexEntry): string | undefined {
  const plan = useApexes((state) => state.plans[apex.thread])
  useEffect(() => {
    if (plan === undefined) void readPlan(apex.thread).catch(() => undefined)
  }, [apex.thread, plan])
  return plan
}

const isWaiting = (name: string) => /^waiting on\b/i.test(name)

/** A plan line that waits on the person, under Needs you: checked off here, it leaves the digest at once. */
export function PlanNeeds({ apex }: { apex: ApexEntry }) {
  const plan = usePlan(apex)
  // Its device quiet, nothing here reaches it: the lines stand as it last said them, to read.
  const quiet = useApexElsewhere(apex.thread)?.quietSince !== undefined
  const lines = useMemo(() => {
    if (!plan) return []
    return parsePlan(plan).sections.filter((section) => isWaiting(section.name)).flatMap((section) => section.items.map((item, index) => ({ section: section.name, index, item }))).filter((each) => !each.item.done)
  }, [plan])
  return (
    <>
      {lines.map(({ section, index, item }) => {
        const asked = planQuestion(item.text)
        // A question is answered, never ticked; anything else there is the person's to-do, ticked once done.
        return asked ? (
          <div key={`${section}:${index}`} data-plan-question className="flex flex-col gap-1.5 px-2 py-1.5">
            <span className="flex items-start gap-2">
              <span className="flex h-5 w-[1.125rem] shrink-0 items-center justify-center text-attention"><MessageCircleQuestionIcon className="size-3.5" /></span>
              <span className="min-w-0 flex-1 text-ui leading-snug font-medium text-foreground">{finWords(asked.question)}</span>
            </span>
            {quiet ? null : <PlanQuestionAnswers thread={apex.thread} apexName={apex.name} section={section} index={index} options={asked.options} className="pl-[1.625rem]" />}
          </div>
        ) : (
          <PlanRow key={`${section}:${index}`} text={item.text} done={false} {...(!quiet && { onCheck: (done: boolean) => void checkPlan(apex.thread, section, index, done) })} needs />
        )
      })}
    </>
  )
}

function PlanRow({ text, done, onCheck, needs = false }: { text: string; done: boolean; onCheck?: (done: boolean) => void; needs?: boolean }) {
  return (
    <div data-plan-item={onCheck ? (done ? "done" : "open") : "note"} data-plan-needs={needs || undefined} className="group/plan flex items-start gap-2 px-2 py-1">
      <span className="flex h-5 w-[1.125rem] shrink-0 items-center justify-center">
        {onCheck ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={done}
            aria-label={done ? `Mark not done: ${text}` : `Mark done: ${text}`}
            title={done ? "Mark not done" : "Mark done"}
            onClick={() => onCheck(!done)}
            className={cn("pressable flex size-3.5 items-center justify-center transition-colors duration-100", done ? "bg-fill-selected text-muted-foreground" : "bg-raised text-transparent hover:text-faint")}
          >
            <CheckIcon className="size-2.5" strokeWidth={3} />
          </button>
        ) : (
          <span className="size-1 rounded-full bg-faint" />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 text-ui leading-snug", done ? "text-faint" : needs ? "font-medium text-foreground" : "text-foreground/90")}>
        {needs ? <span className="mr-1.5 text-label font-normal text-attention">Your to-do</span> : null}
        {finWords(text)}
      </span>
    </div>
  )
}

/** "fin:login fix the crash" reads "login · fix the crash": the Fin's name quieter, before what it does. */
function finWords(text: string) {
  const found = /^fin:([\w.-]+)\s+(.*)$/.exec(text)
  if (!found) return text
  return (
    <>
      <span className="text-muted-foreground">{found[1]}</span>
      <span className="text-faint"> · </span>
      {found[2]}
    </>
  )
}

/**
 * What finished since the person last read the Overview, newest first. Read is when they leave it: what they saw here
 * isn't new the next time.
 */
export function NewSection({ apex, onOpen }: { apex: ApexEntry; onOpen?: (agent: NativeAgent) => void }) {
  const since = useSeenSince(apex.thread, apex.seenAt, markSeen)
  const digest = useApexDigest(apex, since)
  const fins = useRailAcp((state) => threadChildren(state, apex.thread))
  const key = foldKey(apex.thread, "new")
  const folded = useOverviewFolds((state) => Boolean(state.folded[key]))
  if (!digest.new.length) return null
  return (
    <div data-overview-section="new">
      <OverviewHeading id="new" label={DIGEST_HEADINGS.new} count={digest.new.length} folded={folded} onToggle={() => toggleOverviewFold(key)} />
      {folded ? null : digest.new.slice(0, 8).map((item) => <NewRow key={item.key} item={item} agent={fins.find((fin) => fin.child?.thread === item.fin?.thread)} onOpen={onOpen} />)}
    </div>
  )
}

function NewRow({ item, agent, onOpen }: { item: DigestItem; agent?: NativeAgent; onOpen?: (agent: NativeAgent) => void }) {
  const when = useTickingText(item.at !== undefined, (now) => (item.at ? stoodFor(now - item.at) : ""))
  return (
    <button
      type="button"
      data-digest-new={item.kind}
      onClick={() => agent && onOpen?.(agent)}
      className="pressable flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-fill-hover"
    >
      <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", item.kind === "failed" ? "bg-negative" : "bg-positive")} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui text-foreground">{item.fin?.title}</span>
          {when ? <span className="shrink-0 text-label text-faint">{when} ago</span> : null}
        </span>
        <span className="line-clamp-2 text-label text-muted-foreground">{item.kind === "failed" ? `Failed: ${item.line}` : item.line}</span>
      </span>
    </button>
  )
}

/**
 * The Apex's plan, its six sections as it keeps them: items checked in place, the whole edited as text. It's the
 * Apex's to keep true; what the person changes here it reads at its next turn.
 */
export function PlanSection({ apex }: { apex: ApexEntry }) {
  const plan = usePlan(apex)
  // Another device's plan is its to write: a browser checks its lines while that device answers, and edits none.
  const elsewhere = useApexElsewhere(apex.thread)
  const [editing, setEditing] = useState<string | null>(null)
  const key = foldKey(apex.thread, "plan")
  const folded = useOverviewFolds((state) => Boolean(state.folded[key]))
  const parsed = useMemo(() => (plan ? parsePlan(plan) : undefined), [plan])
  const sections = parsed?.sections.filter((section) => !isWaiting(section.name) && (section.items.length || section.text)) ?? []
  const empty = !sections.length && !(parsed?.sections.some((section) => isWaiting(section.name) && section.items.length))
  const save = async () => {
    if (editing === null) return
    if (await savePlan(apex.thread, editing)) setEditing(null)
  }
  return (
    <div data-overview-section="plan">
      <div className="flex items-center">
        <div className="min-w-0 flex-1">
          <OverviewHeading id="plan" label="Plan" count={sections.reduce((sum, section) => sum + section.items.filter((item) => !item.done).length, 0)} folded={folded} onToggle={() => toggleOverviewFold(key)} />
        </div>
        {editing === null && !elsewhere ? (
          <button type="button" data-plan-edit title="Edit the plan" onClick={() => setEditing(plan ?? "")} className="pressable mr-1 flex size-6 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground">
            <PencilLineIcon className="size-3" />
          </button>
        ) : null}
      </div>
      {folded ? null : editing !== null ? (
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          <textarea
            data-plan-text
            autoFocus
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={editKeys(() => void save(), () => setEditing(null))}
            className={cn(FIELD, "h-auto min-h-48 resize-none py-2 font-mono text-label leading-relaxed [field-sizing:content]")}
          />
          <div className="flex items-center gap-2 text-label text-faint">
            <span>⌘↩ saves · Esc puts it back</span>
            <button type="button" onClick={() => void save()} className="pressable ml-auto px-2 py-0.5 text-foreground hover:bg-fill-hover">Save</button>
          </div>
        </div>
      ) : empty ? (
        <p data-plan-empty className="px-2 pb-2 text-label text-faint">{apex.name} writes its plan as it works: what's on now, what waits on you, what's decided.</p>
      ) : (
        sections.map((section) => <PlanSectionRows key={section.name} thread={apex.thread} section={section} checks={!elsewhere?.quietSince} />)
      )}
      {elsewhere?.planCut && !folded ? <p data-plan-cut className="px-2 pb-2 text-label text-faint">The rest of the plan is on {elsewhere.device}.</p> : null}
    </div>
  )
}

/**
 * One section of the plan, every section alike: what's open, prominent, then what's done folded into a quiet "N done"
 * that opens in place, as the Fins' list folds its finished ones. Notes (a file, a decision) are bullets.
 */
function PlanSectionRows({ thread, section, checks = true }: { thread: string; section: Plan["sections"][number]; checks?: boolean }) {
  const key = foldKey(thread, `plan:${section.name}`)
  const opened = useOverviewFolds((state) => Boolean(state.opened[key]))
  // What's decided is a record, never a to-do: every line of it stands, as a note, ticked or not.
  const decided = /^decided$/i.test(section.name)
  const rows = section.items.map((item, index) => ({ item: decided ? { ...item, done: false, note: true as const } : item, index }))
  const open = rows.filter(({ item }) => !item.done)
  const done = rows.filter(({ item }) => item.done)
  const row = ({ item, index }: { item: Plan["sections"][number]["items"][number]; index: number }) => (
    <PlanRow
      key={`${index}:${item.text}`}
      text={item.text}
      done={item.done}
      {...(!item.note && checks && { onCheck: (next: boolean) => void checkPlan(thread, section.name, index, next) })}
    />
  )
  return (
    <div data-plan-section={section.name} className="pb-1">
      <span className="block px-2 pt-1.5 pb-0.5 text-label text-faint">{section.name}</span>
      {open.map(row)}
      {done.length ? (
        <button
          type="button"
          data-plan-done={done.length}
          aria-expanded={opened}
          onClick={() => toggleOverviewOpened(key)}
          className="pressable flex h-7 w-full items-center gap-1 px-2 pl-[2.125rem] text-left text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
        >
          <ChevronRightIcon className={cn("size-3 transition-transform duration-150", opened && "rotate-90")} />
          {done.length} done
        </button>
      ) : null}
      {opened ? done.map(row) : null}
      {section.text ? <p className="px-2 text-label whitespace-pre-wrap text-muted-foreground">{section.text}</p> : null}
    </div>
  )
}

const FIT_WORDS = { cut: "Cut to fit", "left-out": "Left out to fit" } as const

/**
 * The rules an Apex and its Fins read, layer by layer, most general first: each with who reads it, its size and what
 * was cut to fit, and its words edited in place. Preview as the Apex, or as one of its Fins, which reads its Fins'
 * rules and never its own.
 */
export function RulesSection({ apex }: { apex: ApexEntry }) {
  // An Apex's rules stay on the device that keeps it: another device's window has none of them to show.
  if (useApexElsewhere(apex.thread)) return null
  return <OwnRulesSection apex={apex} />
}

function OwnRulesSection({ apex }: { apex: ApexEntry }) {
  const [as, setAs] = useState<"apex" | "fin">("apex")
  const [reading, setReading] = useState<ApexRulesReading | undefined>()
  const changed = useApexes((state) => state.rulesAt)
  const key = foldKey(apex.thread, "rules")
  // Rules are read less than the rest: folded until the person opens them, and kept open while the window is.
  const folded = useOverviewFolds((state) => !state.opened[key])
  useEffect(() => {
    let live = true
    void readRules(apex.thread, as).then((read) => live && setReading(read))
    return () => {
      live = false
    }
  }, [apex.thread, as, changed])
  const sent = reading?.parts.reduce((sum, part) => sum + part.sent, 0) ?? 0
  const whole = reading ? [reading.role, ...reading.parts.map((part) => part.text)].filter(Boolean).join("\n\n") : ""
  return (
    <div data-overview-section="rules">
      <OverviewHeading id="rules" label="Rules" count={reading?.parts.filter((part) => part.text).length ?? 0} folded={folded} onToggle={() => toggleOverviewOpened(key)} />
      {folded || !reading ? null : (
        <div className="flex flex-col pb-2">
          <div className="flex items-center gap-2 px-2 pt-0.5 pb-1.5">
            <span className="text-label text-faint">Preview as</span>
            <Segmented label="Preview as" value={as} onChange={setAs} options={[{ value: "apex", label: apex.name }, { value: "fin", label: `One of its ${FIN_WORD}s` }]} />
          </div>
          {reading.role ? <RoleLine as={as} text={reading.role} /> : null}
          {reading.parts.map((part) => (
            <LayerRow key={part.layer} part={part} words={reading.texts[part.layer] ?? ""} memories={reading.memories.filter((memory) => memoryLayer(memory) === part.layer)} at={{ thread: apex.thread, ...(reading.folder && { folder: reading.folder }) }} />
          ))}
          <p data-rules-total className="px-2 pt-1.5 text-label text-faint tabular">
            {sent.toLocaleString("en")} of {reading.budget.toLocaleString("en")} characters · {roughTokens(whole)}
          </p>
        </div>
      )}
    </div>
  )
}

function memoryLayer(memory: Memory): RuleLayer {
  return memory.scope
}

/** Settings › Fins' rules for every Apex or every Fin: their own line, shown here read-only. */
function RoleLine({ as, text }: { as: "apex" | "fin"; text: string }) {
  return (
    <div className="flex flex-col px-2 py-1.5">
      <span className="text-ui text-foreground">{as === "apex" ? "Every Apex" : `Every ${FIN_WORD}`}</span>
      <span className="text-label text-faint">From Settings › Fins</span>
      <span className="mt-1 line-clamp-3 text-label whitespace-pre-wrap text-muted-foreground">{text}</span>
    </div>
  )
}

function LayerRow({ part, words, memories, at }: { part: RulePart; words: string; memories: Memory[]; at: { thread?: string; folder?: string } }) {
  const [editing, setEditing] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const save = async () => {
    if (editing === null) return
    if (editing.trim() === words.trim() || (await saveRule(part.layer, editing, at))) setEditing(null)
  }
  const size = part.chars ? [`${part.chars.toLocaleString("en")} characters`, part.memories ? (part.memories === 1 ? "1 lesson" : `${part.memories} lessons`) : undefined].filter(Boolean).join(" · ") : "None yet"
  return (
    <div data-rule-layer={part.layer} data-rule-fit={part.fit} className="group/layer flex flex-col">
      <button type="button" aria-expanded={editing !== null} onClick={() => setEditing((now) => (now === null ? words : now))} className="pressable flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-fill-hover">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-ui text-foreground">{part.label}</span>
            {part.fit ? <span className="shrink-0 text-label font-medium text-caution">{FIT_WORDS[part.fit]}</span> : null}
          </span>
          <span className="truncate text-label text-faint">{part.audience}</span>
          {editing === null && part.text ? <span className="mt-1 line-clamp-2 text-label whitespace-pre-wrap text-muted-foreground">{part.text}</span> : null}
        </span>
        <span className={cn("shrink-0 pt-0.5 text-label tabular", part.chars ? "text-faint" : "text-faint/70")}>{size}</span>
      </button>
      {editing !== null ? (
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          <textarea
            ref={field}
            autoFocus
            data-rule-text={part.layer}
            value={editing}
            maxLength={RULE_LAYER_CHARS}
            placeholder={PLACEHOLDERS[part.layer]}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={editKeys(() => void save(), () => setEditing(null))}
            className={cn(FIELD, "h-auto min-h-20 resize-none py-2 leading-snug [field-sizing:content]")}
          />
          <div className="flex items-center gap-2 text-label text-faint">
            <span>⌘↩ saves · Esc puts it back</span>
            <button type="button" onClick={() => void save()} className="pressable ml-auto px-2 py-0.5 text-foreground hover:bg-fill-hover">Save</button>
          </div>
          {memories.length ? (
            <div className="flex flex-col pt-1">
              <span className="text-label text-faint">Remembered</span>
              {memories.map((memory) => (
                <div key={memory.id} data-memory={memory.id} className="group/memory flex items-start gap-2 py-1">
                  <span className="min-w-0 flex-1 text-label text-muted-foreground"><span className="text-foreground/80">{memory.topic}:</span> {memory.lesson}</span>
                  <button type="button" title="Forget" aria-label={`Forget ${memory.topic}`} onClick={() => void forgetMemory(memory.id)} className="pressable flex size-5 shrink-0 items-center justify-center text-faint opacity-0 group-hover/memory:opacity-100 hover:text-foreground focus-visible:opacity-100">
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const PLACEHOLDERS = {
  you: "How you like work done, everywhere: tone, reviews, what never to do",
  "you-folder": "How you like work done in this folder",
  folder: "What every Thread here follows: commands, checks, conventions",
  apex: "What this Apex follows: what to report, what never to do",
  "apex-fins": "What every Fin of this Apex follows each turn",
} as const satisfies Record<RuleLayer, string>
