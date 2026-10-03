import { scheduleFileInspection } from "@/lib/file-inspections"
import { useEffect, useMemo, useState } from "react"
import { formatBytes } from "@/lib/attachments"
import type { DiagnosticFormat } from "../../../electron/contracts/file-preview"
import type { DiagnosticSummary } from "@/lib/diagnostic-summary"

type Result =
  | { kind: "ready"; summary: DiagnosticSummary }
  | { kind: "error"; message: string }
export function DiagnosticPreview({
  url,
  format,
  expanded = false,
}: {
  url: string
  format: DiagnosticFormat
  expanded?: boolean
}) {
  const [result, setResult] = useState<{
    url: string
    format: DiagnosticFormat
    value: Result
  }>()
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    let release: (() => void) | undefined
    const finish = (value: Result) => {
      if (!current) return
      setResult({ url, format, value })
      release?.()
      release = undefined
    }
    release = scheduleFileInspection(
      () => {
        let worker: Worker
        try {
          worker = new Worker(
            new URL("../../lib/diagnostic-worker.ts", import.meta.url),
            { type: "module" }
          )
        } catch {
          queueMicrotask(() =>
            finish({
              kind: "error",
              message:
                "The inspection worker could not start. Try again or open the original.",
            })
          )
          return () => {}
        }
        const timer = setTimeout(
          () =>
            finish({
              kind: "error",
              message:
                "Inspection took too long. Open the original in a dedicated profiler.",
            }),
          15_000
        )
        worker.onmessage = (event: MessageEvent<Result>) => finish(event.data)
        worker.onerror = () =>
          finish({
            kind: "error",
            message:
              "The inspection worker stopped. Try again or open the original file.",
          })
        worker.postMessage({ url, format })
        return () => {
          clearTimeout(timer)
          worker.terminate()
        }
      },
      () =>
        finish({
          kind: "error",
          message:
            "Too many inspections are open. Close a preview and try again.",
        })
    )
    return () => {
      current = false
      release?.()
    }
  }, [url, format, attempt])
  const value =
    result?.url === url && result.format === format ? result.value : undefined
  const rows = useMemo(
    () =>
      value?.kind === "ready"
        ? value.summary.rows.filter((row) =>
            row.cells.some((cell) =>
              cell.toLowerCase().includes(query.toLowerCase())
            )
          )
        : [],
    [value, query]
  )
  if (!value)
    return (
      <p role="status" className="p-4 text-ui text-faint">
        Inspecting diagnostic file…
      </p>
    )
  if (value.kind === "error")
    return (
      <div className="flex flex-col gap-2 p-4 text-ui">
        <p className="text-muted-foreground">{value.message}</p>
        <button
          className="pressable self-start rounded-md bg-raised px-3 py-1.5"
          onClick={() => {
            setResult(undefined)
            setAttempt((value) => value + 1)
          }}
        >
          Try again
        </button>
      </div>
    )
  const { summary } = value
  const pages = Math.max(1, Math.ceil(rows.length / 50)),
    shownPage = Math.min(page, pages - 1)
  return (
    <section
      aria-label={summary.title}
      className={`flex min-h-64 flex-col text-ui ${expanded ? "h-[calc(100dvh-6rem)]" : ""}`}
    >
      <div className="grid grid-cols-2 gap-3 border-b border-hairline p-4 sm:grid-cols-4">
        {summary.metrics.map((metric) => (
          <div key={metric.label}>
            <p className="text-label text-faint">{metric.label}</p>
            <p className="mt-1 font-medium tabular-nums">
              {metric.unit === "bytes"
                ? formatBytes(metric.value)
                : `${metric.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${metric.unit === "ms" ? " ms" : ""}`}
            </p>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        <input
          aria-label="Filter diagnostic rows"
          placeholder="Filter rows…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(0)
          }}
          className="min-w-0 flex-1 rounded-md bg-raised px-3 py-1.5 text-ui outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <span className="shrink-0 text-label text-faint tabular-nums">
          {rows.length.toLocaleString()} rows
        </span>
      </div>
      <div className={`${expanded ? "min-h-0 flex-1" : "max-h-80"} overflow-auto px-4`}>
        <table className="w-full border-collapse text-label">
          <thead className="sticky top-0 bg-surface">
            <tr>
              {summary.columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-hairline px-2 py-2 text-left font-medium text-muted-foreground"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows
              .slice(shownPage * 50, (shownPage + 1) * 50)
              .map((row, index) => (
                <tr
                  key={shownPage * 50 + index}
                  className="hover:bg-fill-hover"
                >
                  {row.cells.map((cell, column) => (
                    <td
                      key={column}
                      className="max-w-72 border-b border-hairline px-2 py-2 tabular-nums"
                    >
                      <span className="block truncate" title={cell}>
                        {cell}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="py-5 text-faint">No matching rows.</p>
        ) : null}
      </div>
      {pages > 1 ? (
        <div className="flex items-center justify-end gap-3 px-4 py-2 text-label">
          <button
            className="pressable"
            disabled={shownPage === 0}
            onClick={() => setPage(shownPage - 1)}
          >
            Previous
          </button>
          <span>
            {shownPage + 1} of {pages} pages
          </span>
          <button
            className="pressable"
            disabled={shownPage + 1 >= pages}
            onClick={() => setPage(shownPage + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
      <div className="space-y-1 border-t border-hairline px-4 py-3 text-label leading-relaxed text-faint">
        {summary.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
    </section>
  )
}
