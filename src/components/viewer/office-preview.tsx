import { lazy, Suspense } from "react"
import type { OfficeFormat } from "../../../electron/contracts/file-preview"

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
    <Suspense
      fallback={
        <p role="status" className="p-4 text-ui text-faint">
          Loading document…
        </p>
      }
    >
      <OfficeDocument key={url} url={url} name={name} format={format} expanded={expanded} />
    </Suspense>
  )
}
