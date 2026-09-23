import { Shimmer } from "@/components/ui/shimmer"
import { Skeleton } from "@/components/ui/skeleton"

const FILE_WIDTHS = ["w-4/5", "w-3/5", "w-11/12", "w-2/3", "w-3/4", "w-1/2"]
const CODE_LINES = [
  { indent: "", width: "w-2/5" },
  { indent: "ml-4", width: "w-3/5" },
  { indent: "ml-4", width: "w-1/2" },
  { indent: "ml-8", width: "w-2/3" },
  { indent: "ml-8", width: "w-1/3" },
  { indent: "ml-4", width: "w-1/4" },
  { indent: "", width: "w-1/12" },
  { indent: "", width: "w-1/2" },
  { indent: "ml-4", width: "w-3/4" },
]

export function GitLoading({
  label,
  kind = "changes",
}: {
  label: string
  kind?: "changes" | "history" | "diff"
}) {
  return (
    <div role="status" className="min-w-0 px-3 py-4">
      <p className="mb-4 text-label">
        <Shimmer text={label} />
      </p>
      {kind === "diff" ? <DiffRows /> : kind === "history" ? <HistoryRows /> : <FileRows />}
    </div>
  )
}

function FileRows() {
  return (
    <div className="skeleton-rows flex flex-col gap-3.5">
      {FILE_WIDTHS.map((width) => (
        <div key={width} className="flex items-center gap-3">
          <Skeleton className="size-3.5 shrink-0" />
          <Skeleton className={`h-2.5 ${width}`} />
          <Skeleton className="ml-auto h-2 w-8 shrink-0 opacity-60" />
        </div>
      ))}
    </div>
  )
}

function HistoryRows() {
  return (
    <div className="skeleton-rows flex flex-col gap-4">
      {FILE_WIDTHS.map((width, index) => (
        <div key={width} className="relative flex gap-3">
          <div className="relative flex w-3 shrink-0 justify-center">
            {index < FILE_WIDTHS.length - 1 ? (
              <span className="absolute top-2 -bottom-4 w-px bg-hairline" />
            ) : null}
            <Skeleton className="relative mt-1 size-2 rounded-full" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className={`h-2.5 ${width}`} />
            <div className="flex gap-2">
              <Skeleton className="h-2 w-12 opacity-70" />
              <Skeleton className="h-2 w-20 opacity-70" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function DiffRows() {
  return (
    <div className="skeleton-rows flex flex-col gap-2 font-mono">
      {CODE_LINES.map((line, index) => (
        <div key={index} className="flex h-3 items-center gap-3">
          <Skeleton className="h-2 w-5 shrink-0 opacity-50" />
          <Skeleton className={`h-2 ${line.indent} ${line.width}`} />
        </div>
      ))}
    </div>
  )
}
