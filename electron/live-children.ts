import { join } from "node:path"
import type { LiveSnapshot } from "./shared.js"
import { LiveRequestSchema } from "./live-journal.js"
import { contextPrompt, prepareLiveContext } from "./live-context.js"
import { errorMessage } from "./live-runtime.js"
import type { LiveAccess, Resident } from "./live-runtime.js"

/**
 * Child tasks from the retired Delegate flow, in journals written before it
 * went: they still settle, their results still reach the parent once, and
 * they can still be canceled. Nothing creates one now; related work is a
 * Session in the same Thread.
 */
export class LiveChildren {
  private readonly host: LiveAccess
  private readonly delivering = new Set<string>()
  constructor(host: LiveAccess) {
    this.host = host
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
            // did not do its task.
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
              actor: this.host.agentActor(childId),
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
