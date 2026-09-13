import { assertLifecycleAdmission, lifecycleBlocked } from "./application-lifecycle.js"
import type { LifecycleWork } from "./contracts/app-lifecycle.js"
import {
  QueuedPromptEditSchema,
  type QueuedPromptEdit,
} from "./contracts/live-queue.js"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { copyFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { ThreadRef } from "@mako/sessions"
import {
  NativeRequestInputSchema,
  NativeRequestSchema,
} from "./contracts/native-requests.js"
import type {
  NativeRequest,
  NativeRequestInput,
} from "./contracts/native-requests.js"

interface Dependencies {
  read(path: string): Promise<ThreadRef | null>
  running(path: string): boolean
  execute(
    ref: ThreadRef,
    text: string,
    tuning: NativeRequestInput["tuning"]
  ): Promise<void>
  changed(requests: NativeRequest[]): void
  failed(message: string): void
}
const row = z.object({ payload: z.string(), fingerprint: z.string() })

/** The host owns native acceptance and sequencing too. Restart never replays an uncertain run. */
export class NativeRequests {
  private readonly db: DatabaseSync
  private readonly running = new Set<string>()
  private readonly preparing = new Map<string, Promise<NativeRequest>>()
  private stopped = false
  private faulted = false
  private readonly root: string
  private readonly dependencies: Dependencies
  constructor(root: string, dependencies: Dependencies) {
    this.root = root
    this.dependencies = dependencies
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, "requests.sqlite"))
    // NORMAL, as the live journal: durable across a host crash, and a lost
    // last commit after a power failure can only roll a request back to a
    // state the restart already treats as uncertain, never replay it.
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL)"
    )
    for (const request of this.list())
      if (request.status === "dispatching" || request.status === "queued")
        this.update(
          {
            ...request,
            status: "uncertain",
            error:
              "The host restarted. Review this saved request before explicitly sending it again.",
          },
          false
        )
  }
  list(): NativeRequest[] {
    return this.db
      .prepare(
        "SELECT payload, fingerprint FROM requests WHERE json_extract(payload, '$.status') NOT IN ('completed', 'dismissed') ORDER BY rowid"
      )
      .all()
      .map((value) =>
        NativeRequestSchema.parse(JSON.parse(row.parse(value).payload))
      )
  }
  lifecycleWork(): LifecycleWork[] {
    const requests: LifecycleWork[] = this.list().filter((request) => request.status === "queued" || (request.status === "dispatching" && !this.dependencies.running(request.input.path))).map((request) => ({ id: `request:${request.input.id}`, token: request.input.id, provider: request.ref.harness, title: request.ref.title || "Queued native message", cwd: request.ref.cwd ?? "", status: request.status === "queued" ? "queued" : "finishing", stoppable: request.status === "queued" }))
    for (const id of this.preparing.keys()) requests.push({ id: `preparing:${id}`, token: id, provider: "", title: "Preparing a native request", cwd: "", status: "finishing", stoppable: false })
    return requests
  }

  pauseQueued(): void {
    for (const request of this.list()) if (request.status === "queued") this.editQueued({ requestId: request.input.id, expectedText: request.input.text, change: { kind: "pause" } })
  }

  receipt(id: string): NativeRequest | null {
    z.string().uuid().parse(id)
    const saved = this.db
      .prepare("SELECT payload, fingerprint FROM requests WHERE id=?")
      .get(id)
    return saved
      ? NativeRequestSchema.parse(JSON.parse(row.parse(saved).payload))
      : null
  }
  dismiss(id: string): void {
    const request = this.receipt(id)
    if (!request) return
    if (request.status === "dispatching")
      throw new Error("Stop the running task before dismissing it")
    this.update({ ...request, status: "dismissed" })
  }
  editQueued(input: QueuedPromptEdit): NativeRequest[] {
    const command = QueuedPromptEditSchema.parse(input)
    const request = this.receipt(command.requestId)
    if (!request) throw new Error("This queued message is no longer available.")
    if (command.change.kind === "remove" && request.status === "dismissed")
      return this.list()
    if (request.status !== "queued" && request.status !== "held")
      throw new Error(
        "This message has already started. Your queued edit was not applied."
      )
    if (request.input.text !== command.expectedText) {
      if (
        command.change.kind === "edit" &&
        request.input.text === command.change.text
      )
        return this.list()
      throw new Error(
        "This queued message changed. Review its latest text before editing."
      )
    }
    if (
      command.change.kind === "edit" &&
      !command.change.text.trim() &&
      !request.input.attachments.length
    )
      throw new Error("A message cannot be empty.")
    switch (command.change.kind) {
      case "remove":
        this.update({ ...request, status: "dismissed" })
        break
      case "pause":
        this.update({ ...request, status: "held" })
        break
      case "resume":
        this.update({ ...request, status: "queued" })
        break
      case "edit":
        this.update({
          ...request,
          status: "queued",
          input: NativeRequestInputSchema.parse({
            ...request.input,
            text: command.change.text,
          }),
        })
        break
    }
    if (command.change.kind !== "pause") this.ready(request.input.path)
    return this.list()
  }
  submit(input: NativeRequestInput): Promise<NativeRequest> {
    assertLifecycleAdmission()
    const command = NativeRequestInputSchema.parse(input)
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex")
    const existing = this.db
      .prepare("SELECT payload, fingerprint FROM requests WHERE id=?")
      .get(command.id)
    if (existing) {
      const saved = row.parse(existing)
      if (saved.fingerprint !== fingerprint)
        return Promise.reject(
          new Error("This native request ID has different content")
        )
      return Promise.resolve(
        NativeRequestSchema.parse(JSON.parse(saved.payload))
      )
    }
    const pending = this.preparing.get(command.id)
    if (pending) return pending.then(() => this.submit(command))
    const work = this.accept(command, fingerprint)
    this.preparing.set(command.id, work)
    void work.finally(() => this.preparing.delete(command.id)).catch(() => {})
    return work
  }
  private async accept(
    input: NativeRequestInput,
    fingerprint: string
  ): Promise<NativeRequest> {
    if (this.stopped || this.faulted)
      throw new Error("The native command service is unavailable")
    const ref = await this.dependencies.read(input.path)
    if (!ref) throw new Error("The native source is unavailable")
    const attachments = []
    for (const [index, attachment] of input.attachments.entries()) {
      if (attachment.data) {
        const name = createHash("sha256").update(attachment.data).digest("hex")
        const path = join(this.root, name)
        await writeFile(path, attachment.data, "base64")
        attachments.push({ ...attachment, data: undefined, path })
      } else if (attachment.path) {
        const size = (await stat(attachment.path)).size
        if (size > 256 * 1024 * 1024)
          throw new Error("An attachment exceeds the 256 MB limit")
        const path = join(
          this.root,
          `${input.id}-${index}-${attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80)}`
        )
        await copyFile(attachment.path, path)
        attachments.push({ ...attachment, path, size })
      } else throw new Error("An attachment has no retained content")
    }
    if (this.stopped || this.faulted)
      throw new Error("The native command service is unavailable")
    const request: NativeRequest = {
      input: { ...input, attachments },
      ref,
      status: "queued",
    }
    this.db
      .prepare("INSERT INTO requests VALUES (?, ?, ?)")
      .run(input.id, fingerprint, JSON.stringify(request))
    this.dependencies.changed(this.list())
    this.ready(input.path)
    return request
  }
  ready(path: string): void {
    if (
      lifecycleBlocked() ||
      this.stopped ||
      this.faulted ||
      this.running.has(path) ||
      this.dependencies.running(path)
    )
      return
    const request = this.list().find(
      (candidate) =>
        candidate.input.path === path &&
        (candidate.status === "queued" || candidate.status === "held")
    )
    if (!request || request.status === "held") return
    this.running.add(path)
    void this.execute(request)
      .catch((error) => {
        this.faulted = true
        this.dependencies.failed(
          `The native queue could not be saved and has stopped dispatching: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        this.running.delete(path)
        this.ready(path)
      })
  }
  private async execute(request: NativeRequest): Promise<void> {
    try {
      this.update({ ...request, status: "dispatching" })
      const appendix = request.input.attachments
        .map(
          (attachment) =>
            `${attachment.name} (${attachment.mimeType}): ${attachment.path ?? "Attachment unavailable"}`
        )
        .join("\n")
      const text = appendix
        ? `${request.input.text}\n\nAttached files, read their content before answering:\n${appendix}`
        : request.input.text
      await this.dependencies.execute(request.ref, text, request.input.tuning)
      if (!this.stopped) this.update({ ...request, status: "completed" })
    } catch (error) {
      if (!this.stopped)
        this.update({
          ...request,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
    }
  }
  private update(request: NativeRequest, emit = true): void {
    this.db
      .prepare("UPDATE requests SET payload=? WHERE id=?")
      .run(JSON.stringify(request), request.input.id)
    if (emit) this.dependencies.changed(this.list())
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.db.close()
  }
}
