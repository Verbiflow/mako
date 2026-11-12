import { acpStore } from "@/state/acp-state"
import { tabFor } from "@/state/session-panes"
import { transcriptReaders } from "@/state/transcript-reading"
import { viewerStore } from "@/state/viewer"
import { threadsStore } from "@/state/thread-store"
import { threadGroupsStore } from "@/state/thread-groups"
import { threadArchiveStore } from "@/state/thread-lifecycle"

/** Independent body consumers, excluding the cache itself. A hydrated temporary snapshot is not its own reader. */
export function liveContentReaders(): Set<string> {
  const ids = new Set<string>()
  for (const source of transcriptReaders.heldSources())
    if (source.startsWith("live:")) ids.add(source.slice(5))
  for (const pane of viewerStore.get().panes) {
    const tab = pane.session ? tabFor(pane.session) : undefined
    if (tab?.kind === "session" && tab.presence) ids.add(tab.presence.key)
  }
  return ids
}

/** Pane bindings depend on their session/group/archive stores as well as the pane and lease owners. */
export function watchLiveContentReaders(changed: () => void): () => void {
  const releases = [acpStore.subscribe(changed), viewerStore.subscribe(changed), transcriptReaders.subscribe(changed),
    threadsStore.subscribe(changed), threadGroupsStore.subscribe(changed), threadArchiveStore.subscribe(changed)]
  return () => { for (const release of releases) release() }
}
