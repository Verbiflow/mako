import { describeFollow, describeList, describeOwner, type SyncReadings } from "@mako/host/contracts/sync-readings"
import { describeSending, type SyncStatus } from "@mako/host/contracts/sync-status"
import { Action } from "@/components/ui/kit"
import { formatRelative } from "@/lib/format"

/** At most this many followed streams are listed: the ones heard from most recently. */
const SHOWN = 8

/**
 * How this Mac follows what its other devices do, for whoever is asking why something looked late or stale: each
 * conversation it follows elsewhere, how long an update takes to arrive and what it took to keep it whole; the account's
 * list; and what it sends of its own conversations another device watches. Numbers only, said in words.
 */
export function SyncReadout({ readings, sending }: { readings: SyncReadings; sending?: SyncStatus | undefined }) {
  const follows = [...readings.follows].sort((left, right) => (right.lastHeardAt ?? 0) - (left.lastHeardAt ?? 0)).slice(0, SHOWN)
  const owner = describeOwner(readings.owner)
  return (
    <div data-sync-readout="" className="mt-2 rounded-lg bg-surface ring-1 ring-hairline">
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-ui">Sync</p>
          <p className="text-label leading-relaxed text-faint">
            How this Mac follows what your other devices do. Times run from the moment the other device sent something.
          </p>
        </div>
        <Action tone="ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify(readings, null, 2))}>
          Copy the readings
        </Action>
      </div>
      <div className="divide-y divide-hairline border-t border-hairline">
        {sending ? <Line title="This Mac's Sessions" detail={describeSending(sending)} /> : null}
        <Line title="Account list" detail={describeList(readings.list)} />
        {owner ? <Line title="Watched from elsewhere" detail={owner} /> : null}
        {follows.length === 0 ? (
          <p className="px-3 py-2 text-label text-faint">Nothing from your other devices has been followed since Mako started.</p>
        ) : (
          follows.map((follow) => (
            <Line
              key={follow.stream}
              title={follow.label ?? "A conversation on another device"}
              detail={describeFollow(follow)}
              when={follow.lastHeardAt === undefined ? undefined : `heard ${formatRelative(new Date(follow.lastHeardAt).toISOString())}`}
            />
          ))
        )}
      </div>
    </div>
  )
}

function Line({ title, detail, when }: { title: string; detail: string; when?: string | undefined }) {
  return (
    <div className="flex items-baseline gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui">{title}</p>
        <p className="text-label leading-relaxed text-faint">{detail}</p>
      </div>
      {when ? <span className="tabular shrink-0 text-label text-faint">{when}</span> : null}
    </div>
  )
}
