import { useState } from "react"
import { CloudDownloadIcon, CloudIcon, CloudUploadIcon, LaptopIcon, LoaderCircleIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { backgroundWork } from "@mako/host/contracts/background-work"
import { cn } from "@/lib/utils"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { useCloudAccount } from "@/state/cloud-account"
import { bringBack, moveToCloud, useCloudMoves } from "@/state/cloud-moves"
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
  const [open, setOpen] = useState(false)
  if (!live) return null
  if (live.elsewhere)
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" data-run-place="cloud" disabled={returning} aria-label={returning ? "Coming back to this Mac" : "Runs on a cloud machine. Bring it back to this Mac"} title={returning ? "Coming back to this Mac" : "Runs on a cloud machine, at the same folder"} className={cn(triggerClass, "text-foreground")}>
            {returning ? <LoaderCircleIcon className="size-3 shrink-0 animate-spin" /> : <CloudIcon className="size-3 shrink-0" />}
            <span data-collapse="1" className="truncate">
              {returning ? "Coming back…" : "Cloud"}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-1">
          <p className="px-2 py-1.5 text-label text-faint">Where this thread runs</p>
          <button
            type="button"
            data-thread-return-offer
            disabled={live.running}
            onClick={() => {
              setOpen(false)
              void bringBack(live.key)
            }}
            className="pressable flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover disabled:pointer-events-none disabled:opacity-60"
          >
            <CloudDownloadIcon className="mt-0.5 size-3 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-ui">Bring back to this Mac</span>
              <span className="text-label text-faint">
                {live.running ? "Threads come back between turns: wait for this turn to end, or stop it." : "What it did in the cloud comes into its worktree here, and every session picks up on this Mac. The cloud machine ends."}
              </span>
            </span>
          </button>
        </PopoverContent>
      </Popover>
    )
  const inWorktree = worktree !== undefined && (live.cwd === worktree || live.cwd.startsWith(`${worktree}/`))
  const blocked = !live.started
    ? "Send a first message before it moves."
    : !inWorktree
      ? "It works in the project folder. Move it to its own branch first, from the menu beside this; the project folder stays on this Mac."
      : undefined
  // At work, it's handed off: its turn pauses, goes along, and continues in the cloud; what it left running in the
  // background stops, and the agent is told there what stopped.
  const handOff = live.running || live.background
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-run-place="local" disabled={moving} aria-label={moving ? "Moving to the cloud" : "Runs on this Mac. Move it to the cloud"} title={moving ? "Moving to the cloud" : "Runs on this Mac"} className={triggerClass}>
          {moving ? <LoaderCircleIcon className="size-3 shrink-0 animate-spin" /> : <LaptopIcon className="size-3 shrink-0" />}
          <span data-collapse="1" className="truncate">
            {moving ? "Moving…" : "Local"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-1">
        <p className="px-2 py-1.5 text-label text-faint">Where this thread runs</p>
        <button
          type="button"
          data-thread-move-offer
          data-thread-handoff={handOff || undefined}
          disabled={blocked !== undefined}
          onClick={() => {
            setOpen(false)
            void moveToCloud(live.key, handOff)
          }}
          className="pressable flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover disabled:pointer-events-none disabled:opacity-60"
        >
          <CloudUploadIcon className="mt-0.5 size-3 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-ui">{handOff ? "Hand off to the cloud" : "Move to the cloud"}</span>
            <span className="text-label text-faint">
              {blocked ??
                (live.running
                  ? "Its turn pauses, and its worktree and every session go to a cloud machine at the same folder. The turn goes on there from where it paused. Your Mac can close."
                  : handOff
                  ? "What it left running in the background stops, and its worktree and every session go to a cloud machine at the same folder, where it's told what stopped. Your Mac can close."
                  : "Its worktree and every session go to a cloud machine, at the same folder, and pick up where they left off. Your Mac can close.")}
            </span>
          </span>
        </button>
      </PopoverContent>
    </Popover>
  )
}
