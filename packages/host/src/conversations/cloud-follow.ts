import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { MoveCheckpointSchema, type MoveCheckpoint } from "@mako/protocol/moves"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { decodeRuntimeValue, type EncodedValue } from "../contracts/runtime-value.js"
import { applyMoveCheckpoint, captureMoveCheckpoint, unchangedSince } from "../workspaces/index.js"
import { MovePlanSchema } from "./cloud-moves.js"

/**
 * The Mac's worktree of a Thread that runs in the cloud, following it: at each of the cloud Thread's turn ends, the
 * machine's checkout (`mako:move-follow`, each repository's checkpoint) is laid into the worktree here, so its files are
 * there to open and the Changes panel reads them. A mirror, never a second writer: each repository is laid only while
 * it still reads exactly as the checkpoint last laid there (or, before any, the one the move sent). When the person
 * changed it, following stops, nothing of theirs is written over, and the way back merges both (`mergeReturned`, from
 * `laid`). One follow at a time per cloud Thread; a turn that ends meanwhile follows again after.
 *
 * Its state is a file per cloud Thread (`<data root>/cloud/follow/<cloud Thread>.json`): the checkpoint last laid in
 * each repository, and when the person's edit stopped it.
 */

const FollowStateSchema = z.object({
  cloudThread: z.string(),
  /** By repository's path, the checkpoint last laid there. */
  laid: z.record(z.string(), MoveCheckpointSchema).default({}),
  /** When following stopped because the person changed the worktree here, and where. */
  edited: z.object({ at: z.number(), folders: z.array(z.string()) }).optional(),
})
export type FollowState = z.infer<typeof FollowStateSchema>

const FollowAnswerSchema = z.object({ repositories: z.array(z.object({ path: z.string(), checkpoint: MoveCheckpointSchema })) })

export type CloudFollowOptions = {
  /** `<data root>/cloud/follow`. */
  folder: string
  /** Where moves' plans are: a followed Thread is one a move took to the cloud and nothing brought back. */
  moves: string
  git: Git
  readCheckpoint(cloudThread: string, sha256: string, file: string): Promise<void>
  callThread(cloudThread: string, channel: string, args: readonly unknown[]): Promise<EncodedValue>
  /** Whether a return of this cloud Thread is under way: nothing follows a Thread coming back. */
  returning(cloudThread: string): boolean
  /** Following stopped: the person changed the worktree here (`edited`), said to the windows. */
  stopped(cloudThread: string, state: FollowState): void
}

export class CloudFollow {
  readonly #options: CloudFollowOptions
  /** By cloud Thread: the follow running, and whether a turn ended while it ran. */
  readonly #running = new Map<string, { again: boolean }>()

  constructor(options: CloudFollowOptions) {
    this.#options = options
  }

  /** A turn of the cloud Thread ended: its checkout is followed into the worktree here, once at a time. */
  turnEnded(cloudThread: string): void {
    const running = this.#running.get(cloudThread)
    if (running) {
      running.again = true
      return
    }
    const run = { again: false }
    this.#running.set(cloudThread, run)
    void (async () => {
      do {
        run.again = false
        const started = performance.now()
        // Each turn's end says what following did, so a worktree that didn't follow says why in the host's log.
        await this.follow(cloudThread).then(
          (outcome) => hostLog("follow", "a cloud Thread's turn ended", { cloudThread, outcome, ms: Math.round(performance.now() - started) }),
          (error: Error) => hostWarn("follow", "a cloud Thread's worktree couldn't follow it here", { cloudThread, error: errorMessage({ error }) }),
        )
      } while (run.again)
    })().finally(() => this.#running.delete(cloudThread))
  }

  /** How the worktree here follows `cloudThread`: what was laid and whether the person's edit stopped it; undefined if never. */
  async state(cloudThread: string): Promise<FollowState | undefined> {
    const read = await readFile(this.#file(cloudThread), "utf8").catch(() => undefined)
    return read === undefined ? undefined : FollowStateSchema.parse(JSON.parse(read))
  }

  /** The checkout last laid in `path` for `cloudThread`, which a way back merges from; undefined before any was. */
  async laid(cloudThread: string, path: string): Promise<MoveCheckpoint | undefined> {
    return (await this.state(cloudThread))?.laid[path]
  }

  /** Every cloud Thread whose following the person's edit stopped. */
  async stoppedThreads(): Promise<FollowState[]> {
    const states: FollowState[] = []
    for (const name of await readdir(this.#options.folder).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const state = await this.state(name.slice(0, -".json".length)).catch(() => undefined)
      if (state?.edited) states.push(state)
    }
    return states
  }

  /** The Thread came back: nothing follows it any more. */
  async forget(cloudThread: string): Promise<void> {
    await rm(this.#file(cloudThread), { force: true })
  }

  /** One follow: each repository's worktree checked as last laid, then the machine's checkout laid into it. */
  async follow(cloudThread: string): Promise<"followed" | "unchanged" | "stopped" | "not-followed"> {
    if (this.#options.returning(cloudThread)) return "not-followed"
    const plan = await this.#forward(cloudThread)
    if (!plan?.checkpoint) return "not-followed"
    const state = (await this.state(cloudThread)) ?? { cloudThread, laid: {} }
    if (state.edited) return "stopped"
    const bases = new Map<string, MoveCheckpoint>([[plan.folder, plan.checkpoint], ...plan.others.flatMap((other) => (other.checkpoint ? [[other.path, other.checkpoint] as const] : []))])
    await mkdir(this.#options.folder, { recursive: true })
    const scratch = await mkdtemp(join(this.#options.folder, "follow-"))
    try {
      // The person's worktree first: one they changed since the last lay stops following before the cloud is asked.
      const edited: string[] = []
      for (const [path, sent] of bases) {
        const now = await captureMoveCheckpoint(this.#options.git, path, await mkdtemp(join(scratch, "here-")))
        if (!unchangedSince(state.laid[path] ?? sent, now.checkpoint)) edited.push(path)
      }
      if (edited.length) {
        state.edited = { at: Date.now(), folders: edited }
        await this.#write(state)
        hostLog("follow", "the person changed a followed worktree here; following stops and the way back merges", { cloudThread, folders: edited.join(", ") })
        this.#options.stopped(cloudThread, state)
        return "stopped"
      }
      const answer = FollowAnswerSchema.parse(decodeRuntimeValue(await this.#options.callThread(cloudThread, "mako:move-follow", [{ folder: plan.folder }])))
      let laid = 0
      for (const { path, checkpoint } of answer.repositories) {
        const was = state.laid[path] ?? bases.get(path)
        if (!was || was.sha256 === checkpoint.sha256) continue
        const file = join(scratch, `${checkpoint.sha256}.bundle`)
        await this.#options.readCheckpoint(cloudThread, checkpoint.sha256, file)
        await applyMoveCheckpoint(this.#options.git, path, file, checkpoint, { replace: true })
        state.laid[path] = checkpoint
        laid += 1
      }
      if (!laid) return "unchanged"
      await this.#write(state)
      return "followed"
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** The move that took this cloud Thread there, started and not brought back. */
  async #forward(cloudThread: string): Promise<z.infer<typeof MovePlanSchema> | undefined> {
    for (const name of await readdir(this.#options.moves).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const plan = MovePlanSchema.safeParse(JSON.parse(await readFile(join(this.#options.moves, name), "utf8").catch(() => "null"))).data
      if (plan?.phase === "started" && plan.cloudThread === cloudThread) return plan
    }
    return undefined
  }

  #file(cloudThread: string): string {
    return join(this.#options.folder, `${cloudThread}.json`)
  }

  async #write(state: FollowState): Promise<void> {
    await mkdir(this.#options.folder, { recursive: true })
    const file = this.#file(state.cloudThread)
    await writeFile(`${file}.tmp`, JSON.stringify(FollowStateSchema.parse(state)))
    await rename(`${file}.tmp`, file)
  }
}
