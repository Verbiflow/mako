import { useCallback, useEffect, useRef, useState } from "react"
import { getDocument, PDFWorker, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist"
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"

/** One rendered page at a time; closing the preview releases its worker and document. */
export default function PdfDocument({ url, name, expanded = false }: { url: string; name: string; expanded?: boolean }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [error, setError] = useState(false)
  const [width, setWidth] = useState(500)
  const fail = useCallback(() => setError(true), [])
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = host.current
    if (!node) return
    const resize = new ResizeObserver(() => setWidth(Math.max(1, node.clientWidth - 32)))
    resize.observe(node)
    return () => resize.disconnect()
  }, [])

  useEffect(() => {
    let current = true
    // Use the bundled worker directly: PDF.js treats custom desktop origins as
    // opaque and otherwise constructs a cross-origin blob wrapper/fake worker.
    const port = new Worker(workerUrl, { type: "module" })
    const worker = PDFWorker.create({ port })
    const loading = getDocument({ url, worker })
    port.addEventListener("error", fail)
    void loading.promise.then(
      (pdf) => { if (current) setDocument(pdf) },
      () => { if (current) setError(true) }
    )
    return () => {
      current = false
      port.removeEventListener("error", fail)
      void loading.destroy()
      worker.destroy()
      port.terminate()
    }
  }, [url, fail])


  return (
    <div ref={host} className={`${expanded ? "h-full" : "max-h-[60vh]"} overflow-y-auto bg-background`}>
      {error ? <p role="status" className="p-4 text-ui text-muted-foreground">This document could not be previewed. Open the original file to view it.</p> : (
        <>
          <div className="sticky top-0 z-10 flex items-center justify-center gap-3 border-b border-hairline bg-popover px-3 py-2 text-label">
            <button type="button" disabled={!document || pageNumber === 1} onClick={() => setPageNumber((page) => page - 1)} className="pressable rounded px-2 py-1 hover:bg-fill-hover disabled:opacity-40">Previous page</button>
            <span aria-live="polite">{document ? `${pageNumber} / ${document.numPages}` : "Loading document…"}</span>
            <button type="button" disabled={!document || pageNumber === document.numPages} onClick={() => setPageNumber((page) => page + 1)} className="pressable rounded px-2 py-1 hover:bg-fill-hover disabled:opacity-40">Next page</button>
          </div>
          {document ? <PdfPage key={`${pageNumber}:${width}`} document={document} pageNumber={pageNumber} width={width} name={name} onError={fail} /> : null}
        </>
      )}
    </div>
  )
}

function PdfPage({ document, pageNumber, width, name, onError }: { document: PDFDocumentProxy; pageNumber: number; width: number; name: string; onError(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [words, setWords] = useState("")
  useEffect(() => {
    const node = canvas.current
    if (!node) return
    let current = true
    let render: RenderTask | undefined
    void document.getPage(pageNumber).then(async (page) => {
      if (!current) return
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: width / base.width })
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      node.width = Math.ceil(viewport.width * scale)
      node.height = Math.ceil(viewport.height * scale)
      node.style.width = `${viewport.width}px`
      node.style.height = `${viewport.height}px`
      render = page.render({ canvas: node, viewport, transform: [scale, 0, 0, scale, 0, 0] })
      await render.promise
      const text = await page.getTextContent()
      if (current) {
        setWords(text.items.flatMap((item) => "str" in item ? [item.str] : []).join(" "))
        setReady(true)
      }
    }).catch(() => { if (current) onError() })
    return () => { current = false; render?.cancel() }
  }, [document, pageNumber, width, onError])

  return <div className="p-4" aria-busy={!ready}><canvas ref={canvas} role="img" aria-label={`${name}, page ${pageNumber}`} className="mx-auto max-w-full" /><p className="sr-only">{words}</p></div>
}
