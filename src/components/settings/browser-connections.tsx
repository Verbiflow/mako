import { useId, useState } from "react"
import {
  CheckIcon,
  ChevronRightIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"
import { ActivityMark } from "@/components/ui/activity-mark"
import { Action } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { mcp, useMcp } from "@/state/mcp"
import type { BrowserControlStatus } from "@/lib/types"

function connectionText(browser: BrowserControlStatus): string {
  switch (browser.connection.status) {
    case "connected":
      return "Ready for browser tasks"
    case "connecting":
      return "Getting ready…"
    case "awaiting-approval":
      return "Waiting for browser approval…"
    case "unavailable":
      return browser.connection.reason
    case "disconnected":
      return "Browser access is off"
  }
}

function browserTitle(browser: BrowserControlStatus) {
  // Older saved preferences may still carry the old generated label.
  return (
    browser.product ??
    browser.name.replace(/ profile [a-f0-9]{6}$/, "").split(" · ")[0]!
  )
}
function BrowserIcon({
  browser,
  small = false,
}: {
  browser: BrowserControlStatus
  small?: boolean
}) {
  const product = browserTitle(browser).toLowerCase()
  const source =
    product === "aside"
      ? "/browser-icons/aside.png"
      : product === "chrome" || product === "google chrome"
        ? "/browser-icons/chrome.png"
        : null
  return source ? (
    <img
      src={source}
      alt=""
      className={cn("shrink-0 object-contain", small ? "size-5" : "size-9")}
    />
  ) : (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl bg-fill-selected text-title font-medium",
        small ? "size-5 text-label" : "size-11"
      )}
    >
      {browserTitle(browser).slice(0, 1)}
    </span>
  )
}
function ConnectionAction({ browser }: { browser: BrowserControlStatus }) {
  const [pending, setPending] = useState(false)
  const active = ["connected", "connecting", "awaiting-approval"].includes(
    browser.connection.status
  )
  return (
    <Action
      tone={active ? "ghost" : "outline"}
      disabled={pending}
      onClick={async () => {
        if (pending) return
        setPending(true)
        try {
          await (active
            ? mcp.disconnectBrowser(browser.id)
            : mcp.connectBrowser(browser.id))
        } finally {
          setPending(false)
        }
      }}
    >
      {pending
        ? "Updating…"
        : active
          ? browser.connection.status === "connected"
            ? "Turn off access"
            : "Cancel"
          : "Enable access"}
    </Action>
  )
}
function BrowserChoice({
  browser,
  saving,
}: {
  browser: BrowserControlStatus
  saving: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const instructionsId = useId()
  return (
    <div data-browser-choice>
      <div className={cn(
        "flex items-center rounded-md transition-colors duration-(--duration-press) ease-(--ease-out) motion-reduce:transition-none",
        browser.preferred ? "bg-fill-selected/50" : "hover:bg-fill-hover"
      )}>
        <label
          title={browser.profileName ?? browserTitle(browser)}
          className="relative block min-w-0 flex-1 cursor-pointer"
        >
          <input
            type="radio"
            name="preferred-browser"
            value={browser.id}
            checked={browser.preferred === true}
            disabled={saving}
            onChange={() => void mcp.preferBrowser(browser.id)}
            aria-label={`Prefer ${browserTitle(browser)}${browser.profileName ? ` · ${browser.profileName}` : ""}`}
            className="peer sr-only"
          />
          <span className="pressable flex min-h-18 items-center gap-3 rounded-md px-3 py-3 transition-colors duration-(--duration-press) ease-(--ease-out) peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-foreground peer-disabled:opacity-50 motion-reduce:transition-none">
            <BrowserIcon browser={browser} />
            <span className="min-w-0 flex-1 pr-6">
              <span className="block truncate text-ui font-medium">
                {browserTitle(browser)}
              </span>
              <span className="mt-0.5 block truncate text-label text-muted-foreground">
                {browser.profileName ??
                  (browser.transport === "direct"
                    ? "Direct connection"
                    : "Unnamed profile")}
              </span>
            </span>
          </span>
          {browser.preferred ? (
            <span
              className="absolute top-1/2 right-3 flex size-5 -translate-y-1/2 items-center justify-center text-foreground"
            >
              <CheckIcon aria-hidden="true" className="size-4" />
            </span>
          ) : null}
        </label>
        {browser.guidance ? (
          <button
            type="button"
            aria-label={`${expanded ? "Hide" : "Show"} ${browserTitle(browser)} setup instructions`}
            aria-expanded={expanded}
            aria-controls={instructionsId}
            onClick={() => setExpanded(!expanded)}
            className="pressable mr-2 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-4 transition-transform duration-(--duration-press) ease-(--ease-out) motion-reduce:transition-none",
                expanded && "rotate-90"
              )}
            />
          </button>
        ) : null}
      </div>
      {browser.guidance ? (
        <div
          id={instructionsId}
          hidden={!expanded}
          className="mx-3 border-t border-hairline py-3 pr-3 pl-12 text-label leading-relaxed text-muted-foreground"
        >
          <p>Aside’s text-selection popup can interrupt browser control.</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>
              Open{" "}
              <span className="text-foreground">Aside Settings → Lasso</span>.
            </li>
            <li>
              Turn off{" "}
              <span className="text-foreground">Enable on text selection</span>.
            </li>
            <li>Start your next task in a new tab.</li>
          </ol>
        </div>
      ) : null}
    </div>
  )
}
export function BrowserConnections() {
  const browsers = useMcp((state) => state.browsers).filter(
    (browser) => browser.kind !== "desk"
  )
  const setup = useMcp((state) => state.browserSetup)
  const preparing = useMcp((state) => state.preparingBrowser)
  const saving = useMcp((state) => state.selectingBrowser)
  const regular = browsers.filter((browser) => browser.transport !== "direct")
  const direct = browsers.filter((browser) => browser.transport === "direct")
  const selected = browsers.find((browser) => browser.preferred)
  return (
    <section aria-label="Browser use" className="mb-6 py-2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-title font-medium">Browser</h3>
          <p className="mt-1 text-ui text-muted-foreground">
            Where agents open new tabs.
          </p>
        </div>
        <Action
          size="sm"
          disabled={preparing}
          onClick={() => void mcp.prepareBrowser()}
        >
          <PlusIcon aria-hidden="true" />
          {preparing ? "Preparing…" : "Add browser"}
        </Action>
      </div>
      <fieldset
        disabled={saving}
        className="mt-4 min-w-0 space-y-1 rounded-lg bg-shell/40 p-1 ring-1 ring-hairline"
      >
        <legend className="sr-only">Preferred browser profile</legend>
        {regular.map((browser) => (
          <BrowserChoice key={browser.id} browser={browser} saving={saving} />
        ))}
      </fieldset>
      {!regular.length ? (
        <div className="mt-4 rounded-xl border border-dashed border-hairline px-5 py-6">
          <p className="text-ui font-medium">Add a browser</p>
          <p className="mt-1 text-label leading-relaxed text-muted-foreground">
            Install the Mako Browser extension in the browser you already use.
          </p>
        </div>
      ) : null}
      {selected ? (
        <div className="mt-3 flex items-center justify-between gap-3 px-1">
          <p
            role="status"
            className="flex min-w-0 items-center gap-2 text-label text-muted-foreground"
          >
            {selected.connection.status === "connecting" ? (
              <ActivityMark state="connecting" size={20} />
            ) : null}
            {connectionText(selected)}
          </p>
          {selected.connection.status !== "connected" ? (
            <ConnectionAction browser={selected} />
          ) : null}
        </div>
      ) : (
        <p role="status" className="mt-3 text-label text-faint">
          {saving ? "Saving…" : "Choose a browser for new tasks."}
        </p>
      )}
      {selected &&
      !selected.profileName &&
      selected.transport === "extension" ? (
        <p className="mt-2 text-label text-muted-foreground">
          To name this profile, open the Mako Browser extension in that browser
          and enter its profile name.
        </p>
      ) : null}
      {selected?.lastInterruption ? (
        <details className="mt-3 text-label text-muted-foreground">
          <summary className="cursor-pointer">Last interruption</summary>
          <p className="mt-2 leading-relaxed">
            {selected.lastInterruption.message}
          </p>
        </details>
      ) : null}
      <details
        className="group mt-4 border-t border-hairline pt-3"
        data-browser-options
        open={direct.some((browser) => browser.preferred) || undefined}
      >
        <summary className="pressable flex cursor-pointer list-none items-center gap-1.5 text-label text-muted-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 transition-transform duration-(--duration-press) ease-(--ease-out) group-open:rotate-90 motion-reduce:transition-none"
          />
          Manage browsers
        </summary>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Action size="xs" onClick={() => void mcp.refreshBrowsers()}>
            <RefreshCwIcon aria-hidden="true" />
            Refresh browsers
          </Action>
          {selected ? (
            <>
              <Action
                size="xs"
                disabled={saving}
                onClick={() => void mcp.preferBrowser(null)}
              >
                Clear selection
              </Action>
              {selected.connection.status === "connected" ? (
                <ConnectionAction browser={selected} />
              ) : null}
            </>
          ) : null}
        </div>
        <p className="mt-2 text-label text-faint">
          Changing your browser applies to new tasks. Existing tasks keep their
          browser.
        </p>
        {direct.length ? (
          <div
            data-direct-connections
            className="mt-4 border-t border-hairline pt-3"
          >
            <p className="text-label font-medium">Direct debugging</p>
            <p className="mt-3 text-label leading-relaxed text-muted-foreground">
              Direct debugging uses the running browser session. The browser
              asks for approval on each new connection.
            </p>
            <div className="mt-3 rounded-lg bg-shell/40 p-1 ring-1 ring-hairline">
              {direct.map((browser) => (
                <BrowserChoice
                  key={browser.id}
                  browser={browser}
                  saving={saving}
                />
              ))}
            </div>
          </div>
        ) : null}
      </details>
      {setup ? (
        <div className="mt-3 rounded-lg border border-hairline p-4 text-label leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">
            Add the Mako Browser extension
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>
              Open <code>chrome://extensions</code> in your browser and enable
              Developer mode.
            </li>
            <li>
              Choose <span className="text-foreground">Load unpacked</span>,
              then select this folder.
            </li>
          </ol>
          <input
            aria-label="Browser extension folder"
            readOnly
            value={setup.directory}
            className="mt-3 w-full rounded border border-hairline bg-transparent px-2 py-1.5 font-mono text-code"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="mt-2">
            Approve its permission, then refresh this list.
          </p>
        </div>
      ) : null}
    </section>
  )
}
