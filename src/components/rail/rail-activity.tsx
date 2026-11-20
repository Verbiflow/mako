import { Skeleton } from "@/components/ui/skeleton"

/**
 * The catalog warming up, drawn as the thing it is about to become: two
 * folder groups, a few rows each, fading down the list. Headers and rows are
 * siblings so the glint cascades through both groups in reading order.
 */
export function RailSkeleton() {
  const widths = [72, 54, 63, 78, 48]
  const rows = [
    { group: 0, header: 64 },
    ...widths.slice(0, 4).map((width) => ({ group: 0, width })),
    { group: 1, header: 88 },
    ...widths.slice(0, 3).map((width) => ({ group: 1, width })),
  ]
  return (
    <div className="skeleton-rows pt-1" aria-hidden>
      {rows.map((row, index) =>
        "header" in row ? (
          <div key={index} className={`flex h-7 items-center gap-1.5 px-1.5 ${row.group ? "mt-2" : ""}`}>
            <Skeleton className="size-3.5" />
            <Skeleton className="h-2.5" style={{ width: row.header }} />
          </div>
        ) : (
          <div key={index} className="ml-[13px] flex h-7 items-center gap-2 border-l border-hairline pr-2 pl-3" style={{ opacity: 1 - index * 0.07 }}>
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-2.5" style={{ width: `${row.width}%` }} />
            <Skeleton className="ml-auto h-2 w-6 opacity-60" />
          </div>
        )
      )}
    </div>
  )
}
