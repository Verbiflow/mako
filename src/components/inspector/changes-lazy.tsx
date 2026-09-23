import { lazy, Suspense } from "react"
import { GitLoading } from "@/components/inspector/git-loading"

/**
 * Pierre's diff engine drags in a syntax-highlighting runtime, which has no
 * business being in the boot path — it loads the first time the panel is
 * opened and never again.
 */
const Panel = lazy(() =>
  import("@/components/inspector/changes-panel").then((module) => ({
    default: module.ChangesPanel,
  }))
)

export function ChangesPanel() {
  return (
    <Suspense fallback={<GitLoading label="Loading changes…" />}>
      <Panel />
    </Suspense>
  )
}
