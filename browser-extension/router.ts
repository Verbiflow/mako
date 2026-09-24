import type { ExtensionDownloads } from "./downloads.js"
import type { ExtensionTasks } from "./tasks.js"
import type { ExtensionCursor } from "./cursor.js"
import { z } from "zod"
import {
  type ExtensionCommand,
  type ExtensionMessage,
  ExtensionFieldsSchema,
} from "@mako/control-runtime/extension"

type DebuggerEventParams = Parameters<
  Parameters<typeof chrome.debugger.onEvent.addListener>[0]
>[2]
type DebuggerDetachReason = Parameters<
  Parameters<typeof chrome.debugger.onDetach.addListener>[0]
>[1]

interface AttachedTarget {
  client: string
  sessionId: string
  target: chrome.debugger.TargetInfo
}
interface CreatedTarget {
  closeOnDisconnect: boolean
  client: string
  tabId: number
  owner: string
  name: string
  parent?: string
}

/** One extension owns debugger attachments; each attachment belongs to one host client. */
export class ExtensionRouter {
  private readonly attached = new Map<string, AttachedTarget>()
  private readonly creating = new Map<string, CreatedTarget>()
  private readonly created = new Map<string, CreatedTarget>()
  private readonly clients = new Set<string>()
  private running = 0
  get idle() {
    return (
      this.running === 0 &&
      this.attached.size === 0 &&
      this.creating.size === 0 &&
      ![...this.created.values()].some((t) => t.closeOnDisconnect)
    )
  }
  private tail: Promise<void> = Promise.resolve()
  constructor(
    private readonly api: Pick<typeof chrome, "debugger" | "tabs" | "windows">,
    private readonly emit: (message: ExtensionMessage) => void,
    private readonly activity?: {
      tasks: ExtensionTasks
      cursor: ExtensionCursor
      downloads: ExtensionDownloads
      settled: () => void
    }
  ) {}

  async request(client: string, command: ExtensionCommand): Promise<void> {
    this.clients.add(client)
    this.running++
    try {
      const result = command.method.startsWith("Target.")
        ? await this.serial(() => this.targetCommand(client, command))
        : await this.sessionCommand(client, command)
      this.emit({
        kind: "response",
        client,
        id: command.id,
        result: result ?? {},
      })
    } catch (error) {
      this.emit({
        kind: "error",
        client,
        id: command.id,
        message:
          error instanceof Error
            ? error.message.slice(0, 4000)
            : "Browser command failed",
      })
    } finally {
      this.running--
      this.activity?.settled()
    }
  }

  private serial<Value>(run: () => Promise<Value>): Promise<Value> {
    const next = this.tail.then(run, run)
    this.tail = next.then(
      () => {},
      () => {}
    )
    return next
  }

  private owned(client: string, sessionId: string | undefined): AttachedTarget {
    const attached = sessionId ? this.attached.get(sessionId) : undefined
    if (!attached || attached.client !== client)
      throw new Error("The exact tab session is no longer owned by this client")
    return attached
  }

  private async sessionCommand(client: string, command: ExtensionCommand) {
    if (
      command.method.startsWith("Browser.") ||
      command.method.startsWith("SystemInfo.")
    ) {
      throw new Error(
        "Chrome's extension debugger does not expose Browser or SystemInfo commands"
      )
    }
    const attached = this.owned(client, command.sessionId)
    if (
      command.method === "Mako.download" ||
      command.method === "Mako.downloadStatus"
    ) {
      if (!this.activity) throw new Error("Download support is unavailable")
      const owner = { client, targetId: attached.target.id }
      if (command.method === "Mako.download")
        return this.activity.downloads.start(owner, command.params)
      const request = z
        .object({
          id: z.number().int().nonnegative(),
          timeoutMs: z.number().int().min(0).max(300000).default(0),
        })
        .parse(command.params)
      return this.activity.downloads.status(
        owner,
        request.id,
        request.timeoutMs
      )
    }
    if (command.method === "Mako.retainTarget") {
      const name = z.string().trim().min(1).max(60).parse(command.params.name)
      const created = this.created.get(attached.target.id)
      if (!created || attached.target.tabId === undefined || !this.activity)
        throw new Error("This task did not create the tab")
      await this.activity.tasks.retained(attached.target.tabId, name)
      created.closeOnDisconnect = false
      created.name = name
      return { retained: true, name }
    }
    if (command.method === "Page.captureScreenshot")
      await this.activity?.cursor.clear(attached.target.id)
    if (command.method === "Page.startScreencast")
      await this.activity?.cursor.setRecording(attached.target.id, true)
    const pending = this.api.debugger.sendCommand(
      { targetId: attached.target.id },
      command.method,
      command.params
    ).catch(async error=>{
      if(command.method === "Page.startScreencast") await this.activity?.cursor.setRecording(attached.target.id,false)
      throw error
    })
    this.activity?.cursor.action(
      attached.target.id,
      attached.target.tabId,
      command.method,
      command.params
    )
    const result = await pending
    if (command.method === "Page.stopScreencast")
      await this.activity?.cursor.setRecording(attached.target.id, false)

    return ExtensionFieldsSchema.parse(result ?? {})
  }

  private async targetCommand(
    client: string,
    command: ExtensionCommand
  ): Promise<ReturnType<typeof ExtensionFieldsSchema.parse>> {
    if (!this.clients.has(client))
      throw new Error("Browser client disconnected")
    if (command.method === "Target.setDiscoverTargets") return {}
    if (command.method === "Target.detachFromTarget") {
      const sessionId = z.string().parse(command.params.sessionId)
      const attached = this.owned(client, sessionId)
      void this.activity?.cursor.clear(attached.target.id).catch(() => {})
      await this.api.debugger.detach({ targetId: attached.target.id })
      if (
        attached.target.tabId !== undefined &&
        !this.created.get(attached.target.id)?.closeOnDisconnect
      )
        await this.activity?.tasks.release(attached.target.tabId)
      this.attached.delete(sessionId)
      return {}
    }
    if (command.method === "Target.createTarget") {
      if (this.creating.size + this.created.size >= 512)
        throw new Error("Release unused tabs first")
      const url = z
        .string()
        .regex(/^(https?:|about:)/)
        .parse(command.params.url)
      const background = command.params.background !== false
      const newWindow = command.params.newWindow === true
      const tab = newWindow
        ? (
            await this.api.windows?.create?.({
              url,
              focused: !background,
              type: "normal",
            })
          )?.tabs?.[0]
        : await this.api.tabs.create({ url, active: !background })
      if (tab?.id === undefined)
        throw new Error("The browser created no controllable tab")
      const tabId = tab.id
      for (let attempt = 0; attempt < 20; attempt++) {
        const target = (await this.api.debugger.getTargets()).find(
          (entry) => entry.tabId === tabId
        )
        if (target) {
          if (!this.clients.has(client)) {
            await this.api.tabs.remove(tabId)
            throw new Error("Browser client disconnected")
          }
          const owner = z
            .string()
            .max(200)
            .parse(command.params.makoOwner ?? client)
          const name = z
            .string()
            .trim()
            .min(1)
            .max(60)
            .parse(command.params.makoTaskName ?? "Mako")
          const closeOnDisconnect = command.params.makoTaskLifetime === true
          this.creating.set(target.id, {
            client,
            tabId,
            owner,
            name,
            closeOnDisconnect,
          })
          try {
            await this.activity?.tasks.track({
              targetId: target.id,
              tabId,
              owner,
              name,
              lifetime: closeOnDisconnect ? "task" : "persistent",
            })
          } catch (error) {
            this.creating.delete(target.id)
            await this.api.tabs.remove(tabId)
            throw error
          }
          return { targetId: target.id }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      await this.api.tabs.remove(tabId)
      throw new Error("The new tab did not become available")
    }
    const targets = await this.api.debugger.getTargets()
    if (command.method === "Target.getTargets")
      return { targetInfos: targets.map((t) => this.info(t)) }
    const target = targets.find((entry) => entry.id === command.params.targetId)
    if (!target) throw new Error("No target with given id")
    if (command.method === "Target.getTargetInfo")
      return { targetInfo: this.info(target) }
    if (command.method === "Target.attachToTarget") {
      const creator =
        this.creating.get(target.id) ?? this.created.get(target.id)
      if (creator && creator.client !== client)
        throw new Error("Another client owns this tab")
      if (this.attached.size >= 512)
        throw new Error("Release unused tab sessions first")
      if (
        [...this.attached.values()].some(
          (entry) => entry.target.id === target.id
        )
      )
        throw new Error("Another client owns this tab")
      await this.api.debugger.attach({ targetId: target.id }, "1.3")
      if (!this.clients.has(client)) {
        await this.api.debugger.detach({ targetId: target.id })
        throw new Error("Browser client disconnected")
      }
      const sessionId = crypto.randomUUID()
      if (target.tabId !== undefined && this.activity) {
        try {
          await this.activity.tasks.track({
            targetId: target.id,
            tabId: target.tabId,
            owner:
              creator?.owner ??
              z.string().parse(command.params.makoOwner ?? client),
            name: creator?.name ?? "Mako",
            lifetime: creator
              ? creator.closeOnDisconnect
                ? "task"
                : "persistent"
              : "claimed",
            parent: creator?.parent,
          })
        } catch (error) {
          await this.api.debugger.detach({ targetId: target.id })
          throw error
        }
      }
      if (!this.clients.has(client)) {
        await this.api.debugger.detach({ targetId: target.id })
        if (target.tabId !== undefined)
          await this.activity?.tasks.release(target.tabId)
        throw new Error("Browser client disconnected")
      }
      this.attached.set(sessionId, { client, sessionId, target })
      if (creator) this.created.set(target.id, creator)
      this.creating.delete(target.id)
      return { sessionId }
    }
    const owned = [...this.attached.values()].some(
      (entry) => entry.client === client && entry.target.id === target.id
    )
    const createdOwner =
      this.creating.get(target.id)?.client ??
      this.created.get(target.id)?.client
    if (!owned && createdOwner !== client)
      throw new Error("Another client owns this tab")
    if (command.method === "Target.closeTarget" && target.tabId !== undefined) {
      await this.api.tabs.remove(target.tabId)
      this.creating.delete(target.id)
      this.created.delete(target.id)
      return { success: true }
    }
    if (
      command.method === "Target.activateTarget" &&
      target.tabId !== undefined
    ) {
      await this.api.tabs.update(target.tabId, { active: true })
      return {}
    }
    throw new Error(
      `${command.method} is not available through the browser extension`
    )
  }

  event(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: DebuggerEventParams
  ): void {
    if (
      method === "Page.frameNavigated" ||
      method === "Runtime.executionContextsCleared"
    ) {
      for (const tab of this.attached.values())
        if (
          source.targetId === tab.target.id ||
          source.tabId === tab.target.tabId
        )
          this.activity?.cursor.forget(tab.target.id)
    }
    const fields = ExtensionFieldsSchema.safeParse(params ?? {})
    if (!fields.success) return
    for (const attached of this.attached.values()) {
      if (
        source.targetId === attached.target.id ||
        (source.tabId !== undefined && source.tabId === attached.target.tabId)
      ) {
        this.emit({
          kind: "event",
          client: attached.client,
          sessionId: attached.sessionId,
          method,
          params: fields.data,
        })
      }
    }
  }

  detached(
    source: chrome.debugger.Debuggee,
    reason?: DebuggerDetachReason
  ): void {
    for (const [id, attached] of this.attached) {
      if (
        source.targetId !== attached.target.id &&
        (source.tabId === undefined || source.tabId !== attached.target.tabId)
      )
        continue
      this.attached.delete(id)
      this.activity?.cursor.forget(attached.target.id)
      this.emit({
        kind: "event",
        client: attached.client,
        method: "Target.detachedFromTarget",
        params: {
          sessionId: id,
          targetId: attached.target.id,
          reason: reason ?? "unknown",
        },
      })
    }
    this.activity?.settled()
    // Chromium also reports target_closed for a debugger security detach while
    // the tab stays open. Ownership lasts until tabs.onRemoved, not onDetach.
  }

  removed(tabId: number): void {
    void this.activity?.tasks.removed(tabId).catch(() => {})
    for (const targets of [this.creating, this.created]) {
      for (const [id, target] of targets) {
        if (target.tabId !== tabId) continue
        targets.delete(id)
        this.emit({
          kind: "event",
          client: target.client,
          method: "Target.targetDestroyed",
          params: { targetId: id },
        })
      }
    }
    this.activity?.settled()
  }

  private info(target: chrome.debugger.TargetInfo) {
    const created = this.creating.get(target.id) ?? this.created.get(target.id)
    if (created?.parent)
      return {
        ...targetInfo(target),
        openerId: created.parent,
        makoOwner: created.owner,
        makoTaskLifetime: created.closeOnDisconnect,
      }
    return targetInfo(target)
  }

  async child(tab: chrome.tabs.Tab) {
    if (tab.id === undefined || tab.openerTabId === undefined) return
    const createdParent = [
      ...this.created.entries(),
      ...this.creating.entries(),
    ].find(([, t]) => t.tabId === tab.openerTabId)
    const attachedParent = [...this.attached.values()].find(
      (entry) => entry.target.tabId === tab.openerTabId
    )
    const tracked = this.activity?.tasks.get(tab.openerTabId)
    const parent =
      createdParent ??
      (attachedParent
        ? ([
            attachedParent.target.id,
            {
              client: attachedParent.client,
              tabId: tab.openerTabId,
              owner: tracked?.owner ?? attachedParent.client,
              name: tracked?.name ?? "Mako",
              closeOnDisconnect: true,
            },
          ] as const)
        : undefined)
    if (!parent) return
    const tabId = tab.id
    this.running++
    try {
      await this.serial(async () => {
        if (
          !createdParent &&
          attachedParent &&
          !this.attached.has(attachedParent.sessionId)
        )
          return
        if (this.created.size + this.creating.size >= 512) return
        for (let attempt = 0; attempt < 20; attempt++) {
          const target = (await this.api.debugger.getTargets()).find(
            (t) => t.tabId === tabId
          )
          if (target) {
            // onCreated and navigation attribution can describe the same child.
            if (this.created.has(target.id) || this.creating.has(target.id))
              return
            const child = { ...parent[1], tabId, parent: parent[0] }
            if (!this.clients.has(child.client)) return
            this.created.set(target.id, child)
            await this.activity?.tasks.track({
              targetId: target.id,
              tabId,
              owner: child.owner,
              name: child.name,
              lifetime: child.closeOnDisconnect ? "task" : "persistent",
              parent: parent[0],
            })
            this.emit({
              kind: "event",
              client: child.client,
              method: "Target.targetCreated",
              params: { targetInfo: this.info(target) },
            })
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      })
    } finally {
      this.running--
      this.activity?.settled()
    }
  }

  async disconnect(client: string): Promise<void> {
    this.clients.delete(client)
    this.activity?.downloads.release(client)
    for (const [id, attached] of this.attached) {
      if (attached.client !== client) continue
      this.attached.delete(id)
      void this.activity?.cursor.clear(attached.target.id).catch(() => {})
      if (attached.target.tabId !== undefined)
        await this.activity?.tasks.release(attached.target.tabId)
      await this.api.debugger
        .detach({ targetId: attached.target.id })
        .catch(() => {})
    }
    for (const [target, created] of this.creating) {
      if (created.client !== client) continue
      this.creating.delete(target)
      await this.activity?.tasks.release(created.tabId)
      await this.api.tabs.remove(created.tabId).catch(() => {})
    }
    for (const [target, created] of this.created) {
      if (created.client !== client) continue
      this.created.delete(target)
      await this.activity?.tasks.release(created.tabId)
      if (created.closeOnDisconnect)
        await this.api.tabs.remove(created.tabId).catch(() => {})
    }
    this.activity?.settled()
  }

  async close(): Promise<void> {
    for (const client of this.clients) await this.disconnect(client)
  }
}

function targetInfo(target: chrome.debugger.TargetInfo) {
  return {
    targetId: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
    attached: target.attached,
  }
}
