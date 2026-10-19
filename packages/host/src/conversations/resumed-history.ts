import type { Thread, ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"

/**
 * The native history a live conversation resumed, whole: its base page may
 * hold only the latest turns, and then the session is read whole. The
 * transcript tab and the history tool both read a conversation this way.
 */
export async function resumed(deps: { openThread(path: string): Promise<Thread | null> }, snapshot: { base: ThreadPage | null }): Promise<Entry[]> {
  const base = snapshot.base
  if (!base) return []
  if (base.start === 0 && !base.preview) return base.entries
  const whole = await deps.openThread(base.ref.path)
  if (!whole) return base.entries
  // The page is the record merged with what Mako streamed (`mergedBase`), so it counts its own entries.
  return base.preview ? whole.entries : [...whole.entries.slice(0, base.start), ...base.entries]
}
