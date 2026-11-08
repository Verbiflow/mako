import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { CircleIcon, KeyboardIcon, RotateCwIcon, SmartphoneIcon } from "lucide-react"
import type { ListedSimulator, SimulatorClaim, SimulatorPoint } from "@mako/host/contracts/simulators"
import { Action, Blank, Chip, IconAction, Segmented } from "@/components/ui/kit"
import { ControlVideoPlayer } from "@/lib/control-video-player"
import { cn } from "@/lib/utils"
import { pictureTurn, pointOnScreen, shownScreen, simulatorKey, simulators, touchOf, TouchStream, useSimulators, watchSimulatorVideo, type SimulatorFrame } from "@/state/simulators"

/** Until a host says a screen's size, a phone's and a tablet's in points. */
const SCREENS = { phone: { width: 402, height: 874 }, tablet: { width: 1032, height: 1376 } }

/**
 * A simulator beside the chat: its screen as it streams, touched with the pointer as a finger would, and who drives
 * it. One Thread drives a simulator at a time and everyone else watches; the person can take it over here.
 */
export function SimulatorPanel() {
  const listed = useSimulators((state) => state.listed)
  const chosen = useSimulators((state) => state.chosen)
  const frame = useSimulators((state) => (state.chosen ? state.frames[state.chosen] : undefined))
  const refused = useSimulators((state) => state.refused)
  useEffect(() => void simulators.load(), [])
  const simulator = listed?.simulators.find((entry) => simulatorKey(entry) === chosen)
  const host = listed?.hosts.find((entry) => entry.id === simulator?.hostId) ?? listed?.hosts[0]
  if (!listed || !simulator)
    return (
      <section className="flex h-full flex-col" aria-label="Simulator">
        <Blank
          icon={<SmartphoneIcon />}
          title="No simulator yet"
          body={host && !host.platforms.ios.ready ? host.platforms.ios.why : "Set up an iPhone and an iPad, and agents' Safari shows here as they drive it."}
          action={
            <Action tone="outline" size="sm" onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "simulators" }))}>
              Set up simulators
            </Action>
          }
        />
      </section>
    )
  const screen = shownScreen(simulator.screen ?? SCREENS[simulator.form], simulator.orientation)
  const yours = simulator.claim?.thread === "person"
  return (
    <section data-simulator-panel={simulator.form} className="flex h-full flex-col" aria-label="Simulator">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <Segmented
          label="Simulator"
          value={simulatorKey(simulator)}
          options={listed.simulators.map((entry) => ({ value: simulatorKey(entry), label: segmentLabel(entry, listed.simulators) }))}
          onChange={(key) => simulators.choose(key)}
        />
        <span className="min-w-0 flex-1 truncate text-label text-faint" title={`${simulator.name}, ${simulator.runtime}`}>
          {simulator.name.replace(/^Mako /, "")} · {simulator.runtime}
        </span>
        {simulator.standIn ? (
          <Chip tone="caution" className="shrink-0 whitespace-nowrap" data-simulator-stand-in>
            Stand-in, not iOS
          </Chip>
        ) : null}
        <IconAction label="Home" disabled={!yours} onClick={() => void simulators.act(simulator, { kind: "home" })}>
          <CircleIcon />
        </IconAction>
        <IconAction label="Rotate" disabled={!yours} onClick={() => void simulators.act(simulator, { kind: "rotate", to: screen.width > screen.height ? "portrait" : "landscape-left" }).then(() => simulators.load())}>
          <RotateCwIcon />
        </IconAction>
        <IconAction label="Keyboard" disabled={!yours} onClick={() => void simulators.act(simulator, { kind: "keyboard", shown: true })}>
          <KeyboardIcon />
        </IconAction>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-shell/40 p-6 [container-type:size]">
        <Device simulator={simulator} screen={screen} frame={frame} touchable={yours} />
      </div>
      <footer className="flex shrink-0 items-center gap-3 border-t border-hairline px-3 py-2">
        <p data-simulator-holder className="min-w-0 flex-1 text-pretty text-label text-muted-foreground">
          {refused ? <span className="text-negative">{refused}</span> : holderLine(simulator.claim)}
        </p>
        {yours ? (
          <Action size="xs" onClick={() => void simulators.release(simulator)} data-simulator-release>
            Hand back
          </Action>
        ) : (
          <Action tone="outline" size="xs" onClick={() => void simulators.takeOver(simulator)} data-simulator-take-over>
            {simulator.claim ? "Take over" : "Open"}
          </Action>
        )}
      </footer>
    </section>
  )
}

/** A form's name when it's the only one of its form, as Mako's own iPhone and iPad are; otherwise its whole name. */
function segmentLabel(simulator: ListedSimulator, all: readonly ListedSimulator[]): string {
  if (all.filter((other) => other.form === simulator.form).length === 1) return simulator.form === "phone" ? "iPhone" : "iPad"
  return simulator.name.replace(/^Mako /, "")
}

function holderLine(claim: SimulatorClaim | undefined): string {
  if (!claim) return "Nobody is driving it."
  if (claim.thread === "person") return "You're driving it. Agents watch until you hand it back."
  return `${claim.title ? `“${claim.title}”` : "A Thread"} is driving it. You're watching.`
}

/** The screen in its frame, as tall as the panel lets it be, touched in the simulator's points. */
function Device({ simulator, screen, frame, touchable }: { simulator: ListedSimulator; screen: { width: number; height: number }; frame: SimulatorFrame | undefined; touchable: boolean }) {
  const pressed = useRef<{ at: SimulatorPoint; time: number; stream?: TouchStream } | undefined>(undefined)
  const live = useSimulators((state) => !state.touchless[simulatorKey(simulator)])
  const phone = simulator.form === "phone"
  const point = (event: ReactPointerEvent<HTMLDivElement>) => pointOnScreen(event.currentTarget.getBoundingClientRect(), screen, event.clientX, event.clientY)
  const bezel = (phone ? 18 : 28) * (Math.min(screen.width, screen.height) / 402)
  const ratio = (screen.width + bezel) / (screen.height + bezel)
  const streams = simulator.state === "booted" && !simulator.standIn
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = pressed.current
    pressed.current = undefined
    if (!from) return
    const to = point(event) ?? from.at
    if (from.stream) from.stream.end(to)
    else void simulators.act(simulator, touchOf(from.at, to, event.timeStamp - from.time))
  }
  return (
    <div
      data-simulator-device
      className={cn("relative flex bg-shell shadow-lg ring-1 ring-hairline", phone ? "p-[9px]" : "p-[14px]")}
      // The panel's whole width or its whole height, whichever the screen's shape fits first.
      style={{ width: `min(100cqw, ${ratio} * 100cqh)`, aspectRatio: ratio }}
    >
      <div
        data-simulator-screen
        className={cn("relative flex-1 overflow-hidden bg-background", phone ? "" : "", touchable ? "cursor-pointer touch-none" : "cursor-default")}
        onPointerDown={(event) => {
          if (!touchable || event.button !== 0) return
          const at = point(event)
          if (!at) return
          event.currentTarget.setPointerCapture(event.pointerId)
          // A finger on the screen as it moves, where the host takes one; elsewhere a tap or a swipe once it lifts.
          const stream = live && streams ? new TouchStream((phase, at) => simulators.act(simulator, { kind: "touch", phase, at })) : undefined
          stream?.begin(at)
          pressed.current = { at, time: event.timeStamp, stream }
        }}
        onPointerMove={(event) => {
          const stream = pressed.current?.stream
          const at = stream && point(event)
          if (stream && at) stream.move(at)
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {streams ? (
          <Screen key={`${simulator.hostId}:${simulator.id}`} simulator={simulator} screen={screen} />
        ) : frame ? (
          <img src={frame.src} alt={`${simulator.name}'s screen`} draggable={false} className="size-full object-contain select-none" />
        ) : (
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-label text-faint">{simulator.state === "booted" ? "Waiting for the first frame…" : "Off. Open it to boot."}</p>
        )}
      </div>
    </div>
  )
}

/** The simulator's screen as it streams: H.264 decoded by WebCodecs, or the capture's JPEGs, drawn upright. Keyed by the simulator, so another starts unpainted. */
function Screen({ simulator, screen }: { simulator: ListedSimulator; screen: { width: number; height: number } }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [painted, setPainted] = useState(false)
  const [stopped, setStopped] = useState(false)
  const orientation = useRef(simulator.orientation)
  useEffect(() => {
    orientation.current = simulator.orientation
  }, [simulator.orientation])
  useEffect(() => {
    const player = new ControlVideoPlayer(
      (picture, width, height) => {
        const target = canvas.current
        const context = target?.getContext("2d")
        if (!target || !context) return
        const turn = pictureTurn({ width, height }, orientation.current)
        const sideways = turn === 90 || turn === -90
        const drawnWidth = sideways ? height : width
        const drawnHeight = sideways ? width : height
        if (target.width !== drawnWidth || target.height !== drawnHeight) {
          target.width = drawnWidth
          target.height = drawnHeight
        }
        context.save()
        if (turn === 90) context.setTransform(0, 1, -1, 0, drawnWidth, 0)
        else if (turn === -90) context.setTransform(0, -1, 1, 0, 0, drawnHeight)
        else if (turn === 180) context.setTransform(-1, 0, 0, -1, drawnWidth, drawnHeight)
        context.drawImage(picture, 0, 0, width, height)
        context.restore()
        setPainted(true)
      },
      () => watch.rejoin()
    )
    const watch = watchSimulatorVideo(
      simulator,
      (packet) => {
        try {
          player.push(packet)
        } catch {
          // A packet that doesn't decode is skipped; the next key frame starts the picture again.
        }
      },
      () => player.stats,
      (live) => setStopped(!live)
    )
    return () => {
      watch.stop()
      player.close()
    }
  }, [simulator.id, simulator.hostId])
  return (
    <>
      <canvas
        ref={canvas}
        data-simulator-video
        aria-label={`${simulator.name}'s screen`}
        className="size-full object-contain select-none"
        style={{ aspectRatio: `${screen.width} / ${screen.height}` }}
      />
      {painted ? null : (
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-label text-faint">{stopped ? "The screen isn't streaming. Open it again to boot it." : "Waiting for the first frame…"}</p>
      )}
    </>
  )
}
