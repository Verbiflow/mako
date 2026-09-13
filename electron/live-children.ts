import { prepareChildWorkspace } from "./child-workspace.js"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { DelegateInputSchema } from "./contracts/conversation-control.js"
import type { DelegateInput } from "./contracts/conversation-control.js"
import type { LiveSnapshot } from "./shared.js"
import { LiveRequestSchema } from "./live-journal.js"
import { contextPrompt, prepareLiveContext } from "./live-context.js"
import { errorMessage } from "./live-runtime.js"
import type { LiveAccess, Resident } from "./live-runtime.js"

/** App-owned child tasks and idempotent parent result delivery. */
export class LiveChildren {
  private readonly host: LiveAccess
  private readonly delivering = new Set<string>()
  constructor(host: LiveAccess) {
    this.host = host
  }
  async delegate(id: string, input: DelegateInput): Promise<LiveSnapshot> {
    const command = DelegateInputSchema.parse(input)
    const parent = this.host.require(id)
    const control = this.host.control(parent)
    const existing = control.children.find((child) => child.id === command.id)
    if (existing) {
      if (
        existing.provider !== command.provider ||
        existing.task !== command.task
      )
        throw new Error(
          "This child task ID was already accepted with different content"
        )
      return parent.snapshot
    }
    if (this.host.load(command.id))
      throw new Error(
        "This child task ID already belongs to another conversation"
      )
    const request = parent.snapshot.requests
      .filter(
        (candidate) =>
          candidate.status === "dispatching" || candidate.status === "completed"
      )
      .at(-1)
    if (!request) throw new Error("Start a parent task before delegating work")
    if (control.ancestry?.kind === "delegation")
      throw new Error("Nested app-owned delegation is not enabled")
    if (
      control.children.filter(
        (child) =>
          child.status === "starting" ||
          child.status === "working" ||
          child.status === "needs-permission"
      ).length >= 4
    )
      throw new Error("This conversation already has four active child tasks")
    if (
      !this.host.dependencies
        .driver(command.provider)
        ?.available(this.host.dependencies.appPath)
    )
      throw new Error(
        "The child provider has no available interactive transport"
      )
    const child = {
      id: command.id,
      parentRequestId: request.id,
      provider: command.provider,
      task: command.task,
      status: "starting" as const,
      delivery: "pending" as const,
      deliveryId: randomUUID(),
    }
    const previous = parent.snapshot
    parent.snapshot = {
      ...parent.snapshot,
      control: { ...control, children: [...control.children, child] },
    }
    try {
      this.host.flush(parent)
    } catch (error) {
      parent.snapshot = previous
      throw error
    }
    try {
      const workspace = await prepareChildWorkspace(
        this.host.dependencies.root,
        command.id,
        parent.snapshot.session.cwd
      )
      const current = this.host.control(parent)
      if (
        current.children.find((candidate) => candidate.id === command.id)
          ?.status === "canceled"
      )
        return parent.snapshot
      parent.snapshot = {
        ...parent.snapshot,
        control: {
          ...current,
          children: current.children.map((candidate) =>
            candidate.id === command.id
              ? { ...candidate, workspace }
              : candidate
          ),
        },
      }
      this.host.flush(parent)
      await this.host.open(
        command.provider,
        workspace.path,
        {
          conversationId: command.id,
          title: command.task.slice(0, 120),
          initialRequest: {
            id: command.id,
            text: command.task,
            attachments: [],
          },
        },
        {
          kind: "delegation",
          parentId: id,
          sourceRevision: parent.snapshot.revision,
          point: request.id,
        }
      )
    } catch (error) {
      const current = this.host.control(parent)
      parent.snapshot = {
        ...parent.snapshot,
        control: {
          ...current,
          children: current.children.map((candidate) =>
            candidate.id === command.id
              ? { ...candidate, status: "failed" }
              : candidate
          ),
        },
      }
      this.host.flush(parent)
      this.host.dependencies.emit({
        type: "notice",
        level: "error",
        message: `Child task could not start: ${errorMessage({ error })}`,
      })
    }
    return parent.snapshot
  }

  recover(parent: Resident): void {
    for (const child of this.host.control(parent).children) {
      if (child.delivery !== "pending") continue
      const resident = this.host.load(child.id)
      if (resident) this.settle(resident)
      else {
        const control = this.host.control(parent)
        parent.snapshot = {
          ...parent.snapshot,
          control: {
            ...control,
            children: control.children.map((candidate) =>
              candidate.id === child.id
                ? { ...candidate, status: "failed" }
                : candidate
            ),
          },
        }
        this.host.flush(parent)
      }
    }
  }

  cancelChild(id: string, childId: string): LiveSnapshot {
    const parent = this.host.require(id)
    const control = this.host.control(parent)
    if (!control.children.some((child) => child.id === childId))
      throw new Error("That task is not a child of this conversation")
    parent.snapshot = {
      ...parent.snapshot,
      control: {
        ...control,
        children: control.children.map((child) =>
          child.id === childId
            ? { ...child, status: "canceled", delivery: "dismissed" }
            : child
        ),
      },
      requests: parent.snapshot.requests.map((request) =>
        control.children.some(
          (child) => child.id === childId && child.deliveryId === request.id
        ) && request.status === "queued"
          ? { ...request, status: "failed", error: "Child result dismissed" }
          : request
      ),
    }
    this.host.flush(parent)
    if (this.host.load(childId)) this.host.close(childId)
    return parent.snapshot
  }

  settle(resident: Resident): void {
    const ancestry = this.host.control(resident).ancestry
    if (ancestry?.kind !== "delegation") return
    const parent = this.host.load(ancestry.parentId)
    if (!parent) return
    const control = this.host.control(parent)
    const child = control.children.find(
      (candidate) => candidate.id === resident.snapshot.session.id
    )
    if (!child || child.status === "canceled" || child.delivery === "dismissed")
      return
    const request = resident.snapshot.requests.find(
      (candidate) => candidate.id === child.id
    )
    const status =
      resident.snapshot.permissions.length > 0
        ? "needs-permission"
        : request?.status === "completed"
          ? "completed"
          : // A Stop is the user's cancel; a turn Mako's own exit cut short
            // did not do its task, and the parent must be free to delegate again.
            request?.status === "interrupted" && (request.interruption?.reason ?? "stopped") === "stopped"
            ? "canceled"
            : request?.status === "failed" ||
                request?.status === "interrupted" ||
                request?.status === "uncertain" ||
                resident.snapshot.session.connection === "disconnected"
              ? "failed"
              : request?.status === "dispatching"
                ? "working"
                : "starting"
    if (child.status !== status) {
      parent.snapshot = {
        ...parent.snapshot,
        control: {
          ...control,
          children: control.children.map((candidate) =>
            candidate.id === child.id ? { ...candidate, status } : candidate
          ),
        },
      }
      this.host.flush(parent)
    }
    this.deliver(parent)
  }

  deliver(parent: Resident): void {
    if (
      !parent.driver ||
      parent.transferring ||
      this.host.pending(parent) ||
      parent.snapshot.session.status === "closed"
    )
      return
    const control = this.host.control(parent)
    for (const child of control.children) {
      if (
        child.delivery !== "pending" ||
        child.status === "starting" ||
        child.status === "working" ||
        child.status === "needs-permission"
      )
        continue
      if (this.delivering.has(child.deliveryId)) continue
      this.delivering.add(child.deliveryId)
      void this.deliverChild(parent, child.id)
        .catch((error) => {
          this.host.dependencies.emit({
            type: "notice",
            level: "error",
            message: `The child result remains saved but could not be queued: ${errorMessage({ error })}`,
          })
        })
        .finally(() => this.delivering.delete(child.deliveryId))
    }
  }

  private async deliverChild(parent: Resident, childId: string): Promise<void> {
    const child = this.host
      .control(parent)
      .children.find((candidate) => candidate.id === childId)
    if (!child) return
    const source = this.host.load(childId)
    const manifest = source
      ? await prepareLiveContext({
          snapshot: source.snapshot,
          root: join(this.host.dependencies.root, "context"),
          fromBlock: 0,
          includesBase: true,
        })
      : null
    const control = this.host.control(parent)
    const current = control.children.find(
      (candidate) => candidate.id === childId
    )
    if (
      !current ||
      current.delivery !== "pending" ||
      !parent.driver ||
      parent.snapshot.session.status === "closed" ||
      this.host.pending(parent)
    )
      return
    const label = `Result from delegated task: ${child.task}`
    const text = manifest
      ? contextPrompt(
          manifest,
          `The delegated task ${child.id} is ${child.status}. Its parent request is ${child.parentRequestId}. Use the child's result to continue the parent task; do not repeat the delegated work.`
        )
      : `The delegated task ${child.id} failed to start. Task: ${child.task}`
    const previous = parent.snapshot
    parent.snapshot = {
      ...previous,
      requests: previous.requests.some(
        (request) => request.id === child.deliveryId
      )
        ? previous.requests
        : [
            ...previous.requests,
            LiveRequestSchema.parse({
              id: child.deliveryId,
              text,
              displayText: label,
              attachments: [],
              status: "queued",
            }),
          ],
      control: {
        ...control,
        children: control.children.map((candidate) =>
          candidate.id === childId
            ? { ...candidate, delivery: "queued" }
            : candidate
        ),
      },
    }
    try {
      this.host.flush(parent)
    } catch (error) {
      parent.snapshot = previous
      throw error
    }
    this.host.drain(parent)
  }
}
