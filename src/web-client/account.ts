import { CloudRepositorySchema, githubRepositoryUrl, type CloudRepository } from "@mako/host/contracts/cloud-threads"
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
