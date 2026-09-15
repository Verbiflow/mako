import { getMako, hasBridge } from "@/lib/bridge"
import {
  appendSkillReferences,
  skillNamesIn,
  type SkillAppendixResult,
} from "@/lib/skill-references"
import type {
  SkillRegistrySnapshot,
  SkillSyncPreview,
  SkillSyncTarget,
} from "@/lib/types"
import { createHook, createStore } from "@/state/store"

/**
 * Skill bodies already carried into a conversation, by the key the composer
 * sends under. The first `$skill` in a conversation hands its instructions
 * over; later mentions point back at them. Kept in memory: after a reload
 * the body goes out once more, which costs a few kilobytes and never a
 * missed instruction.
 */
const handedOver = new Map<string, Set<string>>()

interface SkillsState {
  status: "idle" | "loading" | "ready" | "syncing" | "error"
  snapshot: SkillRegistrySnapshot | null
  previews: Record<string, SkillSyncPreview[]>
  error?: string
}

export const skillsStore = createStore<SkillsState>({
  status: "idle",
  snapshot: null,
  previews: {},
})
export const useSkills = createHook(skillsStore)

export const skills = {
  /** Load once per workspace; the composer calls this when its menu opens. */
  ensure(cwd: string) {
    const state = skillsStore.get()
    if (state.status === "loading" || state.status === "syncing") return
    if (state.snapshot && (!cwd || state.snapshot.cwd === cwd)) return
    void skills.load()
  },

  /**
   * Resolve every `$skill` in a draft for the provider that will answer and
   * write what it lacks into the prompt. A draft without skill tokens costs
   * no host call. `conversationKey` is the conversation the message continues,
   * or `null` when it starts one: nothing was handed to a conversation that
   * does not exist yet. A host that cannot answer reports `failed` so the
   * composer can keep the draft; sending the bare token would be the silent
   * failure this exists to end. `source` is the text the names are read
   * from — the user's own words, so a `$word` inside a referenced thread's
   * title or an attachment's file name is never taken for a skill.
   */
  async attach(
    text: string,
    harness: string,
    conversationKey: string | null,
    source = text,
    commands?: ReadonlySet<string>
  ): Promise<SkillAppendixResult> {
    const names = skillNamesIn(source).filter(
      (name) => !commands?.has(name)
    )
    if (names.length === 0 || !hasBridge()) return { text, handed: [] }
    try {
      const references = await getMako().resolveSkillReferences(names, harness)
      return appendSkillReferences(
        text,
        references,
        conversationKey === null
          ? new Set()
          : (handedOver.get(conversationKey) ?? new Set())
      )
    } catch (error) {
      return {
        text,
        handed: [],
        failed: error instanceof Error ? error.message : String(error),
      }
    }
  },

  /**
   * Remember the bodies a sent message carried so the next mention points
   * back instead. A message that started its conversation has no key to
   * remember under; its next message hands the body over once more, which
   * costs a few kilobytes and never a pointer to text a provider never saw.
   */
  rememberHanded(conversationKey: string | null, hashes: readonly string[]) {
    if (conversationKey === null || hashes.length === 0) return
    const set = handedOver.get(conversationKey) ?? new Set<string>()
    for (const hash of hashes) set.add(hash)
    handedOver.set(conversationKey, set)
  },

  async load() {
    if (!hasBridge()) return
    skillsStore.set({ status: "loading", error: undefined })
    try {
      const snapshot = await getMako().discoverSkills()
      skillsStore.set({ status: "ready", snapshot, previews: {} })
    } catch (error) {
      skillsStore.set({
        status: "error",
        error:
          error instanceof Error
            ? `Skills could not be loaded: ${error.message}`
            : "Skills could not be loaded",
      })
    }
  },

  async preview(
    skillId: string,
    targets: SkillSyncTarget[],
    action: "sync" | "remove"
  ) {
    if (!hasBridge() || targets.length === 0) return
    skillsStore.set({ status: "syncing", error: undefined })
    try {
      const previews = await Promise.all(
        targets.map((target) =>
          action === "remove"
            ? getMako().previewSkillRemove(skillId, target)
            : getMako().previewSkillSync(skillId, target)
        )
      )
      skillsStore.set((state) => ({
        status: "ready",
        previews: { ...state.previews, [skillId]: previews },
      }))
    } catch (error) {
      skillsStore.set({
        status: "error",
        error:
          error instanceof Error
            ? `Skill preview failed: ${error.message}`
            : "Skill preview failed",
      })
    }
  },

  /** Drop a preview without applying it; the write it described never happens. */
  clearPreview(skillId: string) {
    skillsStore.set((state) => ({
      previews: { ...state.previews, [skillId]: [] },
    }))
  },

  async apply(skillId: string) {
    if (!hasBridge()) return
    const previews = skillsStore.get().previews[skillId] ?? []
    const actionable = previews.filter((preview) =>
      ["add", "replace", "remove"].includes(preview.action)
    )
    if (actionable.length === 0) return
    skillsStore.set({ status: "syncing", error: undefined })
    try {
      const snapshot = await getMako().applySkillSync(
        skillId,
        actionable.map((preview) => preview.target)
      )
      skillsStore.set((state) => ({
        status: "ready",
        snapshot,
        previews: { ...state.previews, [skillId]: [] },
      }))
    } catch (error) {
      skillsStore.set({
        status: "error",
        error:
          error instanceof Error
            ? `Skill sync failed: ${error.message}`
            : "Skill sync failed",
      })
    }
  },
}
