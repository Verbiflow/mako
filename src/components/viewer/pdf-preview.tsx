import { lazy, Suspense } from "react"

const PdfDocument = lazy(() => import("./pdf-document"))

/** The document engine loads only when someone opens a PDF. */
export function PdfPreview({ url, name, expanded = false }: { url: string; name: string; expanded?: boolean }) {
  return <Suspense fallback={<p className="p-4 text-ui text-muted-foreground">Loading document…</p>}><PdfDocument key={url} url={url} name={name} expanded={expanded} /></Suspense>
}
