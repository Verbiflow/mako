import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import { ErrorBoundary } from "./components/shell/error-boundary.tsx"
import { watchForFailures } from "./desk/failures.ts"

async function start() {
  // `?mock` boots the desk against fixtures so the UI can be worked on in a
  // plain browser. Tree-shaken out of production builds.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    const { installMockBridge } = await import("./dev/mock-bridge.ts")
    installMockBridge()
  } else if (!window.mako && /^(https?):$/.test(location.protocol)) {
    const { installWebBridge } = await import("./dev/web-bridge.ts")
    await installWebBridge()
  }

  const { default: App } = await import("./App.tsx")
  watchForFailures()

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
}

void start().catch((error) => {
  createRoot(document.getElementById("root")!).render(
    <div className="p-8 text-ui text-foreground">
      <p>{error instanceof Error ? error.message : "Mako could not start"}</p>
      <button
        className="pressable mt-4 rounded border border-hairline px-3 py-2"
        onClick={() => location.reload()}
      >
        Retry connection
      </button>
    </div>
  )
})
