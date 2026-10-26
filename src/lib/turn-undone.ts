import type { TurnUndone } from "@mako/host/contracts/turn-review"
import { formatTime } from "@/lib/format"

const files = (count: number) => (count === 1 ? "1 file" : `${count.toLocaleString()} files`)

/**
 * What an undo did, from the turn's request (`LiveRequest.undone`): the
 * hover on "Undone" under the answer and in Changes › Turn. "Undone at
 * 6:52 PM: this turn's lines came out of 2 files. 1 stretch someone had
 * edited since was left as it was. The checkout from before is kept as
 * refs/mako/moves/…".
 */
export function undoneWords(undone: TurnUndone): string {
  const whose = undone.scope === "turn" ? "this turn's" : "this thread's"
  return [
    `Undone at ${formatTime(undone.at)}: ${whose} lines came out of ${files(undone.files)}.`,
    undone.left ? `${undone.left === 1 ? "1 stretch" : `${undone.left.toLocaleString()} stretches`} someone had edited since ${undone.left === 1 ? "was" : "were"} left as ${undone.left === 1 ? "it was" : "they were"}.` : "",
    undone.backup ? `The checkout from before is kept as ${undone.backup}.` : "",
  ].filter(Boolean).join(" ")
}
