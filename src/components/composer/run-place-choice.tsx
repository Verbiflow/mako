import { useState, type ReactNode } from "react"
import type { CarriedFilesView } from "@mako/host/contracts/cloud-carried-files"
import { CloudDownloadIcon, CloudIcon, CloudUploadIcon, LaptopIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { backgroundWork } from "@mako/host/contracts/background-work"
import { Action } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { useCloudAccount } from "@/state/cloud-account"
import { decideCarriedFiles, readCarriedFiles, useCarriedFiles } from "@/state/carried-files"
import { bringBack, checkHarnesses, moveToCloud, updateThen, useCloudMoves } from "@/state/cloud-moves"
import { HarnessesBehind } from "./harnesses-behind"
import { runPlaceStore, useRunPlace } from "@/state/run-place"
import { shallowEqual } from "@/state/store"
import { useSession } from "@/state/session"
import { useOnScreen } from "@/state/thread-sessions"
import { useWorktrees } from "@/state/worktrees"

const triggerClass = "pressable flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground aria-pressed:text-foreground"

/**
 * The composer's Local/Cloud choice for a new Thread in a Git project, for an
 * account with the cloud. In the cloud it runs on a machine of the account's,
 * in a clone of the folder's GitHub repository on its upstream branch.
 */
export function RunPlaceChoice() {
  const here = useOnScreen()
  const cloud = useRunPlace((state) => state.cloud)
  const inRepository = useSession((state) => Boolean(state.git?.root))
  const invited = useCloudAccount((state) => state.account?.state.status === "signed-in" && state.account.state.account.entitlements.includes("cloud"))
  if (here.thread && invited) return <ThreadRunPlace thread={here.thread} />
  if (here.thread || here.draft || here.cwd || !inRepository || !invited) return null
  const describe = cloud ? "Runs in the cloud, in a clone of this project's GitHub repository" : "Runs on this Mac"
  return (
    <button
      type="button"
      data-run-place={cloud ? "cloud" : "local"}
      aria-pressed={cloud}
      aria-label={`${describe}. Switch to ${cloud ? "this Mac" : "the cloud"}`}
      title={describe}
      onClick={() => runPlaceStore.set({ cloud: !cloud })}
      className={triggerClass}
    >
      {cloud ? <CloudIcon className="size-3 shrink-0" /> : <LaptopIcon className="size-3 shrink-0" />}
      <span data-collapse="1" className="truncate">
        {cloud ? "Cloud" : "Local"}
      </span>
    </button>
  )
}

/**
 * Where an open Thread runs, and the way to move it: a Thread on this Mac in its own worktree moves to the cloud,
 * all of its sessions, between turns; one in the project folder, or mid-turn, is told what to do first. A Thread
 * in the cloud comes back the same way.
 */
function ThreadRunPlace({ thread }: { thread: string }) {
  const live = useAcp((state) => {
    const active = activeLiveAcp(state)
    return active ? { key: active.key, cwd: active.cwd, elsewhere: Boolean(active.elsewhere), running: active.session.status === "running", background: backgroundWork(active.session, active.nativeAgents) !== null, started: Boolean(active.session.nativeId) } : null
  }, shallowEqual)
  const worktree = useWorktrees((state) => state.worktrees.find((entry) => entry.thread === thread)?.path)
  const moving = useCloudMoves((state) => (live ? Boolean(state.moving[live.key]) : false))
  const returning = useCloudMoves((state) => (live ? Boolean(state.returning[live.key]) : false))
  const check = useCloudMoves((state) => (live ? state.harnesses[live.key] : undefined))
  const [open, setOpen] = useState(false)
  /** The carried-files question, asked before the move it was asked for: with this Mac's harnesses updated first, or without. */
  const [asking, setAsking] = useState<"move" | "update" | false>(false)
  const carried = useCarriedFiles((state) => (worktree ? state.byFolder[worktree] : undefined))
  const carriedBusy = useCarriedFiles((state) => (worktree ? state.busy[worktree] : undefined))
  if (!live) return null
  const known = check?.kind === "known" ? check : undefined
  if (live.elsewhere) {
    const behind = known?.behind ?? []
    const back = () => {
      setOpen(false)
      void bringBack(live.key)
    }
    const why = live.running ? "Threads come back between turns: wait for this turn to end, or stop it." : "What it did in the cloud comes into its worktree here, and every session picks up on this Mac. The cloud machine ends."
    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) void checkHarnesses(live.key)
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" data-run-place="cloud" disabled={returning} aria-label={returning ? "Coming back to this Mac" : "Runs on a cloud machine. Bring it back to this Mac"} title={returning ? "Coming back to this Mac" : "Runs on a cloud machine, at the same folder"} className={cn(triggerClass, "text-foreground")}>
            {returning ? <Spinner className="size-3 shrink-0" /> : <CloudIcon className="size-3 shrink-0" />}
            <span data-collapse="1" className="truncate">
              {returning ? "Coming back…" : "Cloud"}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} className={cn("p-1", behind.length ? "w-96" : "w-80")}>
          <p className="px-2 py-1.5 text-label text-faint">Where this thread runs</p>
          <OfferRow data={{ "data-thread-return-offer": true }} icon={<CloudDownloadIcon className="mt-0.5 size-3 shrink-0" />} title="Bring back to this Mac" detail={why} disabled={live.running} onClick={behind.length ? undefined : back} />
          {behind.length ? (
            <HarnessesBehind
              behind={behind}
              way="back"
              disabled={live.running}
              onUpdate={() => {
                setOpen(false)
                void updateThen(live.key, "back")
              }}
              onAnyway={back}
              onCheckAgain={() => void checkHarnesses(live.key)}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    )
  }
  const inWorktree = worktree !== undefined && (live.cwd === worktree || live.cwd.startsWith(`${worktree}/`))
  // The cloud can't resume a Session a newer harness here wrote: said here, before anything is made (`ThreadHarnessCheck`).
  const blocked = !live.started
    ? "Send a first message before it moves."
    : !inWorktree
      ? "It works in the project folder. Move it to its own branch first, from the menu beside this; the project folder stays on this Mac."
      : known?.refusal
  // This Mac's harnesses older than the cloud's: the way back will need them updated, said before it goes.
  const behind = blocked === undefined ? known?.behind ?? [] : []
  // At work, it's handed off: its turn pauses, goes along, and continues in the cloud; what it left running in the
  // background stops, and the agent is told there what stopped.
  const handOff = live.running || live.background
  const move = (update: boolean) => {
    setOpen(false)
    setAsking(false)
    if (update) void updateThen(live.key, "move", handOff)
    else void moveToCloud(live.key, handOff)
  }
  // The project's files Git leaves out go too once the person says so, asked here the first time, once per project.
  const unasked = carried && carried.decision === "unasked" && carried.repository !== null && carried.files.length > 0 ? carried : undefined
  const start = (update: boolean) => {
    if (unasked) setAsking(update ? "update" : "move")
    else move(update)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setAsking(false)
        if (next && inWorktree && worktree) void readCarriedFiles(worktree)
        if (next && inWorktree && live.started) void checkHarnesses(live.key)
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" data-run-place="local" disabled={moving} aria-label={moving ? "Moving to the cloud" : "Runs on this Mac. Move it to the cloud"} title={moving ? "Moving to the cloud" : "Runs on this Mac"} className={triggerClass}>
          {moving ? <Spinner className="size-3 shrink-0" /> : <LaptopIcon className="size-3 shrink-0" />}
          <span data-collapse="1" className="truncate">
            {moving ? "Moving…" : "Local"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className={cn("p-1", behind.length && !asking ? "w-96" : "w-80")}>
        {asking && unasked ? (
          <CarriedFilesQuestion view={unasked} busy={carriedBusy} onAnswer={async (allowed) => {
            if (await decideCarriedFiles(unasked.project, allowed)) move(asking === "update")
          }} />
        ) : (
        <>
        <p className="px-2 py-1.5 text-label text-faint">Where this thread runs</p>
        <OfferRow
          data={{ "data-thread-move-offer": true, "data-thread-handoff": handOff || undefined }}
          icon={<CloudUploadIcon className="mt-0.5 size-3 shrink-0" />}
          title={handOff ? "Hand off to the cloud" : "Move to the cloud"}
          detail={blocked ??
            (live.running
              ? "Its turn pauses, and its worktree and every session go to a cloud machine at the same folder. The turn goes on there from where it paused. Your Mac can close."
              : handOff
              ? "What it left running in the background stops, and its worktree and every session go to a cloud machine at the same folder, where it's told what stopped. Your Mac can close."
              : "Its worktree and every session go to a cloud machine, at the same folder, and pick up where they left off. Your Mac can close.")}
          disabled={blocked !== undefined}
          onClick={behind.length ? undefined : () => start(false)}
        />
        {behind.length ? (
          <HarnessesBehind behind={behind} way="move" handOff={handOff} onUpdate={() => start(true)} onAnyway={() => start(false)} onCheckAgain={() => void checkHarnesses(live.key)} />
        ) : null}
        </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A place the Thread can go, as the chip's popover offers it: pressed to go, or, with this Mac's harnesses to weigh
 * first (`HarnessesBehind`), only said, its choices under it.
 */
function OfferRow({ data, icon, title, detail, disabled, onClick }: { data: Record<`data-${string}`, boolean | undefined>; icon: ReactNode; title: string; detail: string; disabled?: boolean; onClick?: () => void }) {
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui">{title}</span>
        <span className="text-label text-faint">{detail}</span>
      </span>
    </>
  )
  if (!onClick) return <div {...data} aria-disabled={disabled || undefined} className={cn("flex w-full items-start gap-2 px-2 py-1.5", disabled && "opacity-60")}>{body}</div>
  return (
    <button type="button" {...data} disabled={disabled} onClick={onClick} className="pressable flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover disabled:pointer-events-none disabled:opacity-60">
      {body}
    </button>
  )
}

/**
 * Asked once per project, the first time one of its Threads moves to the cloud: whether the files its recipe carries,
 * which Git leaves out, go too. Either answer moves the Thread; the answer is kept, and Settings › Apps changes it.
 */
function CarriedFilesQuestion({ view, busy, onAnswer }: { view: CarriedFilesView; busy: string | undefined; onAnswer: (allowed: boolean) => Promise<void> }) {
  const paths = view.files.map((file) => file.path)
  const named = paths.length > 3 ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more` : paths.length > 1 ? `${paths.slice(0, -1).join(", ")} and ${paths.at(-1)}` : paths[0]
  const one = paths.length === 1
  return (
    <div className="flex flex-col gap-2 px-2 pt-1.5 pb-2" data-carried-files-question>
      <p className="text-ui font-medium text-foreground">Copy {one ? "this file" : "these files"} to the cloud too?</p>
      <p className="text-label leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        Git leaves out {named}, so {one ? "it doesn’t" : "they don’t"} go with the worktree. Mako can keep an encrypted copy in your account and give {one ? "it" : "them"} to this project’s cloud Threads. Agents never see the values. Asked once; change it in Settings › Apps.
      </p>
      <div className="mt-1 flex justify-end gap-2">
        <Action tone="ghost" data-carried-files-answer="no" disabled={busy !== undefined} onClick={() => void onAnswer(false)}>
          Move without {one ? "it" : "them"}
        </Action>
        <Action tone="solid" data-carried-files-answer="yes" disabled={busy !== undefined} onClick={() => void onAnswer(true)}>
          {busy === "copying" ? "Copying…" : "Copy and move"}
        </Action>
      </div>
    </div>
  )
}
