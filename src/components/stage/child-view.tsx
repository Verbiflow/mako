import { useEffect } from "react"
import { ChevronLeftIcon, CircleStopIcon, XIcon } from "lucide-react"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { Action } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { ApexMark } from "@/components/ui/apex-mark"
import { acp, acpStore, activeAcp, useAcp } from "@/state/acp"
import { followCheckouts, useCheckoutHead } from "@/state/checkout-heads"
import { APEX_WORD, FIN_WORD } from "@mako/host/contracts/agents"
import { addressableFins, backToApex, childConversation, apexConversation, threadChildren, unaddress, useAddressee, useApexView, useThreadChildren, type FinInApex } from "@/state/apex-fins"
import { useOnScreen } from "@/state/thread-sessions"

/** The Fin open in place on screen, with its entry in its Apex's roster: nothing while anything else is shown. */
function useFinInApex(): { open: FinInApex; agent: NativeAgent | undefined } | null {
  const here = useOnScreen().thread
  const open = useApexView((state) => (state.open && state.open.child === here ? state.open : null))
  const agent = useAcp((state) => (open ? threadChildren(state, open.apex).find((entry) => entry.child?.thread === open.child) : undefined))
  return open ? { open, agent } : null
}

/**
 * Over a Fin opened in its Apex's Thread: back to the Apex, then the Fin's
 * harness, name, where it runs and its branch, and Stop while it works.
 */
export function ChildBreadcrumb() {
  const shown = useFinInApex()
  const child = shown?.open.child
  const cwd = useAcp((state) => (child ? childConversation(state, child)?.cwd : undefined))
  const elsewhere = useAcp((state) => (child ? childConversation(state, child)?.elsewhere : undefined))
  useEffect(() => {
    if (cwd) followCheckouts([cwd])
  }, [cwd])
  const head = useCheckoutHead(cwd)
  if (!shown) return null
  const { open, agent } = shown
  const branch = head && head.kind !== "detached" ? head.name : undefined
  const working = agent?.stoppable === true
  const stop = () => {
    const apex = apexConversation(acpStore.get(), open.apex)
    if (apex && agent) void acp.stopAgent(apex.key, agent.nativeId)
  }
  return (
    <nav aria-label="Thread" data-child-breadcrumb className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3 text-label whitespace-nowrap text-faint">
      <button
        type="button"
        onClick={backToApex}
        title={`Back to ${open.apexTitle}`}
        className="pressable flex h-6 shrink-0 items-center gap-1 rounded-md pr-1.5 pl-0.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground"
      >
        <ChevronLeftIcon className="size-3.5" />
        <ApexMark className="size-3" />
        {open.apexTitle}
      </button>
      <span aria-hidden className="shrink-0 text-faint/70">/</span>
      {agent ? <HarnessIcon harness={agent.provider} className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 truncate text-ui font-medium text-foreground">{agent?.title ?? FIN_WORD}</span>
      <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden pl-1">
        <span className="truncate">{elsewhere ? capitalized(elsewhere) : "This Mac"}</span>
        {branch ? <span className="truncate font-mono text-label">· {branch}</span> : null}
      </span>
      {working ? (
        <Action size="xs" className="ml-auto shrink-0" onClick={stop}>
          <CircleStopIcon />
          Stop
        </Action>
      ) : null}
    </nav>
  )
}

function capitalized(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Over the composer in an Apex's Thread: who a message goes to. On the Apex,
 * the Apex, which passes it on, or the Fin `@` or a routing line's Reply
 * chose, straight, with no turn of the Apex's; in a Fin open in place, that
 * Fin directly. Either way the Apex is told of it in its next note.
 */
export function ChildComposerNote() {
  const shown = useFinInApex()
  const here = useOnScreen().thread
  const fins = useThreadChildren(shown ? undefined : here)
  const conversation = useAcp((state) => (shown ? undefined : activeAcp(state)?.key))
  const addressee = useAddressee((state) => (conversation ? state.to[conversation] : undefined))
  const apexTitle = useAcp((state) => (conversation ? state.conversations[conversation]?.title : undefined))
  if (shown)
    return (
      <div data-child-note="fin" className="flex items-center gap-1.5 px-4 pt-2.5 text-label text-faint">
        <ApexMark className="size-3" />
        Straight to {shown.agent?.title ?? `this ${FIN_WORD}`} · {shown.open.apexTitle} sees what you said
      </div>
    )
  if (!fins.length) return null
  if (addressee && conversation)
    return (
      <div data-child-note="direct" data-addressee={addressee.name} className="flex min-w-0 items-center gap-1.5 px-4 pt-2.5 text-label text-faint">
        <span className="flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md bg-fill-hover pr-0.5 pl-2 text-ui text-foreground">
          <HarnessIcon harness={addressee.provider} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">To {addressee.title}</span>
          <button
            type="button"
            aria-label={`Write to ${apexTitle ?? `the ${APEX_WORD}`} instead`}
            title={`Write to ${apexTitle ?? `the ${APEX_WORD}`} instead`}
            onClick={() => unaddress(conversation)}
            className="pressable flex size-5 shrink-0 items-center justify-center rounded text-faint hover:text-foreground"
          >
            <XIcon className="size-3" />
          </button>
        </span>
        <span className="min-w-0 truncate">Straight · {apexTitle ?? `its ${APEX_WORD}`} sees what you said</span>
      </div>
    )
  return (
    <div data-child-note="apex" className="flex items-center gap-1.5 px-4 pt-2.5 text-label text-faint">
      <ApexMark className="size-3" />
      <span className="min-w-0 truncate">
        To the {APEX_WORD} · it passes it on to the right {FIN_WORD}
        {addressableFins(fins).length ? <>, or @ a {FIN_WORD} to write to it straight</> : null}
      </span>
    </div>
  )
}
