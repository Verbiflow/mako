import { z } from "zod"

const taskSchema = z.object({
  targetId: z.string(),
  tabId: z.number().int(),
  owner: z.string(),
  name: z.string(),
  lifetime: z.enum(["claimed", "task", "persistent"]),
  parent: z.string().optional(),
  muted: z.boolean().default(false),
})
type TaskTab = z.infer<typeof taskSchema>
const journalSchema = z.array(taskSchema).max(512)
const journalKey = "makoTaskTabs"
const epochKey = "makoTaskEpoch"
const durableKey = "makoTaskJournal"
const durableSchema = z.object({
  version: z.literal(1),
  epoch: z.string().uuid(),
  tabs: journalSchema,
})

/** Tab ownership survives worker suspension; old sessions never resume input. */
export class ExtensionTasks {
  private epoch: string | undefined
  private readonly tabs = new Map<number, TaskTab>()
  private readonly groups = new Map<
    number,
    { owner: string; name: string; lifetime: TaskTab["lifetime"] }
  >()
  private presentation: Promise<void> = Promise.resolve()
  presented() {
    return this.presentation
  }
  private writes: Promise<void> = Promise.resolve()
  constructor(
    private readonly api: Pick<
      typeof chrome,
      "tabs" | "tabGroups" | "storage" | "debugger" | "runtime" | "windows"
    >
  ) {}
  get size() {
    return this.tabs.size
  }
  get(tabId: number) {
    return this.tabs.get(tabId)
  }
  private save() {
    if (!this.epoch) throw new Error("Browser recovery must finish before accepting a task")
    const value = [...this.tabs.values()].map((tab) => ({ ...tab }))
    const epoch = this.epoch
    const write = this.writes.then(() =>
      this.api.storage.local.set({ [durableKey]: { version: 1, epoch, tabs: value } })
    )
    this.writes = write.catch(() => {})
    return write
  }
  async recover() {
    const stored = await this.api.storage.session.get([epochKey, journalKey])
    const durable = await this.api.storage.local.get(durableKey)
    const previousEpoch = z.string().uuid().optional().parse(stored[epochKey])
    const journal = durableSchema.optional().parse(durable[durableKey])
    const previous = journal?.tabs ?? journalSchema.parse(stored[journalKey] ?? [])
    const sameSession = !journal || journal.epoch === previousEpoch
    this.epoch = previousEpoch ?? crypto.randomUUID()
    await this.api.storage.session.set({ [epochKey]: this.epoch })
    const targets = await this.api.debugger.getTargets()
    let interrupted = 0
    for (const tab of previous) {
      if (!sameSession || !targets.some((t) => t.id === tab.targetId && t.tabId === tab.tabId))
        continue
      await this.api.debugger.detach({ targetId: tab.targetId }).catch(() => {})
      await this.unmute(tab)
      // Preserve pages after interruption for inspection. Never resume a lease.
      interrupted++
    }
    if (previous.length) {
      // Across reload/update/browser restart we cannot attest browser identity.
      // Keep the interruption evidence, but never act on possibly reused IDs.
      await this.api.storage.local.set({
        lastRecovery: {
          at: Date.now(), tabs: previous.length, reconciled: interrupted,
          needsInspection: previous.length - interrupted,
          outcome: "unknown",
          targets: previous.map(({ targetId, tabId, owner }) => ({ targetId, tabId, owner })),
        },
      })
    }
    await this.api.storage.local.remove(durableKey)
    await this.api.storage.session.remove(journalKey)
    return previous.length
  }
  async track(tab: Omit<TaskTab, "muted">) {
    const previous = this.tabs.get(tab.tabId)
    if (
      previous &&
      previous.targetId === tab.targetId &&
      previous.owner === tab.owner &&
      previous.name === tab.name &&
      previous.lifetime === tab.lifetime &&
      previous.parent === tab.parent
    )
      return
    this.tabs.set(tab.tabId, { ...tab, muted: previous?.muted ?? false })
    await this.save()
    if (tab.lifetime === "claimed" && !previous) {
      const current = await this.api.tabs.get(tab.tabId)
      if (current.mutedInfo?.muted && current.mutedInfo.extensionId === this.api.runtime.id) {
        const claimed = this.tabs.get(tab.tabId)!
        claimed.muted = true
        await this.unmute(claimed)
      }
    }
    if (
      tab.lifetime !== "claimed" &&
      (!previous ||
        previous.owner !== tab.owner ||
        previous.lifetime !== tab.lifetime)
    )
      await this.decorate(tab.tabId)
  }
  private async decorate(tabId: number) {
    const owned = this.tabs.get(tabId)
    if (!owned) return
    const tab = await this.api.tabs.get(tabId)
    const window = await this.api.windows.get(tab.windowId)
    if (
      owned.lifetime === "task" &&
      (!tab.active || !window.focused) &&
      !tab.mutedInfo?.muted
    ) {
      // Journal before changing mute; cleanup only unmutes if this extension owns it.
      owned.muted = true
      await this.save()
      await this.api.tabs.update(tabId, { muted: true })
    }
    this.presentation = this.presentation
      .then(() => this.group(tabId))
      .catch(async () => {
        await this.api.storage.local
          .set({ status: "Connected. The browser could not group a task tab." })
          .catch(() => {})
      })
  }
  private async group(tabId: number) {
    const owned = this.tabs.get(tabId)
    if (!owned) return
    const tab = await this.api.tabs.get(tabId)
    const title =
      owned.lifetime === "persistent" ? `${owned.name} · Saved` : owned.name
    const grouping: chrome.tabs.GroupOptions = { tabIds: [tabId] }
    for (const [id, group] of this.groups) {
      if (
        group.owner !== owned.owner ||
        group.name !== title ||
        group.lifetime !== owned.lifetime
      )
        continue
      const actual = await this.api.tabGroups.get(id).catch(() => null)
      if (!actual || actual.windowId !== tab.windowId || actual.title !== title)
        continue
      const members = await this.api.tabs.query({ groupId: id })
      if (
        members.some(
          (member) => member.id === undefined || !this.tabs.has(member.id)
        )
      )
        continue
      grouping.groupId = id
      break
    }
    if (grouping.groupId === undefined)
      grouping.createProperties = { windowId: tab.windowId }
    const groupId = await this.api.tabs.group(grouping)
    if (grouping.groupId === undefined) {
      await this.api.tabGroups.update(groupId, { title, color: "grey" })
      this.groups.set(groupId, {
        owner: owned.owner,
        name: title,
        lifetime: owned.lifetime,
      })
    }
  }
  async retained(tabId: number, name: string) {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.lifetime === "claimed")
      throw new Error("Only a tab created by this task can be retained")
    tab.lifetime = "persistent"
    tab.name = name
    await this.save()
    await this.unmute(tab)
    await this.decorate(tabId)
  }
  async activated(tabId: number) {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const current = await this.api.tabs.get(tabId)
    const window = await this.api.windows.get(current.windowId)
    if (current.active && window.focused) await this.unmute(tab)
  }
  private async unmute(tab: TaskTab) {
    if (!tab.muted) return
    const current = await this.api.tabs.get(tab.tabId).catch(() => null)
    if (
      current?.mutedInfo?.muted &&
      current.mutedInfo.extensionId === this.api.runtime.id
    )
      await this.api.tabs.update(tab.tabId, { muted: false })
    tab.muted = false
  }
  async release(tabId: number) {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    await this.unmute(tab)
    this.tabs.delete(tabId)
    for (const [id, group] of this.groups)
      if (![...this.tabs.values()].some((entry) => entry.owner === group.owner))
        this.groups.delete(id)
    await this.save()
  }
  async removed(tabId: number) {
    this.tabs.delete(tabId)
    for (const [id, group] of this.groups)
      if (![...this.tabs.values()].some((entry) => entry.owner === group.owner))
        this.groups.delete(id)
    await this.save()
  }
}
