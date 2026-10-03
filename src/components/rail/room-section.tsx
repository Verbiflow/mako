import { useEffect, useState, type CSSProperties } from "react"
import { CheckIcon, HourglassIcon, LoaderCircleIcon, PlayIcon, SquareIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { fitLine, memoryLine, othersAmong, roomDetail, roomMemory, roomTip, roomTitle } from "@/lib/room"
import { cn } from "@/lib/utils"
import { confirmAction } from "@/state/confirm"
import { formatBytes, threadAppDriver, useThreadApp, type RoomApp, type RoomView } from "@/state/thread-app"

/** Subjects a confirmation names before it counts the rest. */
const SHOWN_SUBJECTS = 5

function StateIcon({ state }: { state: RoomApp["state"] }) {
  const icon = "size-3 shrink-0"
  if (state === "running") return <PlayIcon aria-hidden className={cn(icon, "fill-current text-positive")} strokeWidth={2.5} />
  if (state === "starting") return <LoaderCircleIcon aria-hidden className={cn(icon, "animate-spin text-faint")} strokeWidth={2.5} />
  if (state === "waiting") return <HourglassIcon aria-hidden className={cn(icon, "text-muted-foreground")} strokeWidth={2.25} />
  return <TriangleAlertIcon aria-hidden className={cn(icon, "text-muted-foreground")} strokeWidth={2.25} />
}

const STATE_WORDS: Record<RoomApp["state"], string> = {
  running: "running",
  starting: "starting",
  waiting: "waiting for memory",
  crashed: "crashed",
}

/**
 * Every app on this Mac, in the Status view: what it is, what it holds, how
 * long it has been up, and how many copies of each project's app fit. Rows
 * select for stopping several at once; stopping an app that isn't the one
 * in view asks first. Watched only while it shows.
 */
export function RoomSection() {
  useEffect(() => threadAppDriver()?.watchRoom?.(), [])
  const room = useThreadApp((state) => state.room)
  if (!room) return null
  return <RoomList room={room} />
}

export function RoomList({ room, now = Date.now() }: { room: RoomView; now?: number }) {
  const { cwd } = useWorkspaceFocus()
  const [selected, setSelected] = useState<readonly string[]>([])
  const [stopping, setStopping] = useState<readonly string[]>([])
  const listed = new Set(room.apps.map((app) => app.app))
  // Selections and stops of apps that have left the Room fall away with them.
  const picked = selected.filter((app) => listed.has(app))
  const leaving = stopping.filter((app) => listed.has(app))
  if (picked.length !== selected.length) setSelected(picked)
  if (leaving.length !== stopping.length) setStopping(leaving)

  const stop = async (apps: readonly RoomApp[]) => {
    const driver = threadAppDriver()
    if (!driver?.stopApps || !apps.length) return
    const others = othersAmong(apps, cwd)
    if (others.length) {
      const one = apps.length === 1 ? apps[0] : undefined
      const confirmed = await confirmAction({
        title: one ? `Stop the app of “${roomTitle(one)}”?` : `Stop ${apps.length} apps?`,
        body: others.length === 1 && one
          ? "It belongs to another Thread. Its files and data stay, and it starts again from its Thread."
          : `${others.length === apps.length ? "They belong" : `${others.length} of them belong`} to other Threads. Their files and data stay, and each starts again from its Thread.`,
        confirm: one ? "Stop app" : `Stop ${apps.length} apps`,
        icon: "stop",
        subjects: apps.slice(0, SHOWN_SUBJECTS).map((app) => {
          const memory = roomMemory(app)
          return memory ? { kind: "app" as const, name: roomTitle(app), detail: memory } : { kind: "app" as const, name: roomTitle(app) }
        }),
        more: apps.length > SHOWN_SUBJECTS ? apps.length - SHOWN_SUBJECTS : undefined,
      })
      if (!confirmed) return
    }
    const keys = apps.map((app) => app.app)
    setStopping((current) => [...new Set([...current, ...keys])])
    setSelected((current) => current.filter((app) => !keys.includes(app)))
    try {
      await driver.stopApps(keys)
    } catch (error) {
      setStopping((current) => current.filter((app) => !keys.includes(app)))
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const toggle = (app: string) =>
    setSelected((current) => (current.includes(app) ? current.filter((entry) => entry !== app) : [...current, app]))
  const held = room.apps.reduce((sum, app) => sum + (app.memoryBytes ?? 0), 0)
  const choosing = picked.length > 0

  return (
    <section data-room className="pt-2 pb-2">
      <div className="flex h-7 items-center gap-1.5 px-1.5 text-label font-medium text-faint">
        <span className="flex-1 truncate">Room</span>
        {choosing ? (
          <>
            <button
              type="button"
              onClick={() => setSelected([])}
              className="pressable rounded px-1.5 py-0.5 text-faint hover:bg-fill-hover hover:text-foreground"
            >
              Clear
            </button>
            <button
              type="button"
              data-room-stop-selected
              onClick={() => void stop(room.apps.filter((app) => picked.includes(app.app)))}
              className="pressable rounded px-1.5 py-0.5 text-foreground hover:bg-fill-hover"
            >
              Stop {picked.length}
            </button>
          </>
        ) : (
          <span className="tabular text-faint/60">
            {room.apps.length ? `${room.apps.length} ${room.apps.length === 1 ? "app" : "apps"}${held ? ` · ${formatBytes(held)}` : ""}` : null}
          </span>
        )}
      </div>
      {room.apps.length === 0 ? (
        <p className="flex h-7 items-center px-1.5 text-label text-faint/70">No apps running on this Mac</p>
      ) : (
        <ul aria-label="Apps on this Mac">
          {room.apps.map((app) => {
            const title = roomTitle(app)
            const memory = roomMemory(app)
            const isPicked = picked.includes(app.app)
            const isStopping = leaving.includes(app.app)
            return (
              <li key={app.app}>
                <div
                  role="checkbox"
                  aria-checked={isPicked}
                  aria-label={`${title}, ${STATE_WORDS[app.state]}`}
                  aria-disabled={isStopping || undefined}
                  tabIndex={0}
                  data-room-app={app.app}
                  data-tip={roomTip(app, now)}
                  data-picked={isPicked || undefined}
                  onClick={() => {
                    if (!isStopping) toggle(app.app)
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || (event.key !== " " && event.key !== "Enter")) return
                    event.preventDefault()
                    if (!isStopping) toggle(app.app)
                  }}
                  className={cn(
                    "group relative isolate flex w-full cursor-default items-start gap-2 rounded-md py-1 pr-1 pl-1.5 text-left transition-colors duration-100 hover:bg-fill-hover data-picked:bg-fill-selected data-picked:hover:bg-fill-selected",
                    isStopping && "opacity-50"
                  )}
                >
                  <span className="relative mt-[3px] flex size-3.5 shrink-0 items-center justify-center">
                    <span className={cn("flex", (choosing || isPicked) ? "hidden" : "group-hover:hidden group-focus-visible:hidden")}>
                      <StateIcon state={app.state} />
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "size-3 items-center justify-center rounded-[3px] ring-1 ring-current",
                        isPicked ? "flex bg-foreground text-background ring-foreground" : choosing ? "flex text-faint" : "hidden text-faint group-hover:flex group-focus-visible:flex"
                      )}
                    >
                      {isPicked ? <CheckIcon className="size-2.5" strokeWidth={3} /> : null}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">{title}</span>
                      {memory ? <span className="tabular shrink-0 text-label text-faint">{memory}</span> : null}
                    </span>
                    <span className="block truncate text-label text-faint/80">
                      {isStopping ? "Stopping…" : roomDetail(app, now)}
                    </span>
                  </span>
                  {isStopping ? null : (
                    <span
                      data-tip-quiet
                      style={isPicked ? { "--row-over": "var(--fill-selected)" } as CSSProperties : undefined}
                      className="rail-row-actions pointer-events-none absolute top-0.5 right-0 z-[1] flex items-center rounded-r-md pl-4 pr-1 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100"
                    >
                      <button
                        type="button"
                        aria-label={`Stop the app of ${title}`}
                        data-room-stop={app.app}
                        onClick={(event) => {
                          event.stopPropagation()
                          void stop([app])
                        }}
                        className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
                      >
                        <SquareIcon className="size-3 fill-current" />
                      </button>
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <div className="px-1.5 pt-1 text-label text-faint/70">
        {room.fits.map((fit) => {
          const line = fitLine(fit)
          return (
            <p key={fit.root} data-tip={line.tip} data-room-fit={fit.root} className="truncate leading-5">
              {line.text}
            </p>
          )
        })}
        <p className="truncate leading-5">{memoryLine(room)}</p>
      </div>
    </section>
  )
}
