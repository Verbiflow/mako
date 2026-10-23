import { RuntimeIdSchema, type ThreadOutboxStats } from "@mako/protocol"
import { z } from "zod"
import { CLOUD_SIGN_IN_MAX_HARNESSES, CloudSignInSchema, type CloudSignInInstall } from "./cloud-sign-ins.js"

/**
 * On a cloud machine, the host is started by the machine's agent, which runs as root and holds what the host
 * mustn't: enrolment, the machine's identity and its secrets. The agent gives the host one channel, a socket on the
 * file descriptor `MAKO_MACHINE_AGENT_FD` names, carrying a JSON message per line each way. Nothing else on the
 * machine can reach it: the host's own children don't inherit it, so a harness never sees the machine's credential.
 */
/**
 * 2: the host takes `sign-ins`. 3: and `workspace`. 4: and says `warm` once it has loaded what every start loads, which
 * the agent waits for before it calls the host ready. 5: and takes `prepare`, answering `prepared`. 6: and takes
 * `prefetch`, and sends its start's lines as `log`. An agent sends only what the host's `hello` says it takes.
 */
export const MACHINE_AGENT_PROTOCOL = 6

/** What the agent tells the host. */
export const AgentMessageSchema = z.discriminatedUnion("type", [
  /**
   * Connect as this runtime with this credential: after enrolling, and again whenever either changes. The same
   * runtime with another credential is a renewal: the connection goes on, and the next one carries it.
   */
  z
    .object({
      type: z.literal("link"),
      gatewayUrl: z.url({ protocol: /^https?$/ }),
      runtimeId: RuntimeIdSchema,
      credential: z.string().min(16).max(512),
      machine: z.string().min(1).max(64),
      generation: z.number().int().positive(),
    })
    .strict(),
  /** Stop speaking for the machine at once: it's a copy of another, or its generation moved on. */
  z.object({ type: z.literal("unlink"), reason: z.string().min(1).max(300) }).strict(),
  /** The machine just woke: any connection from before is dead, so connect again now. */
  z.object({ type: z.literal("wake") }).strict(),
  /** Report the runtime's state now, for the agent's own state page. */
  z.object({ type: z.literal("inspect") }).strict(),
  /**
   * The Thread's folder couldn't be made: the step that failed (asking for it, cloning, fetching) and why, so a call that
   * needs the folder says why it isn't there. An older host ignores it.
   */
  z.object({ type: z.literal("workspace-failed"), path: z.string().min(1).max(1024).optional(), step: z.string().min(1).max(40), reason: z.string().min(1).max(2_000) }).strict(),
  /**
   * The sign-ins the machine's harnesses run under, all of them each time: the host writes each where its harness
   * reads it, keeping secret files in `secrets`, a folder in memory the agent made for the host alone.
   */
  z
    .object({
      type: z.literal("sign-ins"),
      secrets: z.string().regex(/^\/[^\0]*$/),
      signIns: z.array(CloudSignInSchema).max(CLOUD_SIGN_IN_MAX_HARNESSES),
    })
    .strict(),
  /** The folder the machine's Thread works in, the clone of its repository: the host's tabs and turns open there. */
  z.object({ type: z.literal("workspace"), path: z.string().regex(/^\/[^\0]*$/).max(4_096) }).strict(),
  /**
   * A project base's clone, before its snapshot: the host does there what a start does first (every harness's MCP
   * servers, two listed by running their CLIs), so a copy's start finds it done. Answered with `prepared`.
   */
  z.object({ type: z.literal("prepare"), path: z.string().regex(/^\/[^\0]*$/).max(4_096) }).strict(),
  /**
   * The harness the machine's Thread was made for, as the machine boots: the host runs what its start runs first, so
   * the start finds it in memory (`startPrefetch`). A hint: another harness's start runs as it would have.
   */
  z.object({ type: z.literal("prefetch"), harness: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }).strict(),
])
export type AgentMessage = z.infer<typeof AgentMessageSchema>

/** The machine runtime as the host sees it, for the agent's state page and the host's log. */
export type MachineRuntimeState = {
  /** `none` before the agent's first link, `silent` after an unlink. */
  link: "none" | "connecting" | "connected" | "offline" | "silent"
  since: string
  runtimeId?: string
  machine?: string
  generation?: number
  /** Enrolments on this runtime ID, and why its last link ended. */
  enrolls: number
  lastEnrolledAt?: string
  lastEnding?: string
  /** Why the agent last silenced it. */
  unlinked?: string
  threads: ThreadOutboxStats[]
  events: { emitted: number; invalidated: number; dropped: number }
  /** Times the host found its clock had jumped, as after the machine was paused and resumed. */
  resumes: number
  lastResume?: { at: string; gapMs: number }
  /** What became of the sign-ins the agent last gave, one per harness. */
  signIns: CloudSignInInstall[]
  /** The workspace the agent last gave, once the host has opened it or failed to. */
  workspace?: { path: string; status: "opened" | "failed"; at: string; reason?: string }
}

/** What the host tells the agent. */
export type HostMessage =
  | { type: "hello"; protocol: number; pid: number; version: string; build: string }
  | { type: "state"; state: MachineRuntimeState }
  /** The host's clock jumped: the machine was paused, or this is a copy of it. The agent checks which and answers. */
  | { type: "resumed"; gapMs: number }
  /**
   * The host has loaded what every start loads (its heavy packages, each harness's version, which reads its binary):
   * a snapshot taken from here, as the machine image's is, wakes with all of it loaded.
   */
  | { type: "warm"; ms: number; loaded: string[] }
  /** A `prepare` is done, or failed and left to the start. */
  | { type: "prepared"; path: string; ms: number; ok: boolean }
  /**
   * The Thread's folder wasn't made (`workspace-failed`) and a move asks for it: the agent asks the gateway and clones
   * again, and says how it went as it did the first time (`workspace`, `workspace-failed`).
   */
  | { type: "workspace-retry" }
  /**
   * One of the host's lines a machine's timeline shows beside the agent's (`npm run timeline`): each launch's phases,
   * what the machine runtime does, a held event loop, and every warning and error. The agent keeps them with its own.
   */
  | { type: "log"; at: string; level: "info" | "warn" | "error"; scope: string; message: string; fields?: Record<string, string | number | boolean | null> }
