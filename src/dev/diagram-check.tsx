// Isolated renderer regression fixture. Never opens a provider session.
import { useState } from "react"
import { DiagramPreview } from "@/components/transcript/code-preview"
import { TooltipProvider } from "@/components/ui/tooltip"
import "../index.css"

const source = `flowchart TB
  subgraph current["Your screenshot: separate hosts"]
    A["Installed app"] --> B["Installed host + running agent"]
    C["Dev window"] --> D["Dev host"]
    D --> E["Reply blocked: would open a second agent"]
    B --> F[("Shared provider history + session ledger")]
    D -. "Reads the same history" .-> F
  end
  subgraph desired["Shared host: reply from either window"]
    G["Installed app"] --> I["One host routes both windows' messages"]
    H["Dev window"] --> I
    I --> J["Same running agent"]
    J --> K[("Session history")]
  end`

// A diagram must not need an observer notification to begin rendering.
// Withhold those notifications while leaving real DOM layout and Mermaid intact.
if (new URLSearchParams(location.search).has("without-visibility")) {
  window.IntersectionObserver = class implements IntersectionObserver {
    readonly root = null
    readonly rootMargin = "0px"
    readonly scrollMargin = "0px"
    readonly thresholds = [0]
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  }
}

export function Fixture() {
  const [shown, setShown] = useState(true)
  const [invalid, setInvalid] = useState(false)
  return <TooltipProvider>
    <main className="h-screen overflow-auto bg-surface p-4 text-foreground">
      <button type="button" onClick={() => setShown((value) => !value)}>Toggle diagram</button>
      <button type="button" onClick={() => setInvalid((value) => !value)}>Toggle invalid source</button>
      <article className="contain-turn">
        {shown ? <DiagramPreview source={invalid ? "not a diagram" : source} /> : <pre>{source}</pre>}
      </article>
    </main>
  </TooltipProvider>
}
