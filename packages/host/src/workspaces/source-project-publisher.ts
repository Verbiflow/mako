import { createHash } from "node:crypto"
import { open, mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { SourceProjectSelectionSchema, SourceProjectReceiptSchema, SourceProjectPublishSchema, type SourceProjectCommand, type SourceProjectSelection, type SourceProjectReceipt } from "@mako/protocol/source-project"
import { ThreadIdSchema } from "../contracts/thread-identity.js"
import type { ThreadStore } from "../threads/index.js"
import { worktreeCheckout } from "../contracts/thread-worktrees.js"
import { githubRepositoryUrl } from "../contracts/cloud-threads.js"

const UUID = z.uuid(), Hash = z.string().regex(/^[0-9a-f]{64}$/)
const Plan = z.object({ move: UUID, thread: ThreadIdSchema, asked: z.string(), cloudThread: z.string(), phase: z.literal("preparing"), project: z.string(), folder: z.string(),
  repository: z.object({ url: z.string() }), checkpoint: z.object({ sha256: Hash }),
  sessions: z.array(z.object({ session: UUID })).min(1).max(32),
  others: z.array(z.object({ path: z.string(), url: z.string(), checkpoint: z.object({ sha256: Hash }) })).min(1).max(31) })
const digest = (value: SourceProjectSelection | SourceProjectCommand | string) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const JournalSchema = z.object({ command: SourceProjectPublishSchema, digest: Hash, phase: z.enum(["pending", "acknowledged", "withdrawing", "invalidated"]) }).strict()
type Journal = z.infer<typeof JournalSchema>
/** Actual source reader: only a pre-existing host move plan and THIS device's ThreadStore registry.
 * It has no UI/model entry, never starts a move, makes worktrees or captures/changes repositories.
 */
type PublisherOptions = { dataRoot: string; threads: Pick<ThreadStore, "journalPlacement" | "worktrees" | "threadSessions" | "execution">;
    git: { output(cwd: string, args: readonly string[]): Promise<string> }; send(input: SourceProjectCommand): Promise<SourceProjectReceipt>; now(): number }
export class SourceProjectPublisher {
  readonly #options: PublisherOptions
  #busy = false
  constructor(options: PublisherOptions) { this.#options = options }
  async #file(path: string): Promise<string> {
    const file = await open(path, "r")
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 65536) throw new Error("source-plan-too-large")
      const buffer = Buffer.alloc(65537), read = await file.read(buffer, 0, buffer.length, 0)
      if (read.bytesRead > 65536) throw new Error("source-plan-too-large")
      return buffer.subarray(0, read.bytesRead).toString("utf8")
    }
    finally { await file.close() }
  }
  async #selection(move: string): Promise<SourceProjectSelection> {
    const options = this.#options, plan = Plan.parse(JSON.parse(await this.#file(join(options.dataRoot, "cloud", "moves", move + ".json"))))
    if (plan.move !== move || options.threads.journalPlacement(plan.asked)?.thread !== plan.thread) throw new Error("source-plan-owner")
    const worktrees = options.threads.worktrees().filter(row => row.thread === plan.thread && worktreeCheckout(row) === plan.project).sort((a, b) => a.path.localeCompare(b.path))
    const planned = [{ path: plan.folder, url: plan.repository.url, checkpoint: plan.checkpoint }, ...plan.others].sort((a, b) => a.path.localeCompare(b.path))
    if (worktrees.length !== planned.length || worktrees.some((row, index) => row.path !== planned[index]?.path) || worktrees[0]?.path !== plan.folder) throw new Error("source-registry-membership")
    const locators: SourceProjectSelection["locators"] = []
    for (const [index, row] of worktrees.entries()) {
      // Read the registered repository's actual origin, not a URL supplied to this operation.
      const url = githubRepositoryUrl((await options.git.output(row.path, ["config", "--get", "remote.origin.url"])).trim())
      if (!url || url !== planned[index]?.url) throw new Error("source-registry-origin")
      locators.push({ slot: index === 0 ? "primary" : "repo-" + digest(row.path).slice(0, 16), kind: index === 0 ? "primary" : "secondary", url, path: row.path, checkpoint: planned[index]!.checkpoint.sha256 })
    }
    const cohort = options.threads.threadSessions(plan.thread)
    if (cohort.length !== plan.sessions.length || cohort.some(row => !plan.sessions.some(expected => expected.session === row.session))) throw new Error("source-plan-cohort")
    const sessions = cohort.map(row => {
      const execution = options.threads.execution(row.session)
      if (!execution || execution.state !== "here" || execution.owner.kind !== "device") throw new Error("source-session-owner")
      return { session: row.session, generation: execution.generation }
    }).sort((a, b) => a.session.localeCompare(b.session))
    const value = SourceProjectSelectionSchema.parse({ move, destination: plan.cloudThread, sourceThread: plan.thread, project: plan.project, locators, sessions })
    // File, source cohort and registry are re-read after every async publication before acknowledging locally.
    return value
  }
  #journal(move: string) { return join(this.#options.dataRoot, "source-project", move + ".json") }
  async #save(move: string, value: Journal) {
    const directory = join(this.#options.dataRoot, "source-project"); await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = this.#journal(move); await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 }); await rename(path + ".tmp", path)
  }
  #receipt(move: string, journal: Journal, value: SourceProjectReceipt): SourceProjectReceipt {
    const receipt = SourceProjectReceiptSchema.parse(value)
    if (receipt.move !== move || receipt.revision !== journal.command.revision || receipt.digest !== journal.digest || receipt.expiresAt > journal.command.expiresAt) throw new Error("source-publication-refused")
    return receipt
  }
  async #withdraw(move: string, journal: Journal): Promise<void> {
    try {
      // Persist withdrawal intent before sending. Unknown delivery is reconciled by READ only.
      await this.#save(move, { ...journal, phase: "withdrawing" })
      const receipt = this.#receipt(move, journal, await this.#options.send({ action: "invalidate", move, revision: journal.command.revision, digest: journal.digest }))
      if (receipt.phase !== "invalidated") throw new Error("source-withdrawal-unresolved")
      await this.#save(move, { ...journal, phase: "invalidated" })
    } catch {
      // Keep the retained journal uncertain; cancellation/serialization failures must not erase the source failure.
      // No fresh revision, cancellation retry, acknowledgement or physical permission follows from this catch.
    }
  }
  async #selectionOrWithdraw(move: string, journal?: Journal): Promise<SourceProjectSelection> {
    try { return await this.#selection(move) }
    catch (failure) { if (journal) await this.#withdraw(move, journal); throw failure }
  }
  async publish(input: string): Promise<SourceProjectReceipt> {
    const move = UUID.parse(input)
    if (this.#busy) throw new Error("source-publisher-busy")
    this.#busy = true
    try {
      // Recover the exact owned operation before any source read can fail.
      let old: Journal | undefined
      try { old = JournalSchema.parse(JSON.parse(await this.#file(this.#journal(move)))) } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error }
      if (old && (old.command.selection.move !== move || digest(old.command) !== old.digest)) throw new Error("source-journal-owner")
      if (old?.phase === "invalidated") throw new Error("source-publication-withdrawn")
      if (old?.phase === "withdrawing") {
        const receipt = this.#receipt(move, old, await this.#options.send({ action: "read", move, revision: old.command.revision, digest: old.digest }))
        if (receipt.phase !== "invalidated") throw new Error("source-withdrawal-unresolved")
        await this.#save(move, { ...old, phase: "invalidated" })
        throw new Error("source-publication-withdrawn")
      }
      const selection = await this.#selectionOrWithdraw(move, old)
      if (old?.phase === "pending") {
        // Unknown publication is reconciled, never blindly sent again or rebound to a new destination.
        const receipt = this.#receipt(move, old, await this.#options.send({ action: "read", move, revision: old.command.revision, digest: old.digest }))
        if (digest(selection) !== digest(old.command.selection)) { const failure = new Error("source-changed-during-unknown"); await this.#withdraw(move, old); throw failure }
        if (digest(await this.#selectionOrWithdraw(move, old)) !== digest(selection)) { const failure = new Error("source-changed-during-reconciliation"); await this.#withdraw(move, old); throw failure }
        if (receipt.phase !== "ready" || receipt.expiresAt <= this.#options.now()) throw new Error("source-publication-unresolved")
        await this.#save(move, { ...old, phase: "acknowledged" }); return receipt
      }
      const command = { action: "publish" as const, revision: (old?.command.revision ?? 0) + 1, expiresAt: this.#options.now() + 5000, selection }, pending: Journal = { command, digest: digest(command), phase: "pending" }
      await this.#save(move, pending)
      const receipt = this.#receipt(move, pending, await this.#options.send(command))
      if (receipt.phase !== "ready" || receipt.expiresAt <= this.#options.now()) throw new Error("source-publication-refused")
      const current = await this.#selectionOrWithdraw(move, pending)
      if (digest(current) !== digest(selection)) { const failure = new Error("source-changed-after-publication"); await this.#withdraw(move, pending); throw failure }
      await this.#save(move, { ...pending, phase: "acknowledged" }); return receipt
    } finally { this.#busy = false }
  }
}
