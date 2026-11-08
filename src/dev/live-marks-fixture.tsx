// The live mark's fixture page's pieces (`live-marks-check.tsx`); never imported by the application entry point.
import { LiveMark } from "@/components/ui/live-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { liveMarkWord, type LiveMarkKind, type LiveMarkState, type LiveMotion } from "@/lib/live-mark-state"
import { STATES } from "./live-marks-states"
import { cn } from "@/lib/utils"


function Row({ state, motion, kind, harness, title, end, lit, size }: { state: LiveMarkState; motion?: LiveMotion; kind?: LiveMarkKind; harness: string; title: string; end?: string; lit?: boolean; size?: number }) {
  return (
    <div data-active={lit || undefined} data-mark-row={state} className={cn("flex items-center gap-2 pr-2 pl-1.5", size ? "h-12" : "h-7", lit && "bg-raised")}>
      <LiveMark state={state} motion={motion} kind={kind} lit={lit} size={size} cut={lit ? "var(--raised)" : undefined}>
        <HarnessIcon harness={harness} />
      </LiveMark>
      <span className={cn("min-w-0 flex-1 truncate text-ui", lit ? "font-medium text-foreground" : "text-foreground/85")}>{title}</span>
      <span className={cn("shrink-0 text-label", end === "Needs you" ? "font-medium text-attention" : end === "Failed" ? "text-negative" : "tabular text-faint")}>{end}</span>
    </div>
  )
}

export function Legend() {
  return (
    <div className="flex gap-6 p-4">
      <section className="flex w-[276px] flex-col gap-px" data-fixture="rail">
        <h3 className="flex h-7 items-center px-2 text-label text-faint">Rail, 20 px</h3>
        {STATES.map((entry) => (
          <Row key={`${entry.state}:${entry.motion ?? ""}`} {...entry} />
        ))}
        <h3 className="mt-2 flex h-7 items-center px-2 text-label text-faint">The open Thread</h3>
        <Row {...STATES[0]!} lit />
        <Row {...STATES[3]!} lit />
      </section>
      <section className="flex w-[320px] flex-col gap-px" data-fixture="phone">
        <h3 className="flex h-7 items-center px-2 text-label text-faint">Phone, 28 px</h3>
        {STATES.map((entry) => (
          <Row key={`${entry.state}:${entry.motion ?? ""}`} {...entry} size={28} />
        ))}
      </section>
      <section className="flex flex-col gap-2" data-fixture="words">
        <h3 className="flex h-7 items-center px-2 text-label text-faint">Words</h3>
        {STATES.map((entry) => (
          <span key={`${entry.state}:${entry.motion ?? ""}`} className="flex h-7 items-center px-2 text-ui text-muted-foreground">
            {entry.motion ? `${liveMarkWord(entry.state)}: ${entry.motion}` : liveMarkWord(entry.state)}
          </span>
        ))}
      </section>
    </div>
  )
}

const BENCH_STATES: LiveMarkState[] = ["working", "working", "working", "background", "needs", "lead", "working", "starting", "idle", "unread"]
const HARNESSES = ["claude", "codex", "cursor", "grok", "opencode", "devin"]

export function Bench({ count, only }: { count: number; only?: LiveMarkState }) {
  return (
    <div data-fixture="bench" className="h-[600px] w-[276px] overflow-y-auto">
      {Array.from({ length: count }, (_, index) => (
        <Row key={index} state={only ?? BENCH_STATES[index % BENCH_STATES.length]!} harness={HARNESSES[index % HARNESSES.length]!} title={`Thread ${index + 1}`} end="2m" />
      ))}
    </div>
  )
}

