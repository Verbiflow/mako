import { memo, useEffect, useState, type ReactNode } from "react"
import { CheckIcon, CornerDownLeftIcon, RotateCcwIcon, XIcon } from "lucide-react"
import { approvalWords, childStateOf } from "@mako/host/contracts/children"
import { planQuestion } from "@mako/host/contracts/apexes"
import { ProposalBlock } from "@/components/automations/automation-proposal"
import { PlanQuestionAnswers } from "@/components/apexes/plan-question"
import { FinTypedAnswer } from "@/components/composer/fin-typed-answer"
import { harnessLabel } from "@/components/rail/harness-meta"
import { FinMark } from "@/components/stage/child-tabs"
import { ApexMark } from "@/components/ui/apex-mark"
import { IconAction, Keys } from "@/components/ui/kit"
import { ListRow, ROW_AGE, ROW_META, RowEnd } from "@/components/ui/list"
import { LiveMark } from "@/components/ui/live-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { ASK_TOUCH, runChoice, type AskCard as AskWords } from "@/lib/ask-card"
import { formatRelative, workspaceName } from "@/lib/format"
import { cn } from "@/lib/utils"
import { agentAskCard } from "@/state/agent-asks"
import { checkPlan, planKey, type PlanAsk } from "@/state/apexes"
import { automations, proposalById, useAutomations } from "@/state/automations"
import { answerFin, type FinAnswer } from "@/state/fin-asks"
import { answerApproval, openInboxItem, type AgentAskInboxItem, type ApprovalInboxItem, type FinInboxItem, type InboxAsk, type ReadInboxItem } from "@/state/inbox"
import { setupAskCard } from "@/state/setup"

/*
 * The Inbox's rows (`inbox-view.tsx`): an ask in two lines (where it is, then its question), its answers only while
 * it's the selected row, each with the number key that picks it; a line to read; a failed automation run.
 */

const BUTTON = "pressable flex h-7 items-center gap-1.5 px-2 text-label transition-colors disabled:opacity-50"
const PRIMARY = "bg-foreground text-background hover:opacity-90"
const QUIET = "bg-fill-hover text-foreground hover:bg-fill-selected"

/** An answer button with the number key that picks it (`data-inbox-choice`), the one to take first filled. */
function Choice({ n, primary, answer, disabled, title, onClick, children }: { n: number; primary?: boolean; answer: string | number; disabled: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" data-inbox-answer={answer} data-inbox-choice={n <= 9 ? n : undefined} title={title} disabled={disabled} onClick={onClick} className={cn(BUTTON, ASK_TOUCH, primary ? PRIMARY : QUIET)}>
      {n <= 9 ? <Keys keys={[String(n)]} inverted={primary} /> : null}
      {children}
    </button>
  )
}

/** The question as the row says it: the Fin's own words, not the state the mark and the section already say. */
function questionOf(item: InboxAsk): string {
  return item.kind === "fin" ? item.ask.question : item.question
}

/** Where the ask stands, after its Thread's title: the Apex, then the harness. */
function contextOf(item: InboxAsk): string {
  const apex = item.kind === "fin" || item.kind === "approval" ? item.apex?.title : undefined
  return [apex, item.harness ? harnessLabel(item.harness) : undefined].filter(Boolean).join(" · ")
}

/** What answering takes, for an ask that isn't selected: "3 choices", "approval". */
function hintOf(item: InboxAsk): string | undefined {
  if (item.kind === "fin") {
    if (item.ask.ask.kind === "approval") return "approval"
    const options = item.ask.ask.options?.length ?? 0
    return options ? `${options} ${options === 1 ? "choice" : "choices"}` : "your words"
  }
  if (item.kind === "approval") return item.answerable ? "approval" : undefined
  return undefined
}

function AskMark({ item }: { item: InboxAsk }) {
  if (item.kind === "fin") return <FinMark agent={item.agent} state={childStateOf(item.agent)} read />
  if (item.kind === "setup")
    return (
      <LiveMark state="needs" kind={item.ask.by.fin ? "fin" : "thread"} label="Needs you">
        {item.harness ? <HarnessIcon harness={item.harness} /> : null}
      </LiveMark>
    )
  return (
    <LiveMark state="needs" label={`Needs you in ${harnessLabel(item.harness)}`}>
      <HarnessIcon harness={item.harness} />
    </LiveMark>
  )
}

function OpenHint({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" data-inbox-open onClick={onOpen} className="pressable ml-auto flex h-7 shrink-0 items-center gap-1.5 px-1.5 text-label text-faint hover:bg-fill-hover hover:text-foreground">
      Open
      <CornerDownLeftIcon aria-hidden className="size-3" />
    </button>
  )
}

/**
 * One ask: its mark, its Thread's title, where it stands and its age; then the question on one line. Selected, the
 * question opens to four lines and its answers come under it; 1–9 pick one (`inbox-view.tsx` presses the button).
 */
export const AskRow = memo(function AskRow({ item, selected, onSelect }: { item: InboxAsk; selected: boolean; onSelect: (key: string) => void }) {
  const [sending, setSending] = useState(false)
  const settle = (sent: Promise<boolean>) => {
    setSending(true)
    void sent.then((landed) => {
      if (!landed) setSending(false)
    })
  }
  const hint = selected ? undefined : hintOf(item)
  const context = contextOf(item)
  return (
    <ListRow
      rowKey={item.key}
      selected={selected}
      data-inbox-item={item.key}
      data-inbox-kind={item.kind}
      data-fin={item.kind === "fin" ? item.ask.fin : undefined}
      aria-busy={sending || undefined}
      aria-label={`${item.title}: ${questionOf(item)}`}
      onClick={() => onSelect(item.key)}
      className={cn("h-auto flex-col items-stretch gap-1 py-2", sending && "opacity-60")}
    >
      <div data-ask-head className="flex h-5 min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <AskMark item={item} />
        </span>
        <span className="min-w-0 shrink truncate text-ui font-medium text-foreground">{item.title}</span>
        {context ? <span className={cn(ROW_META, "shrink-[4]")}>{context}</span> : null}
        <span className={cn(ROW_AGE, "ml-auto w-12")}>{formatRelative(item.since)}</span>
      </div>
      <div className="flex min-w-0 items-start gap-2 pl-7">
        <p data-ask-question className={cn("min-w-0 flex-1 text-ui", selected ? "line-clamp-4 text-foreground" : "line-clamp-1 text-muted-foreground")}>
          {questionOf(item)}
        </p>
        {hint ? <span className="shrink-0 pt-px text-label text-faint">{hint}</span> : null}
      </div>
      {selected && item.kind === "fin" && item.ask.ask.action ? <p className="pl-7 text-label text-faint">{item.ask.ask.action}</p> : null}
      {selected ? (
        item.kind === "agent-ask" && item.ask.want.kind === "automation-proposal" ? (
          <ProposalAsk item={item} sending={sending} setSending={setSending} />
        ) : (
          <div data-ask-answers className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1 pl-7">
            {item.kind === "fin" ? (
              <FinAnswers item={item} sending={sending} send={(answer) => settle(answerFin(item.apex.conversation, item.ask, answer))} />
            ) : item.kind === "approval" && item.answerable ? (
              <ApprovalAnswers item={item} sending={sending} send={(option) => settle(answerApproval(item, option))} />
            ) : item.kind === "agent-ask" ? (
              <AskChoices card={agentAskCard(item.conversation, item.ask, harnessLabel(item.harness))} sending={sending} setSending={setSending} />
            ) : item.kind === "setup" ? (
              <AskChoices card={setupAskCard(item.folder, item.ask, item.away)} sending={sending} setSending={setSending} />
            ) : null}
            <OpenHint onOpen={() => openInboxItem(item)} />
          </div>
        )
      ) : null}
    </ListRow>
  )
})

/** An ask's answers as its card gives them: what can't be given here said first, the one to take filled. */
function AskChoices({ card, sending, setSending }: { card: AskWords; sending: boolean; setSending: (held: boolean) => void }) {
  return (
    <>
      {card.note ? <span className="text-label text-muted-foreground">{card.note}</span> : null}
      {card.choices.map((choice, index) => (
        <Choice key={choice.answer} n={index + 1} answer={choice.answer} primary={choice.primary} disabled={sending} onClick={() => void runChoice(choice, setSending)}>
          {choice.label}
        </Choice>
      ))}
    </>
  )
}

function FinAnswers({ item, sending, send }: { item: FinInboxItem; sending: boolean; send: (answer: FinAnswer) => void }) {
  if (item.ask.limit?.waiting) return <span className="text-label text-muted-foreground">Continues by itself. Open the Thread to use another account or harness now.</span>
  if (item.ask.ask.kind === "approval") {
    const words = approvalWords(item.ask.ask)
    return (
      <>
        <Choice n={1} answer="allow" primary disabled={sending} onClick={() => send({ allow: true })}>
          <CheckIcon className="size-3" />
          {words.allow}
        </Choice>
        <Choice n={2} answer="refuse" disabled={sending} onClick={() => send({ allow: false })}>
          <XIcon className="size-3" />
          {words.refuse}
        </Choice>
      </>
    )
  }
  const options = item.ask.ask.options ?? []
  return (
    <>
      {options.map((option, index) => {
        const recommended = index === item.ask.ask.recommended
        return (
          <Choice key={`${index}:${option.label}`} n={index + 1} answer={index} primary={recommended} title={option.detail} disabled={sending} onClick={() => send({ option: index })}>
            {option.label}
            {recommended ? <span className="opacity-60">Recommended</span> : null}
          </Choice>
        )
      })}
      <FinTypedAnswer title={item.ask.title} options={options.length} disabled={sending} onAnswer={(words) => send({ answer: words })} className="max-w-80 min-w-48" />
    </>
  )
}

function ApprovalAnswers({ item, sending, send }: { item: ApprovalInboxItem; sending: boolean; send: (option: string) => void }) {
  const primary = item.permission.options.find((option) => option.kind === "allow_once") ?? item.permission.options[0]
  return (
    <>
      {item.permission.options.map((option, index) => (
        <Choice key={option.optionId} n={index + 1} answer={option.kind ?? option.optionId} primary={option === primary} disabled={sending} onClick={() => send(option.optionId)}>
          {option.name}
        </Choice>
      ))}
    </>
  )
}

/**
 * An agent's automation proposal: what it changes, read from the proposal Automations holds, and decided as there
 * (`decide`, which settles its ask too). Until the proposal is read, the ask's own answers.
 */
function ProposalAsk({ item, sending, setSending }: { item: AgentAskInboxItem; sending: boolean; setSending: (held: boolean) => void }) {
  const want = item.ask.want.kind === "automation-proposal" ? item.ask.want : undefined
  const proposal = useAutomations((state) => (want ? proposalById(state, want.proposal) : undefined))
  useEffect(() => {
    if (want && !proposal) void automations.load(true)
  }, [want, proposal])
  const open = <OpenHint onOpen={() => openInboxItem(item)} />
  if (!proposal)
    return (
      <div data-ask-answers className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1 pl-7">
        <AskChoices card={agentAskCard(item.conversation, item.ask, harnessLabel(item.harness))} sending={sending} setSending={setSending} />
        {open}
      </div>
    )
  return (
    <div data-ask-answers data-inbox-proposal={proposal.id} className="flex min-w-0 flex-col pt-1 pl-7" onClick={(event) => event.stopPropagation()}>
      <ProposalBlock proposal={proposal} compact inThread actions={open} onDecide={(approve) => automations.decide(proposal.id, approve).then(Boolean)} />
    </div>
  )
}

/** A line of an Apex's plan that waits on the person: a question it asks, or their to-do. Answered as the plan is. */
export function PlanRow({ ask, selected, onSelect, onOpen }: { ask: PlanAsk; selected: boolean; onSelect: (key: string) => void; onOpen: () => void }) {
  const asked = planQuestion(ask.text)
  const key = planKey(ask)
  return (
    <ListRow
      rowKey={key}
      selected={selected}
      data-inbox-plan={ask.apex.name}
      data-inbox-plan-kind={asked ? "question" : "to-do"}
      onClick={() => onSelect(key)}
      className="h-auto flex-col items-stretch gap-1 py-2"
    >
      <div className="flex h-5 min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center text-attention">
          <ApexMark className="size-3.5" />
        </span>
        <span className="min-w-0 shrink truncate text-ui font-medium text-foreground">{ask.apex.name}</span>
        <span className={cn(ROW_META, "shrink-[4]")}>{asked ? "asks you" : "your to-do"}</span>
      </div>
      <p className={cn("pl-7 text-ui", selected ? "line-clamp-4 text-foreground" : "line-clamp-1 text-muted-foreground")}>{asked?.question ?? ask.text}</p>
      {selected ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1 pl-7">
          {asked ? (
            <PlanQuestionAnswers thread={ask.apex.thread} apexName={ask.apex.name} section={ask.section} index={ask.index} options={asked.options} />
          ) : (
            <Choice n={1} answer="done" primary disabled={false} onClick={() => void checkPlan(ask.apex.thread, ask.section, ask.index, true)}>
              <CheckIcon className="size-3" />
              Mark done
            </Choice>
          )}
          <OpenHint onOpen={onOpen} />
        </div>
      ) : null}
    </ListRow>
  )
}

/** A line to read: its mark, title, where it ran, how it ended, and its age; the age gives way to Mark read and Open. */
export function ReadRow({ item, selected, read, onSelect, onSettle }: { item: ReadInboxItem; selected: boolean; read?: boolean; onSelect: (key: string) => void; onSettle: () => void }) {
  const failed = item.kind === "failed"
  const where = item.open.kind === "ref" ? workspaceName(item.open.ref.cwd) : undefined
  return (
    <ListRow
      rowKey={item.key}
      selected={selected}
      data-inbox-item={item.key}
      data-inbox-kind={item.kind}
      data-inbox-read={read || undefined}
      onClick={() => {
        onSelect(item.key)
        openInboxItem(item)
      }}
      className="h-9"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <LiveMark state={read ? "idle" : failed ? "failed" : "unread"} label={read ? "Read" : failed ? "Failed" : "Answer to read"}>
          <HarnessIcon harness={item.harness} />
        </LiveMark>
      </span>
      <span className={cn("min-w-0 shrink truncate text-ui", read ? "text-muted-foreground" : "font-medium text-foreground")}>{item.title}</span>
      <span className={cn(ROW_META, "hidden shrink-[4] @md/list:block")}>{[where, harnessLabel(item.harness)].filter(Boolean).join(" · ")}</span>
      <span className={cn("min-w-0 flex-1 truncate text-label", failed && !read ? "text-negative/90" : "text-faint")}>{failed ? (item.detail ?? "Failed") : "Finished"}</span>
      <RowEnd
        className="w-14"
        age={<span className={ROW_AGE}>{formatRelative(item.at)}</span>}
        actions={
          read ? (
            <IconAction size="xs" label="Mark unread" keys={["U"]} data-inbox-unread onClick={onSettle}>
              <RotateCcwIcon />
            </IconAction>
          ) : (
            <IconAction size="xs" label="Mark read" keys={["E"]} data-inbox-settle onClick={onSettle}>
              <CheckIcon />
            </IconAction>
          )
        }
      />
    </ListRow>
  )
}

/** An automation whose newest run failed since Automations was last opened: its name and why, opening its page. */
export function AutomationFailRow({ rowKey, name, why, at, selected, onSelect, onOpen }: { rowKey: string; name: string; why?: string; at: number; selected: boolean; onSelect: (key: string) => void; onOpen: () => void }) {
  return (
    <ListRow
      rowKey={rowKey}
      selected={selected}
      data-inbox-item={rowKey}
      data-inbox-kind="automation"
      onClick={() => {
        onSelect(rowKey)
        onOpen()
      }}
      className="h-9"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <LiveMark state="failed" label="Failed" />
      </span>
      <span className="min-w-0 shrink truncate text-ui font-medium text-foreground">{name}</span>
      <span className={cn(ROW_META, "hidden shrink-[4] @md/list:block")}>Automation</span>
      <span className="min-w-0 flex-1 truncate text-label text-negative/90">{why ?? "Failed"}</span>
      <span className={cn(ROW_AGE, "w-14")}>{formatRelative(at)}</span>
    </ListRow>
  )
}
