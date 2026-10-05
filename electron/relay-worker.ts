import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import type { ThreadRef } from "@mako/sessions"
import {
  HeadlessRelayWorker,
  RelayControlSchema,
  RelayHarnessSchema,
  RelayJobPayloadSchema,
  RelayLeaseSchema,
  type RelayCanonicalEvent,
  type RelayExecution,
  type RelayHarness,
  type RelayJobPayload,
  type RelayLease,
  type RelayHostHeartbeat,
  type RelayWorkerFailure,
  type WorkerHeartbeat,
} from "@mako/relay"
import {
  backendRelayPost,
  configureBackendRelayDevice,
} from "./backend-connection.js"
import type { RelayConversations } from "./relay-conversations.js"
import { harnessProfile, resolveHarnessTuning } from "./harnesses.js"
import {
  relayPrompt,
  stageRelayAttachments,
  uploadRelayArtifacts,
} from "./relay-artifacts.js"
import { openRelayLog, relayJobRef, type RelayLog } from "./relay-log.js"
import { type RelayPresence } from "./relay-status.js"
import {
  RelayWorkspaceError,
  describeRelayWorkspace,
  findRelayProject,
  isUsableWorkspace,
  rankRelayProjects,
  relayProjectName,
  resolveRelayWorkspace,
  type RelayWorkspaceCandidate,
} from "./relay-workspace.js"
import type { HarnessModelOption } from "./shared.js"
import { listThreads } from "./threads.js"

const RawLeaseSchema = z.object({
  kind: z.literal("job"),
  lease: z.object({
    jobId: z.uuid(),
    messageId: z.string(),
    payload: z.json(),
    popReceipt: z.string(),
  }),
})

const LegacySlackOriginSchema = z.object({
  channel: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  teamId: z.string().min(1).max(80),
  threadTs: z.string().min(1).max(160),
  userId: z.string().min(1).max(80),
})

function parseDesktopRelayPayload<Value>(value: Value): RelayJobPayload {
  const current = RelayJobPayloadSchema.safeParse(value)
  if (current.success) return current.data
  const record = z.record(z.string(), z.json()).parse(value)
  const slack = LegacySlackOriginSchema.parse(record.slack)
  return RelayJobPayloadSchema.parse({
    ...record,
    attachments: record.attachments ?? [],
    origin: {
      provider: "slack",
      tenantId: slack.teamId,
      conversationId: slack.channel,
      threadId: slack.threadTs,
      eventId: slack.eventId,
      userId: slack.userId,
    },
  })
}

function parseLease<Value>(value: Value): RelayLease {
  const raw = RawLeaseSchema.parse(value).lease
  return RelayLeaseSchema.parse({
    ...raw,
    payload: parseDesktopRelayPayload(raw.payload),
  })
}

const EmptySchema = z.object({ kind: z.literal("empty") })

export interface RelayWorkerOptions {
  conversations: RelayConversations
  /** Where remote attachments are staged; never the user's repository. */
  assetRoot: string
  deviceFile: string
  deviceName: string
  /** Durable record of leases, completions and failures; stdio is ignored. */
  logFile: string
  /** Directories the user has actually worked in, newest first. */
  recentWorkspaces: () => Iterable<RelayWorkspaceCandidate>
  version: string
}

let relayWorker: HeadlessRelayWorker | null = null
let relayLog: RelayLog | null = null
let presence: RelayPresence = { kind: "starting" }
let workerOptions: RelayWorkerOptions | null = null

function log(): Pick<RelayLog, "info" | "warn"> {
  return {
    info: (message) => {
      console.info(`[mako-relay] ${message}`)
      relayLog?.info(message)
    },
    warn: (message) => {
      console.warn(`[mako-relay] ${message}`)
      relayLog?.warn(message)
    },
  }
}

/** The project a new request would run in, by name; `null` before any work. */
function currentWorkspaceName(): string | null {
  if (!workerOptions) return null
  return rankRelayProjects(workerOptions.recentWorkspaces())[0]?.name ?? null
}

/**
 * What the relay is doing right now, for Settings and diagnostics. The
 * project a new request would run in is ranked here, on demand, rather than
 * on every status change of the poll loop.
 */
export function relayPresence(): RelayPresence {
  if (presence.kind !== "worker") return presence
  return { ...presence, workspace: currentWorkspaceName() }
}

async function deviceId(path: string): Promise<string> {
  try {
    const id = z.uuid().parse((await readFile(path, "utf8")).trim())
    await chmod(path, 0o600)
    return id
  } catch {
    const id = randomUUID()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${id}\n`, { mode: 0o600 })
    return id
  }
}

function selectOption(
  options: HarnessModelOption[],
  id: string
): Extract<HarnessModelOption, { kind: "select" }> | undefined {
  return options.find(
    (option): option is Extract<HarnessModelOption, { kind: "select" }> =>
      option.kind === "select" && option.id === id
  )
}

function findThread(query: string): ThreadRef | undefined {
  const normalized = query.toLowerCase()
  const refs = listThreads()
  return (
    refs.find((ref) => ref.path === query || ref.nativeId === query) ??
    refs.find((ref) => ref.title?.toLowerCase().includes(normalized))
  )
}

const DEFAULT_HARNESS: RelayHarness = "codex"

type ExecutionResult = Omit<RelayExecution, "status"> & {
  status?: RelayExecution["status"]
}

async function usableProjects(options: RelayWorkerOptions, query?: string) {
  const normalized = query?.toLowerCase()
  const ranked = rankRelayProjects(options.recentWorkspaces()).filter(
    (project) =>
      !normalized ||
      project.name.toLowerCase().includes(normalized) ||
      project.path.toLowerCase().includes(normalized)
  )
  const usable = await Promise.all(
    ranked.map(async (project) =>
      (await isUsableWorkspace(project.path)) ? project : null
    )
  )
  return usable.filter((project) => project !== null)
}

async function executePayload(
  payload: RelayJobPayload,
  options: RelayWorkerOptions,
  signal: AbortSignal,
  jobId: string,
  deviceId: string,
  onEvent: (event: RelayCanonicalEvent) => void
): Promise<ExecutionResult> {
  const { conversations } = options
  const requested = payload.selection.harness
  if (payload.kind === "inspect-projects") {
    const projects = await usableProjects(options, payload.query)
    return {
      harness: requested ?? DEFAULT_HARNESS,
      presentation: {
        kind: "projects",
        items: projects.map((project) => ({
          name: project.name,
          path: project.path,
        })),
      },
      result:
        projects.length > 0
          ? projects
              .map((project) => `• *${project.name}* — \`${project.path}\``)
              .join("\n")
          : "Mako found no recent projects on this Mac. Open a folder in Mako once and it will appear here.",
    }
  }
  if (payload.kind === "inspect-threads") {
    const query = payload.query?.toLowerCase()
    const refs = listThreads()
      .filter(
        (ref) =>
          !query ||
          ref.nativeId.toLowerCase().includes(query) ||
          ref.path.toLowerCase().includes(query) ||
          ref.title?.toLowerCase().includes(query)
      )
      .slice(0, 15)
    return {
      harness: requested ?? DEFAULT_HARNESS,
      presentation: {
        kind: "threads",
        items: refs.map((ref) => ({
          harness: ref.harness,
          path: ref.path,
          title: ref.title ?? "Untitled thread",
        })),
      },
      result:
        refs.length > 0
          ? refs
              .map(
                (ref) =>
                  `• *${ref.title ?? "Untitled thread"}* — \`${ref.harness}\`${ref.cwd ? ` — ${relayProjectName(ref.cwd)}` : ""} — \`${ref.nativeId}\``
              )
              .join("\n")
          : "Mako found no local threads matching that search.",
    }
  }
  if (payload.kind === "configure" && !payload.threadPath) {
    // A thread without a local session yet: the choice is a project plus
    // tuning, and it is remembered by the completion's cwd.
    const projects = await usableProjects(options)
    const chosen = payload.selection.cwd
      ? (findRelayProject(payload.selection.cwd, projects)?.path ??
        payload.selection.cwd)
      : undefined
    const workspace = await resolveRelayWorkspace({
      selected: chosen,
      recent: options.recentWorkspaces,
    })
    const harness = requested ?? DEFAULT_HARNESS
    const tuning = [
      payload.selection.model ? `model \`${payload.selection.model}\`` : null,
      payload.selection.effort
        ? `reasoning \`${payload.selection.effort}\``
        : null,
      payload.selection.fast === undefined
        ? null
        : `fast \`${payload.selection.fast ? "on" : "off"}\``,
    ].filter((part) => part !== null)
    return {
      cwd: workspace.cwd,
      effort: payload.selection.effort,
      fast: payload.selection.fast,
      harness,
      model: payload.selection.model,
      result: `This thread runs ${describeRelayWorkspace(workspace)} (\`${workspace.cwd}\`). The next message starts a new \`${harness}\` session${tuning.length > 0 ? ` with ${tuning.join(", ")}` : ""}.`,
    }
  }
  const source =
    payload.kind === "resume" || payload.kind === "configure"
      ? (conversations.ref(payload.threadPath ?? "") ??
        findThread(payload.threadPath ?? ""))
      : payload.kind === "resume-query"
        ? findThread(payload.query)
        : undefined
  const failureThreadPath =
    payload.kind === "configure" ? undefined : source?.path
  if (
    (payload.kind === "resume" ||
      payload.kind === "resume-query" ||
      payload.kind === "configure") &&
    !source
  ) {
    const query =
      payload.kind === "resume-query" ? payload.query : payload.threadPath
    return {
      harness: requested ?? DEFAULT_HARNESS,
      model: payload.selection.model,
      result: `Mako could not find the local thread \`${query}\`. Send \`threads\` to list resumable threads.`,
    }
  }
  const harness =
    requested ?? RelayHarnessSchema.parse(source?.harness ?? DEFAULT_HARNESS)
  const profile = await harnessProfile(harness)
  if (!profile.available) {
    return {
      harness,
      result: profile.error ?? `${profile.label} is not available on this Mac.`,
      threadPath: failureThreadPath,
    }
  }
  if (payload.kind === "inspect-models") {
    return {
      harness,
      presentation: {
        kind: "models",
        harness,
        items: profile.models.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
        })),
      },
      result: profile.models
        .map((candidate) => {
          const controls = candidate.options.map((option) =>
            option.kind === "boolean"
              ? option.label
              : `${option.label}: ${option.values.map((value) => value.value).join(" | ")}`
          )
          return `• *${candidate.label}* — \`${candidate.id}\`${controls.length > 0 ? ` — ${controls.join(" · ")}` : ""}`
        })
        .join("\n"),
    }
  }
  const requestedModel =
    payload.selection.model ??
    source?.model ??
    profile.settings?.model
  const selectedModel = requestedModel
    ? profile.models.find(
        (candidate) =>
          candidate.id === requestedModel ||
          candidate.aliases?.includes(requestedModel)
      )
    : undefined
  if (requestedModel && !selectedModel) {
    return {
      harness,
      result: `Mako could not find \`${requestedModel}\` for ${profile.label}. Send \`models ${harness}\` to list live models.`,
      threadPath: failureThreadPath,
    }
  }
  const effort = payload.selection.effort
  const effortOption = selectedModel
    ? selectOption(selectedModel.options, "effort")
    : undefined
  if (
    effort &&
    (!effortOption ||
      !effortOption.values.some((value) => value.value === effort))
  ) {
    return {
      harness,
      model: selectedModel?.id,
      result: `\`${effort}\` is not available for this model. Send \`models ${harness}\` to see supported reasoning levels.`,
      threadPath: failureThreadPath,
    }
  }
  const fast = payload.selection.fast
  const fastOption = selectedModel?.options.find(
    (option) => option.id === "fast"
  )
  const speedOption = selectedModel
    ? selectOption(selectedModel.options, "serviceTier")
    : undefined
  if (fast !== undefined && !fastOption && !speedOption) {
    return {
      effort,
      harness,
      model: selectedModel?.id,
      result: `Fast mode is not available for \`${selectedModel?.id ?? harness}\`.`,
      threadPath: failureThreadPath,
    }
  }
  const serviceTier = fast === undefined ? undefined
    : fast ? speedOption?.booleanValues?.on : speedOption?.booleanValues?.off
  if (fast !== undefined && speedOption && !serviceTier) {
    return {
      effort,
      harness,
      model: selectedModel?.id,
      result: `Mako could not map fast \`${fast ? "on" : "off"}\` to a speed tier for this model. Send \`models ${harness}\` to see its controls.`,
      threadPath: failureThreadPath,
    }
  }
  const selectedOptions: NonNullable<Parameters<typeof resolveHarnessTuning>[1]>["options"] = {}
  if (effort) selectedOptions.effort = effort
  if (serviceTier) selectedOptions.serviceTier = serviceTier
  if (fast !== undefined && fastOption) selectedOptions.fast = fast
  const resolved = resolveHarnessTuning(profile, {
    model: selectedModel?.id,
    options: selectedOptions,
  })
  const model = selectedModel?.id
  if (payload.kind === "configure") {
    return {
      cwd: source?.cwd,
      effort,
      fast,
      harness,
      model,
      result: `Updated this thread: harness \`${harness}\`${model ? ` · model \`${model}\`` : ""}${effort ? ` · reasoning \`${effort}\`` : ""}${fast === undefined ? "" : ` · fast \`${fast ? "on" : "off"}\``}.`,
      threadPath: source?.path,
    }
  }
  const workspace = await resolveRelayWorkspace({
    selected: payload.selection.cwd,
    threadCwd: source?.cwd,
    recent: options.recentWorkspaces,
  })
  const cwd = workspace.cwd
  onEvent({
    kind: "lifecycle",
    status: "running",
    detail: `${profile.label} ${describeRelayWorkspace(workspace)}`,
  })
  const staged = await stageRelayAttachments(payload, {
    assetRoot: options.assetRoot,
    cwd,
    deviceId,
    jobId,
  })
  try {
    const execution = await conversations.execute({
      jobId,
      cwd,
      provider: harness,
      sourcePath: source?.path,
      tuning: resolved ?? {},
      text: relayPrompt(payload.text, staged.paths, staged.manifestPath),
      attachments: staged.paths.map((path, index) => ({
        path,
        name: payload.attachments[index]?.name ?? path,
        mimeType:
          payload.attachments[index]?.mimeType ?? "application/octet-stream",
        size: payload.attachments[index]?.size ?? 0,
      })),
      signal,
      emit: onEvent,
    })
    try {
      await uploadRelayArtifacts({
        cwd,
        deviceId,
        jobId,
        manifestPath: staged.manifestPath,
      })
    } catch (error) {
      execution.result += `\n\nMako could not return a generated file: ${error instanceof Error ? error.message : String(error)}`
    }
    return { ...execution, cwd }
  } finally {
    await staged.cleanup()
  }
}

async function renewLease(
  id: string,
  lease: RelayLease,
  heartbeat: WorkerHeartbeat
): Promise<string> {
  let failure: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const renewed = await backendRelayPost(
        "/api/relay/renew",
        JSON.stringify({
          deviceId: id,
          jobId: lease.jobId,
          messageId: lease.messageId,
          popReceipt: lease.popReceipt,
          visibilityTimeoutSeconds: 300,
          heartbeat,
        })
      )
      if (!renewed.ok) {
        throw new Error(`Relay renewal returned ${renewed.status}`)
      }
      return z
        .object({ popReceipt: z.string().min(1) })
        .parse(z.json().parse(await renewed.json())).popReceipt
    } catch (error) {
      failure = error
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    }
  }
  throw failure
}

async function completeRelay(body: string): Promise<void> {
  const response = await backendRelayPost("/api/relay/complete", body)
  if (!response.ok)
    throw new Error(`Relay completion returned ${response.status}`)
}

/** The same failure repeating: one line every ten minutes, not one per poll. */
function failureLogger(): (failure: RelayWorkerFailure) => void {
  let last: { key: string; at: number } | null = null
  return (failure) => {
    const key = `${failure.phase}\0${failure.message}`
    const at = Date.parse(failure.at)
    if (last && last.key === key && at - last.at < 600_000) return
    last = { key, at }
    log().warn(`${failure.phase} failed: ${failure.message}`)
  }
}

function createRelayWorker(
  options: RelayWorkerOptions,
  id: string
): HeadlessRelayWorker {
  const logFailure = failureLogger()
  const worker: HeadlessRelayWorker = new HeadlessRelayWorker(
    {
      async lease(request, signal) {
        const response = await backendRelayPost(
          "/api/relay/lease",
          JSON.stringify(request),
          signal
        )
        if (!response.ok)
          throw new Error(`Relay lease returned ${response.status}`)
        const value = z.json().parse(await response.json())
        return EmptySchema.safeParse(value).success ? null : parseLease(value)
      },
      renew: (lease) => renewLease(id, lease, worker.heartbeat()),
      async sendEvents(batch) {
        const response = await backendRelayPost(
          "/api/relay/events",
          JSON.stringify(batch)
        )
        if (!response.ok)
          throw new Error(`Relay events returned ${response.status}`)
      },
      async control(lease) {
        const response = await backendRelayPost(
          "/api/relay/control",
          JSON.stringify({ deviceId: id, jobId: lease.jobId })
        )
        if (!response.ok)
          throw new Error(`Relay control returned ${response.status}`)
        return z
          .object({
            control: z
              .union([
                RelayControlSchema,
                z
                  .literal("stop")
                  .transform(() => RelayControlSchema.parse({ kind: "stop" })),
              ])
              .nullable(),
          })
          .parse(z.json().parse(await response.json())).control
      },
      complete: (completion) => completeRelay(JSON.stringify(completion)),
    },
    {
      control: (lease, control) =>
        options.conversations.control(lease.jobId, control),
      async execute(lease, context) {
        const ref = relayJobRef(lease.jobId)
        log().info(`job ${lease.jobId} (${lease.payload.kind}) leased`)
        try {
          const execution = await executePayload(
            lease.payload,
            options,
            context.signal,
            lease.jobId,
            id,
            context.emit
          )
          log().info(
            `job ${lease.jobId} ${execution.status ?? "done"}${execution.cwd ? ` in ${execution.cwd}` : ""}`
          )
          return { ...execution, status: execution.status ?? "done" }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)
          log().warn(`job ${lease.jobId} failed: ${message}`)
          // Every user-facing failure names the job so it can be traced
          // from the Slack reply to this log and to the gateway's tables.
          if (error instanceof RelayWorkspaceError)
            return {
              harness: lease.payload.selection.harness ?? DEFAULT_HARNESS,
              result: `${error.message} (job ${ref})`,
              status: "failed",
            }
          throw new Error(
            `Mako could not run this on ${options.deviceName}: ${message} (job ${ref})`,
            { cause: error }
          )
        }
      },
    },
    {
      heartbeat: () => {
        const heartbeat: RelayHostHeartbeat = {
          defaultHarness: DEFAULT_HARNESS,
          deviceId: id,
          deviceName: options.deviceName,
          version: options.version,
          kind: "desktop",
        }
        const workspace = currentWorkspaceName()
        if (workspace) heartbeat.workspace = workspace
        return heartbeat
      },
      onFailure: logFailure,
      onStatus: (status) => {
        presence = {
          kind: "worker",
          deviceName: options.deviceName,
          status,
          workspace: null,
        }
      },
    }
  )
  return worker
}

export async function startRelayWorker(
  options: RelayWorkerOptions
): Promise<void> {
  if (relayWorker) return
  relayLog = openRelayLog(options.logFile)
  const id = await deviceId(options.deviceFile)
  await configureBackendRelayDevice({
    deviceId: id,
    deviceName: options.deviceName,
    defaultHarness: DEFAULT_HARNESS,
  })
  workerOptions = options
  relayWorker = createRelayWorker(options, id)
  relayWorker.start()
  log().info(
    `worker ${id} listening as ${options.deviceName} (${options.version}); log at ${options.logFile}`
  )
}

export function disableRelayWorker(reason: string): void {
  presence = { kind: "disabled", reason }
  console.info(`[mako-relay] ${reason}`)
}

export async function stopRelayWorker(): Promise<void> {
  const worker = relayWorker
  relayWorker = null
  if (!worker) return
  await worker.stop()
  log().info("worker stopped")
  await relayLog?.flush()
}
