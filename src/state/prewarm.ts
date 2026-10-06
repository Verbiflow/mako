import { getMako } from "@/lib/bridge"
import { acpStore, activeLiveAcp } from "@/state/acp"

/** One signal per conversation per window: enough to wake it, or to restart its idle timer during a long draft. */
const PREWARM_EVERY_MS = 30_000
const signalled = new Map<string, number>()

/** Writing to the active live conversation wakes it on its host, so a restart overlaps the typing instead of following Send. */
export function noteComposing(text: string, now = Date.now()): void {
  if (!text.trim()) return
  const live = activeLiveAcp(acpStore.get())
  if (!live || live.session.status === "closed") return
  if (now - (signalled.get(live.key) ?? Number.NEGATIVE_INFINITY) < PREWARM_EVERY_MS) return
  signalled.set(live.key, now)
  void getMako().livePrewarm(live.key).catch(() => signalled.delete(live.key))
}
