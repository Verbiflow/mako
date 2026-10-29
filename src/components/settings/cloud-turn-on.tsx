import { useEffect, useState, type ReactNode } from "react"
import { CheckIcon, ChevronRightIcon, CopyIcon, FileLockIcon, FolderGitIcon, LockIcon } from "lucide-react"
import { toast } from "sonner"
import type { CarriedFilesView } from "@mako/host/contracts/cloud-carried-files"
import { noAccess, type BaseStanding, type CloudTurnOn, type TurnOnStep } from "@mako/host/contracts/cloud-turn-on"
import { Action } from "@/components/ui/kit"
import { Collapse } from "@/components/ui/collapse"
import { MakoTile } from "@/components/ui/mako-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Shimmer } from "@/components/ui/shimmer"
import { Spinner } from "@/components/ui/spinner"
import { formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { decideCarriedFiles, readCarriedFiles, useCarriedFiles } from "@/state/carried-files"
import { useCloudAccount } from "@/state/cloud-account"
import { cloudTurnOn, stepOf, useCloudTurnOn } from "@/state/cloud-turn-on"
import { useThreads } from "@/state/thread-store"

/**
 * Mako Cloud in Settings › Account: one calm surface that says where the cloud stands and what it's doing, in the
 * person's words, with the one thing worth doing next. What happens by itself (this Mac's agent sign-ins carried
 * over, the projects set up, the last 7 days synced) is said as it goes, never as a checklist; only what needs the
 * person is asked, one thing at a time, as what to do. Each step's time and the cloud's own words are folded into
 * Details, for whoever is looking into it.
 */
export function TurnOnCard() {
  const turnOn = useCloudTurnOn((state) => state.turnOn)
  useEffect(() => cloudTurnOn.load(), [])
  if (!turnOn || turnOn.phase === "signed-out" || turnOn.phase === "unavailable") return null
  return <TurnOnSurface turnOn={turnOn} />
}

function TurnOnSurface({ turnOn }: { turnOn: CloudTurnOn }) {
  const said = useSummary(turnOn)
  const [details, setDetails] = useState(false)
  return (
    <section data-turn-on={turnOn.phase} className="rounded-2xl border border-hairline bg-raised/40 px-5 pt-5 pb-2">
      <div className="flex items-center gap-4">
        <CloudMark state={said.mark} />
        <div className="min-w-0 flex-1">
          <h3 data-turn-on-headline className="text-title font-medium tracking-[-0.01em] text-foreground">
            {said.headline}
          </h3>
          <p data-turn-on-now className="mt-1 text-ui leading-snug text-pretty text-muted-foreground">
            {said.going ? <Shimmer>{said.line}</Shimmer> : said.line}
          </p>
        </div>
        {said.action}
      </div>
      {said.needs ? <div className="mt-5 border-t border-hairline pt-4">{said.needs}</div> : null}
      <button
        type="button"
        onClick={() => setDetails(!details)}
        aria-expanded={details}
        data-turn-on-details-toggle
        className="pressable mt-3 -ml-1 flex items-center gap-1 rounded px-1 py-1 text-label text-faint hover:text-muted-foreground"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform duration-200 ease-[var(--ease-out)]", details && "rotate-90")} />
        Details
      </button>
      <Collapse open={details}>
        <Details turnOn={turnOn} />
      </Collapse>
    </section>
  )
}

/** `plain`: the sidebar's tile at full strength with no badge, its line saying the rest. */
type MarkState = "waiting" | "working" | "on" | "plain"

/**
 * Mako's own tile, wearing the cloud's state as an app icon wears a badge: turning while work goes, a check once it's
 * on, and nothing (the tile at rest) while the account waits for its invite.
 */
function CloudMark({ state, small }: { state: MarkState; small?: boolean }) {
  return (
    <span data-turn-on-mark={state} className={cn("relative shrink-0", small ? "size-[18px]" : "size-11")} aria-hidden>
      <MakoTile className={cn("size-full transition-opacity duration-300", state === "waiting" && "opacity-45 saturate-0")} />
      {state === "waiting" || state === "plain" ? null : (
        <span
          className={cn(
            "absolute flex items-center justify-center rounded-full shadow-xs",
            small ? "-right-0.5 -bottom-0.5 size-2" : "-right-1 -bottom-1 size-[18px]",
            state === "on" ? "bg-positive text-background" : "bg-background text-muted-foreground ring-1 ring-hairline"
          )}
        >
          {small ? null : state === "on" ? <CheckIcon className="size-[10px]" strokeWidth={3.2} /> : <Spinner className="size-[11px]" />}
        </span>
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* What the surface says                                               */
/* ------------------------------------------------------------------ */

type Summary = { headline: string; line: string; going: boolean; mark: MarkState; action?: ReactNode; needs?: ReactNode; short: string; needsShort?: string }

/** The headline, the one line, the action and what needs the person, read from the steps in the person's words. */
function useSummary(turnOn: CloudTurnOn): Summary {
  const names = useHarnessNames()
  const busy = useCloudTurnOn((state) => state.busy)
  const agents = stepOf(turnOn, "agents")
  const projects = stepOf(turnOn, "projects")
  const history = stepOf(turnOn, "history")
  const thread = stepOf(turnOn, "thread")
  const account = stepOf(turnOn, "account")
  const startFolder = turnOn.phase === "turning-on" ? undefined : thread?.folder
  const carried = useCarriedFiles((state) => (startFolder ? state.byFolder[startFolder] : undefined))
  const carriedBusy = useCarriedFiles((state) => (startFolder ? state.busy[startFolder] : undefined))
  useEffect(() => {
    if (startFolder) void readCarriedFiles(startFolder)
  }, [startFolder])

  if (turnOn.phase === "no-cloud")
    return {
      headline: "Mako Cloud",
      line: "Invite-only for now. Once you're invited, it turns on by itself.",
      going: false,
      mark: "waiting",
      short: "Waiting for your invite",
      action: (
        <Action tone="outline" size="md" disabled={busy === "check"} onClick={() => void cloudTurnOn.checkPlan()} data-turn-on-fix="check-plan">
          {busy === "check" ? <Spinner /> : null}
          {busy === "check" ? "Checking" : "Check for invite"}
        </Action>
      ),
    }

  // What's going on its own, in the order a person cares about it.
  const settingUp = projects?.state === "working" && projects.projects.length > 0
  const syncing = history?.state === "working" || history?.state === "stuck"
  const todayIn = history ? history.today.threads > 0 && history.today.inCloud === history.today.threads : false
  const firstThread = thread?.state === "done"
  const project = thread?.folder ? folderName(thread.folder) : undefined

  let headline: string
  let line: string
  let going = true
  if (turnOn.phase === "turning-on") {
    headline = "Getting your cloud ready"
    line = agents?.state === "working" ? "Bringing your agents over from this Mac…" : "Almost there…"
  } else {
    headline = firstThread ? "Mako Cloud is on" : "Mako Cloud is ready"
    const parts = [settingUp ? "setting up your projects" : undefined, syncing ? "syncing your last 7 days" : undefined].filter((part) => part !== undefined)
    if (thread?.machine === "ready" && project) line = `A machine is ready for ${project}. Your first message starts at once.`
    else if (thread?.machine === "warming" && project) line = `Warming up a machine for ${project}…`
    else if (parts.length) line = `${sentence(parts.join(" and "))}${syncing && todayIn ? ". Today's are already in." : "…"}`
    else {
      going = false
      line = projects?.projects.length || firstThread ? "Your agents, projects and last 7 days are in the cloud." : "Your agents and last 7 days are in the cloud."
    }
  }
  if (account?.state === "stuck") {
    line = "Offline. Mako reconnects by itself."
    going = false
  }

  const readyForThread = turnOn.phase !== "turning-on" && thread?.state === "yours" && thread.folder !== undefined
  const needs = whatNeedsYou(turnOn, names, thread?.folder, carried, carriedBusy)
  // One strong action at a time: when what needs the person has its own button, Start steps back.
  const action = readyForThread && thread?.folder ? <StartThread folder={thread.folder} quiet={needs?.acts ?? false} /> : undefined
  return {
    headline,
    line,
    going,
    mark: going || turnOn.phase === "turning-on" ? "working" : "on",
    action,
    needs: needs?.node,
    needsShort: needs?.short,
    short: turnOn.phase === "turning-on" ? line : readyForThread ? "Start your first cloud Thread" : line,
  }
}

/**
 * The one thing that needs the person now, if any, worded as what to do. An agent signed out on this Mac comes
 * first (cloud Threads use this Mac's sign-in, so signing in here is all it takes); then the project's files Git
 * leaves out, asked once; then a private project the cloud can't read yet: with a button to give Mako's GitHub App
 * access to it when that's what's missing, otherwise said plainly with nothing to press. What Mako retries by itself
 * is only in Details.
 */
function whatNeedsYou(
  turnOn: CloudTurnOn,
  names: (harness: string) => string,
  startFolder: string | undefined,
  carried: CarriedFilesView | undefined,
  carriedBusy: string | undefined
): { node: ReactNode; short: string; acts: boolean } | undefined {
  const agents = stepOf(turnOn, "agents")
  const signedOut = agents?.agents.find((agent) => agent.state === "stuck")
  if (signedOut) {
    const name = names(signedOut.harness)
    return {
      acts: true,
      short: `${name} is signed out`,
      node: (
        <NeedRow
          data="agent"
          icon={<HarnessIcon harness={signedOut.harness} />}
          title={`${name} is signed out on this Mac`}
          detail="Cloud Threads use the same sign-in as this Mac, so signing in here is all it takes."
          action={
            <Action tone="solid" size="sm" onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))} data-turn-on-fix="sign-in-agent">
              Sign in
            </Action>
          }
        />
      ),
    }
  }
  const projects = stepOf(turnOn, "projects")
  const latest = projects?.projects[0]
  if (latest && noAccess(latest.base)) {
    const name = repositoryName(latest.repository)
    const instead = startFolder ? ` Your first cloud Thread starts in ${folderName(startFolder)} instead.` : ""
    const install = (latest.base.state === "failed" || latest.base.state === "waiting") && latest.base.install
    if (install)
      return {
        acts: true,
        short: `${name} needs GitHub access`,
        node: (
          <NeedRow
            data="private"
            icon={<LockIcon />}
            title={`Let cloud Threads work in ${name}`}
            detail={`${name} is private. Give Mako's GitHub App access to it on GitHub, and cloud Threads clone, push and open pull requests there.`}
            action={
              <Action tone="solid" size="sm" onClick={() => cloudTurnOn.giveAccess(install)} data-turn-on-fix="give-access">
                Give access
              </Action>
            }
          />
        ),
      }
    return {
      acts: false,
      short: `${name} is private`,
      node: <NeedRow data="private" icon={<LockIcon />} title={`${name} is a private repository`} detail={`Cloud Threads work with public GitHub repositories for now, so ${name} stays on this Mac.${instead}`} />,
    }
  }
  if (startFolder && carried && carried.decision === "unasked" && carried.repository && carried.files.length)
    return { acts: true, short: "", node: <CarriedRow folder={startFolder} view={carried} busy={carriedBusy} /> }
  if (projects?.state === "done" && !projects.projects.length && stepOf(turnOn, "thread")?.state !== "done")
    return {
      acts: false,
      short: "",
      node: <NeedRow data="no-project" icon={<FolderGitIcon />} title="None of your recent projects is on GitHub" detail="Cloud Threads start from a GitHub repository. Open one here, choose Cloud beside the composer, and send." />,
    }
  return undefined
}

function NeedRow({ data, icon, title, detail, action }: { data: string; icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return (
    <div data-turn-on-needs={data} className="flex items-start gap-3">
      <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-xs ring-1 ring-hairline [&_svg]:size-3.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-label leading-relaxed text-pretty text-muted-foreground">{detail}</p>
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  )
}

/**
 * The first project's files Git leaves out, asked once while the rest goes, so its first cloud Thread or move never
 * stops to ask. The same question, kept the same way, as the move's.
 */
function CarriedRow({ folder, view, busy }: { folder: string; view: CarriedFilesView; busy: string | undefined }) {
  const paths = view.files.map((file) => file.path)
  const one = paths.length === 1
  const named = paths.length > 2 ? `${paths[0]} and ${paths.length - 1} more` : paths.join(" and ")
  return (
    <NeedRow
      data="carried"
      icon={<FileLockIcon />}
      title={`Bring ${named} to the cloud?`}
      detail={`Git leaves ${one ? "it" : "them"} out of ${folderName(folder)}. Mako keeps an encrypted copy for this project's cloud Threads; agents never see the values.`}
      action={
        <div className="flex items-center gap-1.5">
          <Action size="sm" disabled={busy !== undefined} onClick={() => void decideCarriedFiles(folder, false)} data-carried-files-answer="no">
            Keep here
          </Action>
          <Action tone="outline" size="sm" disabled={busy !== undefined} onClick={() => void decideCarriedFiles(folder, true)} data-carried-files-answer="yes">
            {busy === "copying" ? <Spinner /> : null}
            Bring {one ? "it" : "them"}
          </Action>
        </div>
      }
    />
  )
}

function StartThread({ folder, quiet }: { folder: string; quiet: boolean }) {
  return (
    <Action
      tone={quiet ? "outline" : "solid"}
      size="md"
      onPointerDown={() => cloudTurnOn.warm(folder)}
      onClick={() => void cloudTurnOn.startThread(folder)}
      data-turn-on-fix="start-thread"
    >
      Start a cloud Thread
    </Action>
  )
}

/* ------------------------------------------------------------------ */
/* Details: for whoever is looking into it                             */
/* ------------------------------------------------------------------ */

/** Each step in a line, with how long it took from the moment the cloud came on, and what Mako retries by itself. */
function Details({ turnOn }: { turnOn: CloudTurnOn }) {
  const names = useHarnessNames()
  const email = useCloudAccount((state) => (state.account?.state.status === "signed-in" ? state.account.state.account.email : undefined))
  const busy = useCloudTurnOn((state) => state.busy)
  const took = (step: TurnOnStep | undefined) =>
    step?.state === "done" && step.at !== undefined && turnOn.since !== undefined && step.at > turnOn.since ? formatDuration(step.at - turnOn.since) : undefined
  const rows: Array<{ id: string; label: string; value: ReactNode; status: ReactNode }> = []
  const account = stepOf(turnOn, "account")
  rows.push({ id: "account", label: "Account", value: email ?? "Signed in", status: account?.state === "stuck" ? "Offline, reconnecting" : "Signed in" })
  rows.push({ id: "plan", label: "Mako Cloud", value: "Cloud Threads, sync and moves", status: stepOf(turnOn, "plan")?.state === "done" ? "On" : "Waiting for invite" })
  const agents = stepOf(turnOn, "agents")
  if (agents && agents.state !== "later") {
    const list = agents.agents.map((agent) => names(agent.harness))
    const sending = agents.agents.filter((agent) => agent.state === "sending").length
    const out = agents.agents.filter((agent) => agent.state === "stuck").map((agent) => names(agent.harness))
    rows.push({
      id: "agents",
      label: "Agents",
      value: !agents.sharing ? "Kept on this Mac" : list.length ? `${joinWords(list)}, from this Mac` : "None signed in on this Mac yet",
      status: out.length ? `${joinWords(out)} signed out` : sending ? "Bringing over" : took(agents) ?? "In the cloud",
    })
  }
  const projects = stepOf(turnOn, "projects")
  if (projects && projects.state !== "later")
    for (const project of projects.projects.length ? projects.projects : [undefined]) {
      if (!project) {
        rows.push({ id: "projects", label: "Projects", value: projects.state === "working" ? "Finding your recent projects" : "None on GitHub yet", status: "" })
        continue
      }
      rows.push({
        id: `project:${project.folder}`,
        label: rows.some((row) => row.id.startsWith("project:")) ? "" : "Projects",
        value: repositoryName(project.repository),
        status: projectStatus(project.base, project === projects.projects[0] ? took(projects) : undefined, busy === "retry"),
      })
    }
  const history = stepOf(turnOn, "history")
  if (history && history.state !== "later")
    rows.push({
      id: "history",
      label: "Last 7 days",
      value: history.threads ? `${history.inCloud.toLocaleString()} of ${count(history.threads, "Thread")}` : "Reading this Mac",
      status: history.failures ? `${count(history.failures, "Session")} retrying` : history.paused ? "Waiting for power" : history.state === "done" ? took(history) ?? "In the cloud" : "Syncing",
    })
  const thread = stepOf(turnOn, "thread")
  if (thread && thread.state !== "later") rows.push({ id: "thread", label: "First cloud Thread", value: thread.state === "done" ? "Running" : "Not yet", status: took(thread) ?? "" })

  return (
    <div data-turn-on-details className="pt-1 pb-3">
      <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 rounded-xl px-1 py-2 text-label">
        {rows.map((row) => (
          <div key={row.id} data-turn-on-step={row.id} className="contents">
            <dt className="text-faint">{row.label}</dt>
            <dd className="truncate text-muted-foreground">{row.value}</dd>
            <dd className="text-right text-faint tabular-nums">{row.status}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between gap-3 px-1 pt-1">
        <p className="text-label text-faint">{turnOn.since !== undefined && turnOn.readyAt !== undefined ? `Ready ${formatDuration(Math.max(1, turnOn.readyAt - turnOn.since))} after the cloud came on.` : ""}</p>
        <Action size="xs" onClick={() => copyDetails(turnOn)} data-turn-on-copy>
          <CopyIcon />
          Copy details
        </Action>
      </div>
    </div>
  )
}

function projectStatus(base: BaseStanding, took: string | undefined, retrying: boolean): ReactNode {
  switch (base.state) {
    case "ready":
      return took ?? "Ready"
    case "making":
      return "Setting up"
    case "waiting":
      return noAccess(base) ? "Private" : "Retrying shortly"
    case "failed":
      return noAccess(base) ? (
        "Private"
      ) : (
        <button type="button" disabled={retrying} onClick={() => void cloudTurnOn.retryBases()} data-turn-on-fix="retry-bases" className="pressable text-muted-foreground underline decoration-hairline underline-offset-2 hover:text-foreground">
          {retrying ? "Asking again" : "Try again"}
        </button>
      )
    case "none":
      return "Clones as it starts"
    case "unknown":
      return "Asked for"
  }
}

/** Every step's state, time and the cloud's own words with their correlation IDs, for a report. */
function copyDetails(turnOn: CloudTurnOn) {
  const lines = [`phase ${turnOn.phase}`, ...turnOn.steps.map((step) => [step.id, step.state, step.at !== undefined && turnOn.since !== undefined ? `+${step.at - turnOn.since}ms` : "", step.problem ?? "", step.id === "history" ? step.correlationIds.map((id) => `correlation ${id}`).join(" ") : "", step.id === "projects" ? step.projects.map((project) => `${repositoryName(project.repository)}:${project.base.state}${"message" in project.base && project.base.message ? ` (${project.base.message})` : ""}`).join(" ") : ""].filter(Boolean).join("  "))]
  void navigator.clipboard.writeText(lines.join("\n")).then(
    () => toast("Details copied"),
    () => toast.error("The details weren't copied")
  )
}

/* ------------------------------------------------------------------ */
/* The sidebar                                                         */
/* ------------------------------------------------------------------ */

/**
 * The sidebar's one line while the cloud gets ready, and until its first Thread runs: the mark, where it stands, and
 * what's next or what needs the person. It opens Settings › Account. Gone once it's on.
 */
export function TurnOnRailLine() {
  const turnOn = useCloudTurnOn((state) => state.turnOn)
  useEffect(() => cloudTurnOn.load(), [])
  if (!turnOn || (turnOn.phase !== "turning-on" && turnOn.phase !== "ready")) return null
  return <RailLine turnOn={turnOn} />
}

function RailLine({ turnOn }: { turnOn: CloudTurnOn }) {
  const said = useSummary(turnOn)
  const needs = said.needsShort
  if (turnOn.phase === "ready" && stepOf(turnOn, "thread")?.state === "done" && !needs) return null
  const working = turnOn.phase === "turning-on"
  return (
    <button
      type="button"
      data-turn-on-rail={turnOn.phase}
      onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "account" }))}
      className="pressable flex w-full items-center gap-2.5 border-t border-hairline px-3 py-2.5 text-left hover:bg-fill-hover"
    >
      <CloudMark state={working || needs ? "plain" : "on"} small />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-medium text-foreground">{said.headline}</span>
        <span className={cn("truncate text-label", needs ? "text-caution" : "text-faint")}>{needs || (working ? <Shimmer>{said.short}</Shimmer> : said.short)}</span>
      </span>
      {working ? <Spinner className="size-3.5 shrink-0 text-faint" /> : <ChevronRightIcon className="size-3.5 shrink-0 text-faint" />}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

function useHarnessNames(): (harness: string) => string {
  const descriptors = useThreads((state) => state.descriptors)
  return (harness) => descriptors.find((entry) => entry.provider === harness)?.displayName ?? harness
}

function repositoryName(repository: string): string {
  return repository.split("/").filter(Boolean).at(-1) ?? repository
}

function folderName(folder: string): string {
  return folder.split("/").filter(Boolean).at(-1) ?? folder
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function joinWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`
}

