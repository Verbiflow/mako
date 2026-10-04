import { execFile } from "node:child_process"
import { request } from "node:http"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, sep } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"

const run = promisify(execFile)

/** One request to the engine; a slower one is a runtime too busy to ask now. */
const REQUEST_MS = 2_000
const RESPONSE_BYTES = 8 * 1024 * 1024
/** Containers whose memory is read at once. */
const STATS_PARALLEL = 8
/** Where the engine listens is looked up again after this, so a runtime started or switched later is found. */
const ENDPOINT_TTL_MS = 60_000
/** Where the runtimes macOS developers use listen when neither `DOCKER_HOST` nor the CLI says. */
const KNOWN_SOCKETS = [
  "/var/run/docker.sock",
  join(homedir(), ".docker/run/docker.sock"),
  join(homedir(), ".orbstack/run/docker.sock"),
  join(homedir(), ".colima/default/docker.sock"),
  join(homedir(), ".rd/docker.sock"),
]
/** Compose's label for the folder `docker compose` ran in. */
const COMPOSE_FOLDER = "com.docker.compose.project.working_dir"
const COMPOSE_PROJECT = "com.docker.compose.project"

/** A running container, with what ties it to a folder on this Mac. */
export interface Container {
  id: string
  name: string
  image: string
  /** What it holds now, as `docker stats` counts it: usage less reclaimable file cache. Missing when it couldn't be read. */
  bytes?: number
  /** Its Compose working folder and the host folders it bind-mounts. */
  folders: string[]
  /** Its Compose project, when Compose started it. */
  project?: string
  /** Host ports it publishes. */
  ports: number[]
}

/** The container runtime at one look. */
export interface ContainerLook {
  at: number
  containers: Container[]
  /** What the runtime's machine can give containers in all, when it says: Docker Desktop's and OrbStack's VM limit, or Linux's memory. */
  totalBytes?: number
}

const ListSchema = z.array(z.object({
  Id: z.string(),
  Names: z.array(z.string()).optional(),
  Image: z.string().optional(),
  Labels: z.record(z.string(), z.string()).nullish(),
  Mounts: z.array(z.object({ Type: z.string().optional(), Source: z.string().optional() }).passthrough()).nullish(),
  Ports: z.array(z.object({ PublicPort: z.number().optional() }).passthrough()).nullish(),
}).passthrough())
const StatsSchema = z.object({
  memory_stats: z.object({
    usage: z.number().optional(),
    stats: z.record(z.string(), z.number()).optional(),
  }).passthrough().optional(),
}).passthrough()
const InfoSchema = z.object({ MemTotal: z.number().optional() }).passthrough()

let endpoint: { at: number; socket: Promise<string | undefined> } | undefined

/**
 * The engine's Unix socket: `DOCKER_HOST`, else the Docker CLI's current
 * context, else the first known socket that exists. Undefined for a remote
 * engine (its containers aren't on this Mac) or none at all.
 */
export function engineSocket(now = Date.now()): Promise<string | undefined> {
  if (!endpoint || now - endpoint.at > ENDPOINT_TTL_MS) endpoint = { at: now, socket: findSocket() }
  return endpoint.socket
}

async function findSocket(): Promise<string | undefined> {
  const named = process.env.DOCKER_HOST?.trim()
  if (named) return named.startsWith("unix://") ? named.slice("unix://".length) : undefined
  const host = await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeout: 3_000 })
    .then(({ stdout }) => stdout.trim(), () => "")
  if (host.startsWith("unix://")) return host.slice("unix://".length)
  if (host) return undefined
  for (const socket of KNOWN_SOCKETS) if ((await stat(socket).catch(() => undefined))?.isSocket()) return socket
  return undefined
}

/**
 * Every running container and what each holds, from the engine's API (about
 * 50 ms for the list and 20 ms a container, where `docker stats` takes two
 * seconds). Undefined when no engine on this Mac answers.
 */
export async function lookAtContainers(options: { socket?: string; now?: () => number } = {}): Promise<ContainerLook | undefined> {
  const socket = options.socket ?? (await engineSocket())
  if (!socket) return undefined
  const [listed, info] = await Promise.all([
    engine(socket, "/containers/json", ListSchema).catch(() => undefined),
    engine(socket, "/info", InfoSchema).catch(() => undefined),
  ])
  if (!listed) return undefined
  const containers = listed.map((entry): Container => {
    const labels = entry.Labels ?? {}
    const folders = [
      ...(labels[COMPOSE_FOLDER] ? [labels[COMPOSE_FOLDER]] : []),
      ...(entry.Mounts ?? []).flatMap((mount) => (mount.Type === "bind" && mount.Source ? [mount.Source] : [])),
    ]
    const container: Container = {
      id: entry.Id,
      name: (entry.Names?.[0] ?? entry.Id.slice(0, 12)).replace(/^\//, ""),
      image: entry.Image ?? "",
      folders: [...new Set(folders)],
      ports: [...new Set((entry.Ports ?? []).flatMap((port) => (port.PublicPort ? [port.PublicPort] : [])))].sort((a, b) => a - b),
    }
    if (labels[COMPOSE_PROJECT]) container.project = labels[COMPOSE_PROJECT]
    return container
  })
  for (let index = 0; index < containers.length; index += STATS_PARALLEL) {
    await Promise.all(containers.slice(index, index + STATS_PARALLEL).map(async (container) => {
      const stats = await engine(socket, `/containers/${container.id}/stats?stream=false&one-shot=true`, StatsSchema).catch(() => undefined)
      const bytes = heldBytes(stats?.memory_stats)
      if (bytes !== undefined) container.bytes = bytes
    }))
  }
  const look: ContainerLook = { at: (options.now ?? Date.now)(), containers }
  if (info?.MemTotal) look.totalBytes = info.MemTotal
  return look
}

/** Usage less the file cache the kernel can take back, as `docker stats` shows it (cgroup v2, then v1). */
function heldBytes(memory: z.infer<typeof StatsSchema>["memory_stats"]): number | undefined {
  if (memory?.usage === undefined) return undefined
  const cache = memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0
  return Math.max(0, memory.usage - cache)
}

/**
 * Which of `owners` each container is: the one with the deepest folder that
 * holds one of its folders. A container tied to none of them is left out.
 */
export function containersBy<T>(look: ContainerLook, owners: { owner: T; folders: string[] }[]): Map<T, Container[]> {
  const found = new Map<T, Container[]>()
  for (const container of look.containers) {
    let best: { owner: T; depth: number } | undefined
    for (const { owner, folders } of owners)
      for (const folder of folders)
        if (container.folders.some((path) => within(path, folder)) && (!best || folder.length > best.depth)) best = { owner, depth: folder.length }
    if (best) found.set(best.owner, [...(found.get(best.owner) ?? []), container])
  }
  return found
}

function within(path: string, root: string): boolean {
  const trimmed = root.endsWith(sep) ? root.slice(0, -1) : root
  return path === trimmed || path.startsWith(`${trimmed}${sep}`)
}

function engine<T>(socket: string, path: string, schema: z.ZodType<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const sent = request({ socketPath: socket, path, headers: { Host: "docker" }, timeout: REQUEST_MS }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > RESPONSE_BYTES) sent.destroy(new Error("The container runtime's answer is too large"))
        else chunks.push(chunk)
      })
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 400) return reject(new Error(`The container runtime answered ${response.statusCode}`))
        try {
          resolve(schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))))
        } catch (error) {
          reject(error)
        }
      })
      response.on("error", reject)
    })
    sent.on("timeout", () => sent.destroy(new Error("The container runtime didn't answer in time")))
    sent.on("error", reject)
    sent.end()
  })
}
