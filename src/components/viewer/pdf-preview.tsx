import { lazy, Suspense } from "react"
import { LazyBoundary } from "@/components/ui/lazy-boundary"
import { LazyFailed } from "@/components/ui/lazy-failed"

const PdfDocument = lazy(() => import("./pdf-document"))

/** The document engine loads only when someone opens a PDF. */
export function PdfPreview({ url, name, expanded = false }: { url: string; name: string; expanded?: boolean }) {
  return <LazyBoundary fallback={() => <LazyFailed what="The document" />}><Suspense fallback={<p className="p-4 text-ui text-muted-foreground">Loading document…</p>}><PdfDocument key={url} url={url} name={name} expanded={expanded} /></Suspense></LazyBoundary>
}
