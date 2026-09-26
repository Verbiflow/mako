import type { SessionSettings } from "@mako/sessions/settings"
import { RelayPlanStatusSchema } from "@mako/relay"
import { mkdir, copyFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { z } from "zod"
import type { ThreadRef } from "@mako/sessions"
import type {
  RelayCanonicalEvent,
  RelayControl,
  RelayExecution,
} from "@mako/relay"
import type { PromptAttachment, LiveSnapshot } from "./shared.js"
import { LiveConversations } from "./live-conversations.js"
import type { Actor } from "./contracts/thread-identity.js"

const prefix = "mako-conversation:"
const RELAY: Actor = { kind: "service", name: "relay" }

/** Remote jobs submit to the same durable conversations and provider connections as the desk. */
export class RelayConversations {
  private readonly running = new Map<string, string>()
  private readonly owner: LiveConversations
  private readonly root: string
  constructor(owner: LiveConversations, root: string) {
    this.owner = owner
    this.root = root
  }

  private find(path: string): LiveSnapshot | null {
    if (path.startsWith(prefix)) {
      const id = z.string().uuid().safeParse(path.slice(prefix.length))
      return id.success ? this.owner.snapshot(id.data) : null
    }
    const summary = this.owner
      .summaries()
      .find(
        (candidate) =>
          candidate.threadPath === path || candidate.nativePaths?.includes(path)
      )
    return summary ? this.owner.snapshot(summary.session.id) : null
  }

  ref(path: string): ThreadRef | undefined {
    const snapshot = this.find(path)
    if (!snapshot) return undefined
    return {
      path: `${prefix}${snapshot.session.id}`,
      nativeId: snapshot.session.nativeId ?? snapshot.session.id,
      harness: snapshot.session.harness,
      cwd: snapshot.session.cwd,
      title: snapshot.session.title,
    }
  }

  async control(jobId: string, control: RelayControl): Promise<void> {
    const id = this.running.get(jobId)
    if (!id) return
    const request = this.owner
      .snapshot(id)
      ?.requests.find((request) => request.id === jobId)
    if (request?.status !== "dispatching") return
    if (control.kind === "permission")
      await this.owner.permission(id, control.requestId, {
        kind: "choice",
        optionId: control.optionId,
      })
    else await this.owner.cancelRequest(id, jobId)
  }

  async execute(input: {
    jobId: string
    cwd: string
    provider: string
    sourcePath?: string
    text: string
    attachments: PromptAttachment[]
    tuning: SessionSettings
    signal: AbortSignal
    emit: (event: RelayCanonicalEvent) => void
  }): Promise<RelayExecution> {
    const { jobId, signal, emit } = input
    if (signal.aborted)
      throw new Error("The relay lease ended before acceptance")
    let source = input.sourcePath
      ? this.find(input.sourcePath)
      : this.owner.snapshot(jobId)
    if (!source && input.sourcePath)
      source = await this.owner.capture(jobId, input.sourcePath)
    const id = source?.session.id ?? jobId
    const directory = join(this.root, jobId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const attachments: PromptAttachment[] = []
    for (const [index, attachment] of input.attachments.entries()) {
      if (!attachment.path)
        throw new Error("A staged remote attachment has no file")
      const path = join(directory, `${index}-${basename(attachment.name)}`)
      await copyFile(attachment.path, path)
      attachments.push({ ...attachment, path })
    }
    const prior = source?.requests.find((request) => request.id === jobId)
    if (!prior && !source) {
      await this.owner.start(input.provider, input.cwd, {
        conversationId: id,
        tuning: input.tuning,
        initialRequest: { id: jobId, text: input.text, attachments },
      }, RELAY)
    } else if (!prior) {
      this.owner.transfer(id, {
        id: jobId,
        provider: input.provider,
        tuning: input.tuning,
        text: input.text,
        attachments,
      }, RELAY)
    }
    this.running.set(jobId, id)
    const textSizes = new Map<number, number>()
    const toolStates = new Map<string, string>()
    const permissions = new Set<string>()
    try {
      while (true) {
        if (signal.aborted) {
          await this.owner.cancelRequest(id, jobId)
          return {
            harness: input.provider,
            result: "Remote execution stopped",
            status: "stopped",
            threadPath: `${prefix}${id}`,
          }
        }
        const snapshot = this.owner.snapshot(id)
        if (!snapshot) throw new Error("The remote conversation was removed")
        const request = snapshot.requests.find(
          (request) => request.id === jobId
        )
        const start = snapshot.blocks.findIndex(
          (block) => block.type === "user" && block.requestId === jobId
        )
        const end = snapshot.blocks.findIndex(
          (block, index) => index > start && block.type === "user"
        )
        const blocks =
          start < 0
            ? []
            : snapshot.blocks.slice(start + 1, end < 0 ? undefined : end)
        for (const [index, block] of blocks.entries()) {
          if (block.type === "text") {
            const from = textSizes.get(index) ?? 0
            for (
              let offset = from;
              offset < block.text.length;
              offset += 32_000
            )
              emit({
                kind: "text",
                text: block.text.slice(offset, offset + 32_000),
              })
            textSizes.set(index, block.text.length)
          } else if (block.type === "thinking") {
            const key = `reasoning-${index}`
            const detail = block.text.slice(-2_000)
            const status =
              request?.status === "dispatching" ? "in_progress" : "completed"
            const fingerprint = `${status}:${detail}`
            if (toolStates.get(key) === fingerprint) continue
            toolStates.set(key, fingerprint)
            emit({
              kind: "reasoning",
              id: key,
              title: "Reasoning",
              status,
              detail,
            })
          } else if (block.type === "plan") {
            const key = `plan-${index}`
            const fingerprint = JSON.stringify(block.entries)
            if (toolStates.get(key) === fingerprint) continue
            toolStates.set(key, fingerprint)
            emit({
              kind: "plan",
              id: key,
              title: "Plan",
              entries: block.entries.slice(0, 100).map((entry, index) => ({
                id: `${key}-${index}`,
                title: entry.content.slice(0, 256) || "Plan step",
                status: RelayPlanStatusSchema.catch("pending").parse(
                  entry.status
                ),
              })),
            })
          } else if (block.type === "tool") {
            const fingerprint = JSON.stringify([block.status, block.output])
            if (toolStates.get(block.id) === fingerprint) continue
            toolStates.set(block.id, fingerprint)
            emit({
              kind: "tool",
              id: block.id.slice(0, 160),
              title: block.title.slice(0, 256),
              status:
                block.status === "completed" ||
                block.status === "failed" ||
                block.status === "canceled"
                  ? block.status
                  : "in_progress",
              detail: block.input?.slice(0, 2_000),
              output: block.output?.slice(-4_000),
            })
          }
        }
        if (request?.status === "dispatching")
          for (const permission of snapshot.permissions) {
            if (permissions.has(permission.id)) continue
            permissions.add(permission.id)
            emit({
              kind: "permission",
              id: permission.id,
              title: permission.title.slice(0, 256),
              options: permission.options.slice(0, 20).map((option) => ({
                id: option.optionId,
                label: option.name,
                kind: option.kind,
              })),
            })
          }
        if (
          request &&
          request.status !== "queued" &&
          request.status !== "dispatching"
        ) {
          return {
            harness: input.provider,
            model: input.tuning.model,
            effort: z.string().optional().parse(input.tuning.options?.effort),
            fast: z.boolean().optional().parse(input.tuning.options?.fast),
            status:
              request.status === "completed"
                ? "done"
                : request.status === "interrupted"
                  ? "stopped"
                  : "failed",
            result:
              request.error ??
              (blocks
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n\n") ||
                "The provider completed without printable output."),
            threadPath: `${prefix}${id}`,
          }
        }
        const transfer = snapshot.control?.transfers.find(
          (transfer) => transfer.input.id === jobId
        )
        if (
          transfer?.state.kind === "failed" ||
          transfer?.state.kind === "uncertain"
        )
          throw new Error(transfer.state.error)
        if (
          snapshot.session.status === "failed" ||
          snapshot.session.status === "closed"
        )
          throw new Error(
            snapshot.session.error ?? "The provider connection ended"
          )
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
      }
    } finally {
      this.running.delete(jobId)
    }
  }
}
