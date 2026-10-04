import type { ReactNode } from "react"
import { MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from "@/components/ui/menu"
import { Shimmer } from "@/components/ui/shimmer"
import { cn } from "@/lib/utils"
import { formatAgo, probeThreadApp, useThreadApp, type AppProbeView } from "@/state/thread-app"

/**
 * The app's probe, a row of its menu: what it touches on this Mac beyond
 * its checkout and ports, which a second copy would fight over. Opening the
 * row takes a look; one taken moments ago stands until Look again.
 */
export function AppProbeMenu({ cwd, now }: { cwd: string; now: number }) {
  const probe = useThreadApp((state) => state.probes[cwd])
  const view = probe?.view
  return (
    <MenuSub onOpenChange={(open) => { if (open) probeThreadApp(cwd) }}>
      <MenuSubTrigger data-app-action="probe" className="group gap-3">
        <span className="min-w-0 flex-1 truncate">Outside this folder</span>
        {probe?.looking ? <Shimmer text="Looking" className="shrink-0 text-label text-faint" /> : null}
      </MenuSubTrigger>
      <MenuSubContent data-app-probe="" className="w-[26rem] max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto">
        <div className="px-2 pt-2 pb-2.5">
          <div className="flex h-5 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">Outside this folder</span>
            {view ? <span className="shrink-0 text-label text-faint tabular-nums">{`looked ${formatAgo(view.at, now)}`}</span> : null}
          </div>
          <p className="mt-1 text-label text-muted-foreground">
            {view && !view.running
              ? "The app isn't running. This is what it left running and changed on this Mac since it last started."
              : "What the app uses on this Mac beyond its checkout and ports, which a second copy of it would fight over."}
          </p>
          {probe?.error ? <p className="mt-1 text-label text-negative">{`The last look failed: ${probe.error}`}</p> : null}
        </div>
        {view ? <ProbeReport view={view} /> : <p className="px-2 pb-2.5 text-label text-faint"><Shimmer text="Looking at what the app has open" /></p>}
        <MenuSeparator />
        <MenuItem
          data-app-action="probe-again"
          disabled={probe?.looking}
          onSelect={(event) => {
            event.preventDefault()
            probeThreadApp(cwd, { again: true })
          }}
        >
          {probe?.looking ? <Shimmer text="Looking" /> : "Look again"}
        </MenuItem>
      </MenuSubContent>
    </MenuSub>
  )
}

/** The look itself, section by section; a section with nothing in it is left out. */
export function ProbeReport({ view }: { view: AppProbeView }) {
  const { first, last } = view.ports
  const where = (path: string) => (path === view.home || path.startsWith(`${view.home}/`) ? `~${path.slice(view.home.length)}` : path)
  const found = [
    view.listening.length,
    view.connectsTo.length,
    view.connectsOutside.entries.length,
    view.writing.entries.length,
    view.leftovers.length,
    view.changed.entries.length,
    view.registered.length,
  ].some(Boolean)
  if (!found)
    return (
      <p className="px-2 pb-2.5 text-label text-muted-foreground">
        {view.upSince === undefined
          ? "Nothing yet: the app has no ports, connections, files or processes outside this folder, and it hasn't run here since Mako began keeping track."
          : "Nothing so far: no ports, connections, files, processes, changed folders or registrations outside this folder."}
      </p>
    )
  return (
    <div className="grid gap-1 pb-1">
      {view.listening.length ? (
        <Section title="Ports it listens on">
          {view.listening.map((entry) => (
            <Finding key={`${entry.port}-${entry.pid}`} name={`Port ${entry.port}`} aside={`pid ${entry.pid}`} caution={entry.fixed}>
              {entry.fixed
                ? `Outside this Thread's ports ${first} to ${last}, so a second copy would fight over it.`
                : entry.port >= first && entry.port <= last
                  ? `One of this Thread's ports, ${first} to ${last}.`
                  : "Picked by the system, so a second copy gets another."}
            </Finding>
          ))}
        </Section>
      ) : null}
      {view.connectsTo.length ? (
        <Section title="Services on this Mac it uses" note="A service another Thread's app also uses is shared, so each copy needs its own database, namespace or prefix in it.">
          {view.connectsTo.map((entry) => (
            <Finding key={entry.port} name={`Port ${entry.port}`}>{`Listened on by ${entry.owner}.`}</Finding>
          ))}
        </Section>
      ) : null}
      {view.connectsOutside.entries.length ? (
        <Section title="Connections off this Mac">
          {view.connectsOutside.entries.map((address) => <Finding key={address} name={address} />)}
          <More count={view.connectsOutside.more} noun="connection" />
        </Section>
      ) : null}
      {view.writing.entries.length ? (
        <Section title="Files it writes outside this folder" note="Two copies writing one file is a conflict.">
          {view.writing.entries.map((entry) => <Finding key={entry.path} name={where(entry.path)} aside={`pid ${entry.pid}`} />)}
          <More count={view.writing.more} noun="file" />
        </Section>
      ) : null}
      {view.leftovers.length ? (
        <Section title="Left running" note="Each started since the app came up and outlived the process that started it, so stopping the app doesn't end it.">
          {view.leftovers.map((entry) => (
            <Finding key={entry.pid} name={entry.command} aside={`pid ${entry.pid}`}>
              {entry.sure
                ? "It carries the mark Mako puts on everything it starts for this app, so it's the app's."
                : "It works in this folder. Mako can't read its environment, so it may not be the app's."}
            </Finding>
          ))}
        </Section>
      ) : null}
      {view.changed.entries.length ? (
        <Section
          title={view.stoppedAt === undefined ? "Changed since it started" : "Changed while it ran"}
          note={`Other apps write in these folders too, so look for names of this project or its tools. ${
            view.changedBy === "history"
              ? "Read from the file system's history, so a change at any depth shows."
              : "Compared by modification times one or two levels down, so a change deeper in an otherwise untouched folder can be missed."
          } Sandboxed apps' containers show only files it held open for writing, since reading them makes macOS ask for access to other apps' data.`}
        >
          {view.changed.entries.map((entry) => (
            <Finding key={entry.folder} name={where(entry.folder)}>
              {entry.paths.length ? (
                <ul className="my-0.5 grid gap-0.5 text-faint">
                  {entry.paths.map((path) => <li key={path} className="[overflow-wrap:anywhere]">{path}</li>)}
                  {entry.more ? <li>And more that Mako didn't keep the names of.</li> : null}
                </ul>
              ) : null}
              {entry.who}
            </Finding>
          ))}
          <More count={view.changed.more} noun="folder" />
        </Section>
      ) : null}
      {view.registered.length ? (
        <Section title="Registered with macOS" note="A second copy registering the same label or link scheme replaces the first or fights it for links and logins.">
          {view.registered.map((entry) => (
            <Finding key={`${entry.kind}-${entry.name}`} name={entry.name}>{entry.detail}</Finding>
          ))}
        </Section>
      ) : null}
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5 border-t border-hairline px-2 pt-2 pb-1.5">
      <div>
        <h3 className="text-label font-medium text-foreground">{title}</h3>
        {note ? <p className="text-label text-faint">{note}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Finding({ name, aside, caution, children }: { name: string; aside?: string; caution?: boolean; children?: ReactNode }) {
  return (
    <div className="text-label">
      <div className="flex items-baseline gap-2">
        <span className={cn("min-w-0 flex-1 [overflow-wrap:anywhere]", caution ? "text-caution" : "text-foreground")}>{name}</span>
        {aside ? <span className="shrink-0 text-faint tabular-nums">{aside}</span> : null}
      </div>
      {children ? <div className="text-muted-foreground">{children}</div> : null}
    </div>
  )
}

function More({ count, noun }: { count?: number; noun: string }) {
  if (!count) return null
  return <p className="text-label text-faint">{`And ${count} more ${count === 1 ? noun : `${noun}s`}.`}</p>
}
