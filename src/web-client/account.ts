import { bootFolder, CloudRepositorySchema, githubRepositoryUrl, type CloudRepository } from "@mako/host/contracts/cloud-threads"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import type { LiveStartOptions } from "@mako/host/contracts/live-conversations"
import { z } from "zod"
import type { Gateway } from "./gateway"

/** A project the account can start a cloud Thread in: a repository its Macs offered, or one a cloud Thread was made in. */
export interface WebProject {
  url: string
  name: string
  /** When a Thread was last started in it, or it was last offered, in ISO time. */
  usedAt: string
}

/** The account's projects, as `GET /v1/projects` answers. */
const ProjectsSchema = z.object({
  projects: z.array(z.object({ url: z.string(), name: z.string(), usedAt: z.string() }) satisfies z.ZodType<WebProject>),
})

/** The harnesses this cloud's machines run, as `GET /v1/cloud/harnesses` answers: by name, or listed one by one. */
const CloudHarnessesSchema = z.object({
  harnesses: z.union([z.array(z.object({ harness: z.string().optional(), name: z.string().optional() })), z.record(z.string(), z.json())]),
})

/** What a phone's start of a cloud Thread made: the Thread, and the conversation its first message went to. */
export interface StartedThread {
  threadId: string
  conversationId: string
}

/** The steps of a start, as the sheet says them: the Thread made, its machine up and its folder read, the harness started. */
export type StartStep = "making" | "preparing" | "starting"

/** The repository a person typed: a GitHub address in any of the shapes Git takes, or `owner/name`. */
export function typedRepository(text: string): CloudRepository | undefined {
  const trimmed = text.trim().replace(/\/+$/, "")
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed)
  const url = short ? `https://github.com/${short[1]}/${short[2]}` : githubRepositoryUrl(trimmed)
  const parsed = CloudRepositorySchema.safeParse({ url })
  return parsed.success ? parsed.data : undefined
}

/** The account's projects, newest first. */
export async function accountProjects(gateway: Gateway): Promise<WebProject[]> {
  const { projects } = ProjectsSchema.parse(await gateway.rest("GET", "/v1/projects"))
  return projects
}

/**
 * Starts a Thread in the cloud from this browser, as a Mac's cloud start does (`CloudConversations.#start`): the Thread
 * made with its repository, its machine's folder read from its boot, then the harness started there with the first
 * message as its first request. Its machine reports it to the account's list, so every device lists it as it starts.
 */
export async function startCloudThread(
  gateway: Gateway,
  deviceId: string,
  start: { repository: CloudRepository; harness: string; text: string; title?: string; modeId?: string },
  step: (step: StartStep) => void
): Promise<StartedThread> {
  step("making")
  const threadId = `t-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
  await gateway.rest("POST", "/v1/threads", { threadId, home: "cloud", repository: start.repository, harness: start.harness })
  const calls = gatewayHostCalls(gateway.session, { threadId, actor: { kind: "client", client: "web", deviceId }, history: true })
  step("preparing")
  const cwd = bootFolder(await sendWithRepeats("mako:boot", calls.call("mako:boot", []), { threadId }))
  step("starting")
  const conversationId = crypto.randomUUID()
  const options: LiveStartOptions = { conversationId, initialRequest: { id: crypto.randomUUID(), text: start.text, attachments: [] } }
  if (start.title) options.title = start.title
  if (start.modeId) options.modeId = start.modeId
  await sendWithRepeats("mako:live-start", calls.call("mako:live-start", [start.harness, cwd, options]), { threadId, conversationId })
  return { threadId, conversationId }
}

/** The harnesses this cloud's machines run, by name; empty when the cloud names no image (a local one). */
export async function cloudHarnesses(gateway: Gateway): Promise<string[]> {
  try {
    const { harnesses } = CloudHarnessesSchema.parse(await gateway.rest("GET", "/v1/cloud/harnesses"))
    if (Array.isArray(harnesses)) return harnesses.flatMap((entry) => (entry.harness ?? entry.name ? [String(entry.harness ?? entry.name)] : []))
    return Object.keys(harnesses)
  } catch {
    return []
  }
}

/** How long a page in front counts as the person being here, after it last said so. */
export const ATTENTION_MS = 120_000
const ATTENTION_EVERY_MS = 60_000

/**
 * Says to the account while this page is in front of the person, and when it stops being, so a notice for them waits
 * while they're here (`needs you`). Said at most once a minute while it lasts; a page hidden says so at once.
 */
export function reportAttention(gateway: Gateway): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  let attending = false
  const say = (now: boolean) => {
    attending = now
    void gateway.rest("PUT", "/v1/attention", { attending: now }).catch(() => undefined)
  }
  const look = () => {
    const here = document.visibilityState === "visible" && document.hasFocus()
    if (here && !timer) {
      say(true)
      timer = setInterval(() => say(true), ATTENTION_EVERY_MS)
    } else if (!here && timer) {
      clearInterval(timer)
      timer = undefined
      if (attending) say(false)
    }
  }
  const events = ["visibilitychange", "focus", "blur"] as const
  for (const event of events) window.addEventListener(event, look)
  document.addEventListener("visibilitychange", look)
  look()
  return () => {
    for (const event of events) window.removeEventListener(event, look)
    document.removeEventListener("visibilitychange", look)
    if (timer) clearInterval(timer)
  }
}
