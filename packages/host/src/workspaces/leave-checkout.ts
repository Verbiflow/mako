import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { contentRef, type Partition, type PartitionFile } from "../attribution/index.js"
import { atHead, own } from "./thread-checkpoint.js"
import { MovePlanSchema, onDisk, resumeMove, rewriteInPlace, sidesOf, type InPlaceFile, type MoveLedger } from "./worktree-move.js"

/**
 * A Thread the cloud continued while this Mac was away leaves the main checkout it worked in (handoff v2, the way
 * back): its changes there are the cloud's now, from the checkpoint the cloud acknowledged. They're taken out only if
 * every file is still exactly as that checkpoint had it, and the record of changes still names the same lines the
 * Thread's: then each file becomes what the rest of the checkout makes it (the person's, other Threads'), all or
 * nothing, through the move's own writer (`rewriteInPlace`: the checkout kept first under `refs/mako/moves/`, every
 * file checked before and after, a plan saved so a host stopped mid-write finishes or undoes it, `resume`). Anything
 * else (a file someone touched since, a change the journal doesn't name as the Thread's, a file the cloud never got)
 * and nothing is taken: the Thread's changes stay, and what stayed is kept for its row to say.
 */

/** One repository's part of what the cloud acknowledged: the files of the Thread's it holds, by content address. */
export type LeftRepository = { root: string; versions: ReadonlyArray<{ path: string; ref: string | null }> }

/**
 * Whether the cloud has every change of the Thread's that would leave the project folder, by what it said and what was
 * sent: why not, or undefined when it has. The continue's arrival applied (`applied`, its word) the first repository's
 * acknowledged checkpoint (its cloud Thread is made for that one) and every other repository's holding a change of the
 * Thread's, and the going-away note it came from carried (`sent`) each of them. A repository the note left out (a
 * gateway that doesn't take the others, one with nowhere to be laid out), one acknowledged anew after it went, or one
 * the arrival didn't apply isn't on the machine: its changes would be lost, so nothing leaves, all or nothing as `leave`
 * is. An account that doesn't say what its arrival applied leaves nothing either: removing the person's files rests on
 * its word, never on an inference.
 */
export function cloudHasAll(repositories: ReadonlyArray<{ root: string; sha256: string; changes: number }>, sent: readonly string[] | undefined, applied: readonly string[] | undefined): string | undefined {
  if (!repositories.length) return "nothing was acknowledged"
  if (!applied) return "the account didn't say which checkpoints its machine applied"
  if (!sent) return "no going-away note named its checkpoints"
  const needed = repositories.filter((each, index) => index === 0 || each.changes > 0)
  const unsent = needed.filter((each) => !sent.includes(each.sha256))
  if (unsent.length) return `the going-away note didn't carry ${unsent.map((each) => each.root).join(", ")} as acknowledged`
  const unapplied = needed.filter((each) => !applied.includes(each.sha256))
  return unapplied.length ? `the machine didn't apply ${unapplied.map((each) => each.root).join(", ")} as acknowledged` : undefined
}

export type LeaveLedger = Pick<MoveLedger, "mako"> & {
  heard(): Promise<void>
  partition(checkout: string, thread: string): Partition | Promise<Partition>
}

export type LeaveOutcome =
  | { kind: "left"; files: number; backup: string }
  /** Nothing was taken: these paths (relative to their repository) aren't as the cloud has them. */
  | { kind: "stayed"; paths: string[] }
  | { kind: "nothing" }

const StayedSchema = z.object({ version: z.literal(1), threads: z.record(z.string(), z.object({ paths: z.array(z.string()), at: z.number() })) })

export class CheckoutLeave {
  readonly #folder: string
  readonly #git: Git
  readonly #log: (message: string, facts: Record<string, string | number | boolean>) => void
  #stayed: z.infer<typeof StayedSchema> | undefined

  /** `folder`: this host's own, for the plans of rewrites under way and what stayed (`<data root>/cloud/leaving`). */
  constructor(folder: string, git: Git, log: (message: string, facts: Record<string, string | number | boolean>) => void) {
    this.#folder = folder
    this.#git = git
    this.#log = log
  }

  /** The Thread's files that stayed in the main checkout when the cloud took it, for its row to say; undefined when none did. */
  async stayed(thread: string): Promise<string[] | undefined> {
    return (await this.#readStayed()).threads[thread]?.paths
  }

  /** Takes the Thread's changes out of the main checkout, if every file is as the cloud has it; see the top of this file. */
  async leave(thread: string, project: string, repositories: readonly LeftRepository[], ledger: LeaveLedger): Promise<LeaveOutcome> {
    if (!repositories.some((repository) => repository.versions.length)) return { kind: "nothing" }
    await ledger.heard()
    const stayed: string[] = []
    const rewrites: { repoRoot: string; head: string; files: InPlaceFile[] }[] = []
    for (const { root, versions } of repositories) {
      const files = new Map(own(await ledger.partition(root, thread), root).map((file) => [file.path, file]))
      const head = (await this.#git.output(root, ["rev-parse", "HEAD"]).catch(() => "")) || undefined
      const base = head ? await atHead(this.#git, root, head, versions.map((version) => version.path)) : new Map()
      const rewrite: InPlaceFile[] = []
      for (const { path, ref } of versions) {
        const file: PartitionFile | undefined = files.get(path)
        files.delete(path)
        const now = await onDisk(join(root, path))
        const bytes = now && now !== "other" ? now.bytes : null
        const sides = file && now !== "other" ? sidesOf(file, bytes, base.get(path)?.bytes ?? null) : "unknown"
        const read = sides === "stale" || sides === "unknown" ? undefined : sides
        const threadRef = read?.thread ? contentRef(read.thread) : null
        // As the cloud has it: on disk as the journal holds it, and the Thread's side of it the checkpoint's version.
        if (!head || !read || (bytes ? contentRef(bytes) : null) !== file?.current || threadRef !== ref) {
          stayed.push(path)
          continue
        }
        rewrite.push({ path, before: bytes, ...now && now !== "other" && { perm: now.perm }, after: read.remaining })
      }
      // The journal names more of the Thread's than the cloud got: those stay, and so does the rest.
      for (const path of files.keys()) stayed.push(path)
      if (head && rewrite.length) rewrites.push({ repoRoot: root, head, files: rewrite })
    }
    if (stayed.length) {
      await this.#keepStayed(thread, stayed)
      this.#log("a Thread the cloud took left its changes in the project folder: they're not as the cloud has them", { thread, stayed: stayed.length })
      return { kind: "stayed", paths: stayed.sort() }
    }
    if (!rewrites.length) return { kind: "nothing" }
    const id = randomUUID()
    const done = await rewriteInPlace({
      git: this.#git,
      ledger,
      id,
      thread,
      project,
      repositories: rewrites,
      message: `Mako: the project folder before Thread ${thread}'s changes left it for the cloud`,
      save: (plan) => this.#savePlan(id, plan),
      log: this.#log,
    })
    await this.#keepStayed(thread, [])
    this.#log("a Thread the cloud took left the project folder", { thread, files: done.outcome.came.files, backup: done.outcome.backup ?? "" })
    return { kind: "left", files: done.outcome.came.files, backup: done.outcome.backup ?? "" }
  }

  /** At start: a rewrite a host died in the middle of is finished, or put back, from its saved plan. */
  async resume(ledger: Pick<MoveLedger, "mako"> | undefined): Promise<void> {
    const plans = join(this.#folder, "plans")
    for (const name of await readdir(plans).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const path = join(plans, name)
      const plan = MovePlanSchema.safeParse(JSON.parse(await readFile(path, "utf8").catch(() => "null"))).data
      if (plan)
        await resumeMove(this.#git, ledger, plan, this.#log).then(
          () => this.#log("finished taking a Thread's changes out of the project folder", { thread: plan.thread }),
          (error: Error) => this.#log("put the project folder back as it was before a Thread's changes left it", { thread: plan.thread, error: error.message }),
        )
      await rm(path, { force: true })
    }
  }

  async #savePlan(id: string, plan: z.infer<typeof MovePlanSchema> | undefined): Promise<void> {
    const plans = join(this.#folder, "plans")
    const path = join(plans, `${id}.json`)
    if (!plan || plan.step === "done") return rm(path, { force: true })
    await mkdir(plans, { recursive: true })
    await writeFile(`${path}.tmp`, JSON.stringify(plan))
    await rename(`${path}.tmp`, path)
  }

  async #readStayed(): Promise<z.infer<typeof StayedSchema>> {
    this.#stayed ??= StayedSchema.safeParse(JSON.parse(await readFile(join(this.#folder, "stayed.json"), "utf8").catch(() => "null"))).data ?? { version: 1, threads: {} }
    return this.#stayed
  }

  async #keepStayed(thread: string, paths: readonly string[]): Promise<void> {
    const kept = await this.#readStayed()
    if (paths.length) kept.threads[thread] = { paths: [...paths], at: Date.now() }
    else delete kept.threads[thread]
    await mkdir(this.#folder, { recursive: true })
    const path = join(this.#folder, "stayed.json")
    await writeFile(`${path}.tmp`, JSON.stringify(kept))
    await rename(`${path}.tmp`, path)
  }
}
