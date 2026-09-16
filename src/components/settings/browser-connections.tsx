import { Action } from "@/components/ui/kit"
import { mcp, useMcp } from "@/state/mcp"
import type { BrowserControlStatus } from "@/lib/types"

function connectionText(
  connection: BrowserControlStatus["connection"]
): string {
  switch (connection.status) {
    case "connected":
      return "Connected. Tasks share this connection and keep separate tabs."
    case "connecting":
      return "Connecting to the Mako Browser extension…"
    case "awaiting-approval":
      return "Connecting. Allow the browser’s debugging connection if prompted."
    case "unavailable":
      return connection.reason
    case "disconnected":
      return "Connect through the Mako Browser extension."
  }
}

export function BrowserConnections() {
  const browsers = useMcp((state) => state.browsers)
  const setup = useMcp((state) => state.browserSetup)
  const preparing = useMcp((state) => state.preparingBrowser)
  return (
    <div className="mb-4 border-y border-hairline py-3">
      <p className="text-ui font-medium">Browser access</p>
      <p className="mt-1 text-label text-faint">
        Install Mako Browser once in each browser profile. Its permission stays
        with the extension when Mako or the browser restarts.
      </p>
      <div className="mt-3 flex gap-2">
        <Action
          tone="outline"
          disabled={preparing}
          onClick={() => void mcp.prepareBrowser()}
        >
          {preparing ? "Preparing…" : "Set up browser extension"}
        </Action>
        <Action tone="ghost" onClick={() => void mcp.refreshBrowsers()}>
          Refresh profiles
        </Action>
      </div>
      {setup ? (
        <div className="mt-3 border-l border-hairline pl-3 text-ui text-muted-foreground">
          <p>
            In your Chromium browser, open <code>chrome://extensions</code>,
            enable Developer mode, then choose Load unpacked and select this
            folder:
          </p>
          <input
            aria-label="Browser extension folder"
            readOnly
            value={setup.directory}
            className="text-code mt-2 w-full rounded border border-hairline bg-transparent px-2 py-1 font-mono"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="mt-2">
            Approve the extension’s browser permission, then refresh profiles
            here. Your browser may show a banner while a page is controlled.
          </p>
        </div>
      ) : null}
      {browsers.length === 0 ? (
        <p className="mt-3 text-ui text-muted-foreground">
          No browser profiles connected yet. Install the extension to connect
          your profile.
        </p>
      ) : (
        browsers.map((browser) => (
          <div key={browser.id} className="mt-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-ui">{browser.name}</p>
              <p
                role="status"
                className="mt-0.5 text-label text-muted-foreground"
              >
                {connectionText(browser.connection)}
              </p>
            </div>
            {browser.connection.status === "connected" ||
            browser.connection.status === "connecting" ||
            browser.connection.status === "awaiting-approval" ? (
              <Action
                tone="outline"
                onClick={() => void mcp.disconnectBrowser(browser.id)}
              >
                {browser.connection.status !== "connected"
                  ? "Cancel connection"
                  : "Disconnect"}
              </Action>
            ) : (
              <Action
                tone="outline"
                onClick={() => void mcp.connectBrowser(browser.id)}
              >
                Connect
              </Action>
            )}
          </div>
        ))
      )}
    </div>
  )
}
