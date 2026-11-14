import { lazy, Suspense } from "react"
import type { OfficeFormat } from "@mako/host/contracts/file-preview"
import { LazyBoundary } from "@/components/ui/lazy-boundary"
import { LazyFailed } from "@/components/ui/lazy-failed"
import { PatientFallback } from "@/components/ui/patient-fallback"

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
          <PatientFallback what="the document">
            <p role="status" className="p-4 text-ui text-faint">
              Loading document…
            </p>
          </PatientFallback>
        }
      >
        <OfficeDocument key={url} url={url} name={name} format={format} expanded={expanded} />
      </Suspense>
    </LazyBoundary>
  )
}
