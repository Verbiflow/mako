import { lazy, Suspense } from "react"
import type { OfficeFormat } from "@mako/host/contracts/file-preview"
import { LazyBoundary } from "@/components/ui/lazy-boundary"
import { LazyFailed } from "@/components/ui/lazy-failed"

const OfficeDocument = lazy(() => import("./office-document"))
export function OfficePreview({
  url,
  name,
  format,
  expanded = false,
}: {
  url: string
  name: string
  format: OfficeFormat
  expanded?: boolean
}) {
  return (
    <LazyBoundary fallback={() => <LazyFailed what="The document" />}>
      <Suspense
        fallback={
          <p role="status" className="p-4 text-ui text-faint">
            Loading document…
          </p>
        }
      >
        <OfficeDocument key={url} url={url} name={name} format={format} expanded={expanded} />
      </Suspense>
    </LazyBoundary>
  )
}
