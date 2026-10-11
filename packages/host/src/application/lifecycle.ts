import { createHash } from "node:crypto"
import type {
  LifecycleAction,
  LifecycleCommand,
  LifecycleState,
  LifecycleWork,
} from "../contracts/app-lifecycle.js"

interface LifecycleDependencies {
  work(): LifecycleWork[]
  ready(action: LifecycleAction): void
  stop(work: LifecycleWork[]): Promise<void>
  apply(action: LifecycleAction): Promise<void>
  changed(state: LifecycleState): void
}

export class ApplicationLifecycle {
  private operation: LifecycleState["operation"] = { kind: "idle" }
  private published = ""
  private applying = false
  private readonly dependencies: LifecycleDependencies
  constructor(dependencies: LifecycleDependencies) {
    this.dependencies = dependencies
  }

  get blocked(): boolean {
    return (
      this.operation.kind === "stopping" || this.operation.kind === "applying"
    )
  }

  snapshot(): LifecycleState {
    const work = this.dependencies.work()
    const revision = createHash("sha256")
      .update(
        JSON.stringify(
          work
            .map(({ id, token, status, stoppable }) => ({
              id,
              token,
              status,
              stoppable,
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
        )
      )
      .digest("hex")
    return { work, revision, operation: this.operation }
  }

  async command(command: LifecycleCommand): Promise<LifecycleState> {
    if (this.blocked)
      throw new Error(
        "Mako is already preparing to close. No second operation was started."
      )
    if (command.kind === "cancel") {
      this.operation = { kind: "idle" }
      this.publish()
      return this.snapshot()
    }
    this.dependencies.ready(command.action)
    if (command.kind === "stop") {
      const current = this.snapshot()
      if (current.revision !== command.revision)
        throw new Error(
          "The active agents changed. Review the updated list before stopping them."
        )
      if (current.work.some((work) => !work.stoppable))
        throw new Error(
          "Mako is finishing a workspace or provider operation. Wait for it to finish before stopping agents."
        )
      this.operation = { kind: "stopping", action: command.action }
      this.publish()
      try {
        await this.dependencies.stop(current.work)
        if (this.dependencies.work().length)
          throw new Error(
            "Some agents have not stopped yet. Mako was not closed; review their status and try again."
          )
      } catch (error) {
        this.fail(
          command.action,
          error instanceof Error
            ? error.message
            : "Mako could not stop the agents. Your history is preserved."
        )
        return this.snapshot()
      }
    }
    this.operation = { kind: "waiting", action: command.action }
    this.publish()
    await this.tick()
    return this.snapshot()
  }

  async tick(): Promise<void> {
    this.publish()
    if (
      this.applying ||
      this.operation.kind !== "waiting" ||
      this.dependencies.work().length
    )
      return
    const { action } = this.operation
    this.applying = true
    this.operation = { kind: "applying", action }
    this.publish()
    try {
      this.dependencies.ready(action)
      await this.dependencies.apply(action)
    } catch (error) {
      this.fail(
        action,
        error instanceof Error
          ? error.message
          : "Mako could not complete this operation. Your history is preserved."
      )
    } finally {
      this.applying = false
    }
  }

  private fail(action: LifecycleAction, message: string): void {
    this.operation = { kind: "error", action, message }
    this.publish()
  }

  private publish(): void {
    const state = this.snapshot()
    const encoded = JSON.stringify(state)
    if (encoded === this.published) return
    this.published = encoded
    this.dependencies.changed(state)
  }
}
