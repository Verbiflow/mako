import { getMako } from "@/lib/bridge"
import type { AuthoringCatalog, AuthoringChange, AuthoringDraft, AuthoringPlan, AuthoringView, NativeAuthoringFamily } from "@/lib/types"
import { createHook, createStore } from "@/state/store"

/**
 * Each harness's own hooks, commands and MCP servers, as Settings edits
 * them. Every change is previewed first: the plan is the diff of the one
 * file it writes, and applying sends back the revision the preview read, so
 * a file changed in between is refused rather than overwritten. What the
 * person is writing survives moving between sections.
 */

export type AuthoringEditor =
  | { mode: "create"; sourceId: string; draft: AuthoringDraft }
  | { mode: "edit"; entryId: string; draft: AuthoringDraft }

interface AuthoringState {
  status: "idle" | "loading" | "ready" | "error"
  catalog: AuthoringCatalog | null
  provider: string | null
  family: NativeAuthoringFamily
  editor: AuthoringEditor | null
  /** The change waiting on the person's go-ahead, with what it would write. */
  plan: AuthoringPlan | null
  busy: boolean
  error: string | null
  notice: string | null
  /** Counts applied changes, so a view built on the files (the MCP registry) knows to read them again. */
  applied: number
}

export const authoringStore = createStore<AuthoringState>({
  status: "idle",
  catalog: null,
  provider: null,
  family: "hooks",
  editor: null,
  plan: null,
  busy: false,
  error: null,
  notice: null,
  applied: 0,
})
export const useAuthoring = createHook(authoringStore)

const message = ({ error }: { error: unknown }) => error instanceof Error ? error.message : "The agent's configuration couldn't be read."

function replaceView(catalog: AuthoringCatalog, view: AuthoringView): AuthoringCatalog {
  return { ...catalog, views: catalog.views.map((entry) => entry.provider === view.provider && entry.family === view.family ? view : entry) }
}

export const authoring = {
  async load() {
    if (authoringStore.get().status === "loading") return
    authoringStore.set({ status: "loading", error: null })
    try {
      const catalog = await getMako().nativeAuthoringCatalog()
      const current = authoringStore.get().provider
      const provider = catalog.views.some((view) => view.provider === current) ? current : catalog.views[0]?.provider ?? null
      authoringStore.set({ status: "ready", catalog, provider })
    } catch (error) {
      authoringStore.set({ status: "error", error: message({ error }) })
    }
  },

  select(provider: string, family: NativeAuthoringFamily) {
    const state = authoringStore.get()
    if (state.busy || (state.provider === provider && state.family === family)) return
    authoringStore.set({ provider, family, editor: null, plan: null, error: null, notice: null })
  },

  edit(editor: AuthoringEditor | null) {
    authoringStore.set({ editor, plan: null, error: null, notice: null })
  },

  draft(draft: AuthoringDraft) {
    const editor = authoringStore.get().editor
    if (editor) authoringStore.set({ editor: { ...editor, draft } })
  },

  /** What `change` would write, shown before anything is: in the selected view, or in `on` (the MCP section's servers). */
  async preview(change: AuthoringChange, on?: { provider: string; family: NativeAuthoringFamily }) {
    const { catalog, busy } = authoringStore.get()
    const provider = on?.provider ?? authoringStore.get().provider
    const family = on?.family ?? authoringStore.get().family
    if (!catalog || !provider || busy) return
    authoringStore.set({ busy: true, error: null, notice: null })
    try {
      const plan = await getMako().previewNativeAuthoring({ provider, family, cwd: catalog.cwd }, change)
      authoringStore.set({ plan })
    } catch (error) {
      authoringStore.set({ error: message({ error }) })
    } finally {
      authoringStore.set({ busy: false })
    }
  },

  /** Writes the previewed plan, unless its file changed since the preview. */
  async apply() {
    const { catalog, plan, busy } = authoringStore.get()
    if (!catalog || !plan || busy) return
    authoringStore.set({ busy: true, error: null })
    try {
      const applied = await getMako().applyNativeAuthoring(plan.target, plan.change, plan.revision)
      const current = authoringStore.get().catalog ?? catalog
      authoringStore.set({
        catalog: replaceView(current, applied.view),
        plan: null,
        editor: null,
        applied: authoringStore.get().applied + 1,
        notice: plan.effect === "unchanged" ? "Nothing to change: the file already says that." : `${plan.summary}. ${applied.view.reload}${applied.backup ? " The file as it was is kept in Mako's backups." : ""}`,
      })
    } catch (error) {
      authoringStore.set({ error: message({ error }) })
    } finally {
      authoringStore.set({ busy: false })
    }
  },

  dismiss() {
    authoringStore.set({ plan: null, error: null })
  },

  /** Rereads one view, after the person changed a file outside Mako. */
  async refresh() {
    const { catalog, provider, family } = authoringStore.get()
    if (!catalog || !provider) return
    try {
      const view = await getMako().nativeAuthoringView({ provider, family, cwd: catalog.cwd })
      authoringStore.set({ catalog: replaceView(authoringStore.get().catalog ?? catalog, view), plan: null })
    } catch (error) {
      authoringStore.set({ error: message({ error }) })
    }
  },
}
