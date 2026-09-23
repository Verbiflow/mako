import { lazy, Suspense } from "react"
import { Shimmer } from "@/components/ui/shimmer"

const Panel = lazy(() =>
  import("@/components/inspector/terminal-panel").then((module) => ({
    default: module.TerminalPanel,
  }))
)

export function TerminalPanel() {
  return (
    <Suspense fallback={<p className="p-3 text-ui"><Shimmer text="Loading terminal…" /></p>}>
      <Panel />
    </Suspense>
  )
}
