import { getMako } from "@/lib/bridge"
import type { NativeAuthoringTarget, NativeAuthoringWrite, NativeAuthoringRemove, NativeAuthoringDocument } from "@/lib/types"

const drafts = new Map<string, { document: NativeAuthoringDocument; contents: string }>()
const selections = new Map<string, string>()
const key = (target: NativeAuthoringTarget) => JSON.stringify([target.cwd, target.provider, target.family])

/** This owner retains edits across Settings navigation and crosses the host boundary. */
export const nativeAuthoring = {
  selection: (cwd: string) => selections.get(cwd),
  select: (cwd: string, selection: string) => { selections.set(cwd, selection) },
  draft: (target: NativeAuthoringTarget) => drafts.get(key(target)),
  remember: (target: NativeAuthoringTarget, document: NativeAuthoringDocument, contents: string) => { drafts.set(key(target), { document, contents }) },
  saved: (target: NativeAuthoringTarget, previous: NativeAuthoringDocument, submitted: string, saved: NativeAuthoringDocument) => {
    const current = drafts.get(key(target))
    if (current?.document.id === previous.id && current.document.revision === previous.revision)
      drafts.set(key(target), { document: saved, contents: current.contents === submitted ? saved.contents : current.contents })
  },
  removed: (target: NativeAuthoringTarget, previous: NativeAuthoringDocument) => {
    const current = drafts.get(key(target))
    if (current?.document.id !== previous.id || current.document.revision !== previous.revision) return
    if (current.contents === previous.contents) drafts.delete(key(target))
    else drafts.set(key(target), { document: { ...previous, contents: "", revision: null }, contents: current.contents })
  },
  forget: (target: NativeAuthoringTarget) => { drafts.delete(key(target)) },
  catalog: () => getMako().nativeAuthoringCatalog(),
  list: (target: NativeAuthoringTarget) => getMako().listNativeAuthoring(target),
  read: (target: NativeAuthoringTarget, id: string) => getMako().readNativeAuthoring(target, id),
  write: (input: NativeAuthoringWrite) => getMako().writeNativeAuthoring(input),
  remove: (input: NativeAuthoringRemove) => getMako().removeNativeAuthoring(input),
}
