import { useEffect, useState, type ReactNode } from "react"
import {
  AppWindowIcon,
  ArrowUpRightIcon,
  GlobeIcon,
  SearchIcon,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { desktop } from "@/state/desktop"
import {
  elementPicks,
  orderTabs,
  tabHost,
  unreachableBrowsers,
  useElementPicks,
  type ElementPickBrowser,
  type ElementPickTab,
} from "@/state/element-picks"
import { useThreadApp } from "@/state/thread-app"

/**
 * The tabs a person can pick an element in: the Thread's own app first when a
 * tab shows it, then every other tab Mako's browser use reaches. A browser
 * that isn't connected says what would connect it instead of hiding.
 */
export function ElementPickChooser({ cwd, onChosen }: { cwd?: string; onChosen?: () => void }) {
  const targets = useElementPicks((state) => state.targets)
  const address = useThreadApp((state) => {
    const view = cwd ? state.byCwd[cwd] : undefined
    return view?.kind === "ready" && view.phase === "running" ? view.address : undefined
  })
  const [query, setQuery] = useState("")
  useEffect(() => {
    void elementPicks.loadTargets()
  }, [])
  const value = targets.kind === "ready" ? targets.value : undefined
  const icons = new Map(value?.browsers.map((browser) => [browser.id, browser]))
  const matches = (tab: ElementPickTab) =>
    `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const { app, other } = orderTabs(value?.tabs.filter(matches) ?? [], address)
  const missing = value ? unreachableBrowsers(value) : []
  const appUrl = address ? `http://${address.host}:${address.port}/` : undefined
  const pick = (tab: ElementPickTab) => {
    onChosen?.()
    void elementPicks.start({ browser: tab.browser, tab: tab.tab }, tab.title || tabHost(tab.url))
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
        <SearchIcon className="size-3.5 shrink-0 text-faint" />
        <input
          aria-label="Find a tab"
          placeholder="Find a tab…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint"
        />
        <span className="shrink-0 text-label text-faint">Pick an element</span>
      </div>
      <div className="max-h-96 overflow-y-auto overscroll-contain p-1.5" data-element-pick-tabs>
        {targets.kind === "loading" || targets.kind === "idle" ? (
          <p role="status" className="flex h-28 items-center justify-center gap-2 text-ui text-muted-foreground">
            <Spinner className="size-4" />
            Finding tabs…
          </p>
        ) : null}
        {targets.kind === "error" ? (
          <p role="alert" className="p-3 text-ui text-muted-foreground">{targets.message}</p>
        ) : null}
        {app.length ? (
          <Group title="This Thread’s app">
            {app.map((tab) => (
              <TabRow key={`${tab.browser}:${tab.tab}`} tab={tab} browser={icons.get(tab.browser)} onPick={pick} />
            ))}
          </Group>
        ) : appUrl && value && !query ? (
          <Group title="This Thread’s app">
            <button
              type="button"
              onClick={() => {
                void desktop.openUrl(appUrl).then(() => setTimeout(() => void elementPicks.loadTargets(), 1_200))
              }}
              className="pressable flex min-h-11 w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left hover:bg-fill-hover focus-visible:bg-fill-hover"
            >
              <AppWindowIcon className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui">Open {tabHost(appUrl)} in your browser</span>
                <span className="block truncate text-label text-muted-foreground">Then pick in it here</span>
              </span>
              <ArrowUpRightIcon className="size-3.5 shrink-0 text-faint" />
            </button>
          </Group>
        ) : null}
        {other.length ? (
          <Group title={app.length || appUrl ? "Other tabs" : undefined}>
            {other.map((tab) => (
              <TabRow key={`${tab.browser}:${tab.tab}`} tab={tab} browser={icons.get(tab.browser)} onPick={pick} />
            ))}
          </Group>
        ) : null}
        {value && !app.length && !other.length ? (
          <p className="px-3 py-6 text-center text-ui text-muted-foreground">
            {query ? "No matching tabs" : missing.length ? "No browser is connected yet" : "No open tabs Mako can reach"}
          </p>
        ) : null}
        {missing.length ? (
          <Group title="Not connected">
            {missing.map((browser) => (
              <BrowserRow key={browser.id} browser={browser} />
            ))}
          </Group>
        ) : null}
      </div>
      <p className="border-t border-hairline px-3 py-2 text-label text-faint">
        The tab comes forward; click what you mean and it lands here as context.
      </p>
    </div>
  )
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="pb-1">
      {title ? <p className="px-2.5 pt-1.5 pb-1 text-label text-faint">{title}</p> : null}
      {children}
    </div>
  )
}

function BrowserMark({ browser }: { browser?: ElementPickBrowser }) {
  if (browser?.icon) return <img src={browser.icon} alt="" className="size-4 shrink-0 object-contain" />
  return browser?.kind === "app"
    ? <AppWindowIcon aria-hidden className="size-4 shrink-0 text-faint" />
    : <GlobeIcon aria-hidden className="size-4 shrink-0 text-faint" />
}

function TabRow({ tab, browser, onPick }: { tab: ElementPickTab; browser?: ElementPickBrowser; onPick: (tab: ElementPickTab) => void }) {
  const host = tabHost(tab.url)
  return (
    <button
      type="button"
      onClick={() => onPick(tab)}
      title={tab.url}
      aria-label={`Pick an element in ${tab.title || host}`}
      className="pressable flex min-h-11 w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-fill-hover focus-visible:bg-fill-selected"
    >
      <BrowserMark browser={browser} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui">{tab.title || host}</span>
        <span className="block truncate text-label text-muted-foreground">
          {host}
          {browser ? <span className="text-faint"> · {browser.name}</span> : null}
        </span>
      </span>
      {tab.inUse ? <span className="shrink-0 text-label text-faint">Agent’s tab</span> : null}
    </button>
  )
}

function BrowserRow({ browser }: { browser: ElementPickBrowser }) {
  const [connecting, setConnecting] = useState(false)
  const setup = browser.status === "setup-required"
  const waiting = browser.status === "connecting" || connecting
  const reason = setup
    ? `Add the Mako Browser extension to ${browser.name} to pick in its tabs.`
    : browser.status === "unavailable"
      ? browser.reason ?? `${browser.name} isn’t reachable.`
      : waiting
        ? "Waiting for the browser…"
        : `Turn on browser use to pick in ${browser.name}’s tabs.`
  return (
    // Not a pickable row, but its Connect or Set up works: nothing here is disabled.
    <div className="flex min-h-11 items-center gap-3 rounded-md px-2.5 py-1.5">
      <span className="opacity-60"><BrowserMark browser={browser} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-muted-foreground">{browser.name}</span>
        <span className="block text-label text-faint">{reason}</span>
      </span>
      {setup || browser.status === "unavailable" ? (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "mcp#browser-use" }))}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover"
        >
          Set up
        </button>
      ) : (
        <button
          type="button"
          disabled={waiting}
          onClick={async () => {
            setConnecting(true)
            try {
              await elementPicks.connect(browser.id)
            } finally {
              setConnecting(false)
            }
          }}
          className={cn("pressable shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover", waiting && "opacity-60")}
        >
          {waiting ? "Connecting…" : "Connect"}
        </button>
      )}
    </div>
  )
}
