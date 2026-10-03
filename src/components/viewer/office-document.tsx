import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  FileViewer,
  type FileViewerHandle,
  type ViewerOptions,
  type ViewerState,
} from "@file-viewer/react"
import { readOfficeInput } from "@/lib/office-input"
import { scheduleFileInspection } from "@/lib/file-inspections"
import { visiblePreviewDeadline } from "@/lib/preview-deadline"
import { usePrefs } from "@/state/prefs"
import type { OfficeFormat } from "../../../electron/contracts/file-preview"

const asset = (path: string) =>
  new URL(
    `${import.meta.env.BASE_URL}file-viewer/vendor/${path}`,
    document.baseURI
  ).href
async function documentOptions(format: OfficeFormat): Promise<ViewerOptions> {
  const renderer =
    format === "word"
      ? (await import("@file-viewer/renderer-word")).wordRenderer
      : format === "workbook"
        ? (await import("@file-viewer/renderer-spreadsheet"))
            .spreadsheetRenderer
        : (await import("@file-viewer/renderer-pptx")).pptxRenderer
  return {
    builtinRenderers: "none",
    autoRenderers: false,
    renderers: [
      {
        id: renderer.id,
        definitions: renderer.definitions,
        assets: renderer.assets,
        handlers: renderer.handlers?.map(({ rendererId, handler }) => ({
          rendererId,
          handler: (buffer, target, type, context) => {
            if (!(target instanceof HTMLDivElement))
              throw new Error(
                "The document renderer requires a document container."
              )
            return handler(buffer, target, type, context)
          },
        })),
      },
    ],
    rendererMode: "replace",
    styleIsolation: "none",
    locale: "en-US",
    theme: "system",
    ui: { density: "compact", surfaceBackground: "var(--surface)" },
    fit: {
      mode: format === "presentation" ? "contain" : "width",
      resize: "until-interaction",
      padding: 16,
    },
    toolbar: {
      download: false,
      print: false,
      exportHtml: false,
      search: true,
      zoom: true,
      theme: false,
    },
    docx: {
      worker: true,
      workerUrl: asset("docx/docx.worker.js"),
      workerJsZipUrl: asset("docx/jszip.min.js"),
      workerTimeout: 15_000,
      progressive: true,
      renderPageBatchSize: 2,
      renderYieldEveryMs: 8,
      externalLinkPolicy: "block",
      externalResourcePolicy: "block",
    },
    spreadsheet: { worker: true, workerUrl: asset("xlsx/sheet.worker.js") },
    presentation: {
      workerUrl: asset("pptx/pptx.worker.js"),
      workerType: "module",
    },
  }
}
type Loaded = { buffer: ArrayBuffer; options: ViewerOptions }
export default function OfficeDocument({
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
  const viewer = useRef<FileViewerHandle>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cancelRenderDeadline = useRef<() => void>(undefined)
  const releaseJob = useRef<() => void>(undefined)
  const [loaded, setLoaded] = useState<Loaded>()
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)
  const [started, setStarted] = useState(false)
  const theme = usePrefs((prefs) => prefs.theme)
  const options = useMemo(() => loaded ? { ...loaded.options, theme } : undefined, [loaded, theme])
  useEffect(() => {
    const controller = new AbortController()
    releaseJob.current = scheduleFileInspection(
      () => {
        setStarted(true)
        timer.current = setTimeout(() => {
          controller.abort()
          viewer.current?.destroy()
          releaseJob.current?.()
          setError("Preview took too long. Open the original in your editor.")
        }, 20_000)
        void Promise.all([
          readOfficeInput(url, controller.signal),
          documentOptions(format),
        ]).then(
          ([buffer, options]) => {
            if (!controller.signal.aborted) {
              clearTimeout(timer.current)
              cancelRenderDeadline.current = visiblePreviewDeadline(20_000, () => {
                controller.abort()
                viewer.current?.destroy()
                releaseJob.current?.()
                setError("Preview took too long. Open the original in your editor.")
              })
              setLoaded({ buffer, options })
            }
          },
          (failure) => {
            if (!controller.signal.aborted) {
              clearTimeout(timer.current)
              releaseJob.current?.()
              setError(
                failure instanceof Error
                  ? failure.message
                  : "This document could not be previewed."
              )
            }
          }
        )
        return () => {
          controller.abort()
          clearTimeout(timer.current)
          cancelRenderDeadline.current?.()
        }
      },
      () =>
        setError(
          "Too many file previews are open. Close a preview and try again."
        )
    )
    return () => releaseJob.current?.()
  }, [url, format])
  const onStateChange = useCallback((state: ViewerState) => {
    if (state.error) {
      clearTimeout(timer.current)
      cancelRenderDeadline.current?.()
      releaseJob.current?.()
      setError(
        state.error instanceof Error
          ? state.error.message
          : "This document could not be previewed."
      )
    }
    if (state.ready) {
      clearTimeout(timer.current)
      cancelRenderDeadline.current?.()
      setReady(true)
    }
  }, [])
  // I/O has a wall-clock deadline. Rendering has a visible-time deadline because
  // browsers suspend the library's paint and fitting callbacks in hidden tabs.
  if (error)
    return (
      <p role="status" className="p-4 text-ui text-muted-foreground">
        {error}
      </p>
    )
  if (!loaded)
    return (
      <p role="status" className="p-4 text-ui text-faint">
        {started ? "Reading document…" : "Waiting to preview document…"}
      </p>
    )
  return (
    <div
      className={`office-preview relative ${expanded ? "h-[calc(100dvh-6rem)]" : "h-96"} overflow-hidden`}
      data-office-preview={format}
      data-ready={ready || undefined}
    >
      <FileViewer
        ref={viewer}
        buffer={loaded.buffer}
        filename={name}
        options={options}
        onStateChange={onStateChange}
      />
    </div>
  )
}
