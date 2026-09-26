import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { z } from "zod"
import type { LocalBrowser } from "./browser-discovery.js"
import {
  processRegistrationStartedAt,
  registeredProcessIsCurrentAsync,
} from "./process-registration.js"

const MAX_REGISTRATION_BYTES = 8_192
const DeskBrowserRegistrationSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^mako-dev-[a-f0-9]{16}$/),
    name: z.string().min(1).max(200),
    endpoint: z.string().url(),
    pid: z.number().int().positive(),
    startedAt: z.number().int().nonnegative(),
    profile: z.string().min(1).max(100),
    origin: z.string().url(),
    sourceRoot: z.string().min(1).max(4_096),
    fixture: z.literal(true).optional(),
  })
  .strict()

type DeskBrowserRegistration = z.infer<
  typeof DeskBrowserRegistrationSchema
>

export function deskBrowserRegistrationRoot(): string {
  return join(homedir(), ".mako", "desk-browsers")
}

function validateRegistration(
  registration: DeskBrowserRegistration
): DeskBrowserRegistration {
  const endpoint = new URL(registration.endpoint)
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    !/^\/devtools\/browser\/[A-Za-z0-9_-]{32}$/.test(endpoint.pathname)
  )
    throw new Error("Invalid Mako desk registration endpoint")
  const origin = new URL(registration.origin)
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  )
    throw new Error("A development desk must use a loopback origin")
  if (resolve(registration.sourceRoot) !== registration.sourceRoot)
    throw new Error("A development desk source root must be absolute")
  process.kill(registration.pid, 0)
  return registration
}

function readRegistration(path: string): DeskBrowserRegistration {
  const file = openSync(path, "r")
  try {
    const bytes = Buffer.alloc(MAX_REGISTRATION_BYTES + 1)
    const count = readSync(file, bytes)
    if (count > MAX_REGISTRATION_BYTES)
      throw new Error("Mako desk registration exceeds its size limit")
    return validateRegistration(
      DeskBrowserRegistrationSchema.parse(
        JSON.parse(bytes.subarray(0, count).toString("utf8"))
      )
    )
  } finally {
    closeSync(file)
  }
}

function registrationId(sourceRoot: string, profile: string): string {
  const identity = createHash("sha256")
    .update(`${resolve(sourceRoot)}\0${profile}`)
    .digest("hex")
    .slice(0, 16)
  return `mako-dev-${identity}`
}

export function publishDeskBrowserRegistration(
  input: {
    endpoint: string
    origin: string
    pid?: number
    profile: string
    sourceRoot: string
    fixture?: boolean
  },
  root = deskBrowserRegistrationRoot()
): () => void {
  const sourceRoot = resolve(input.sourceRoot)
  const id = registrationId(sourceRoot, input.profile)
  const fields: DeskBrowserRegistration = {
    version: 1,
    id,
    name: `Mako dev · ${basename(sourceRoot)} · ${input.profile}`,
    endpoint: input.endpoint,
    pid: input.pid ?? process.pid,
    startedAt: processRegistrationStartedAt(input.pid ?? process.pid),
    profile: input.profile,
    origin: new URL(input.origin).origin,
    sourceRoot,
  }
  if (input.fixture) fields.fixture = true
  const registration = validateRegistration(
    DeskBrowserRegistrationSchema.parse(fields)
  )
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  const path = join(root, `${id}.json`)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(registration)}\n`, {
      flag: "wx",
      mode: 0o600,
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return () => {
    try {
      const current = readRegistration(path)
      if (
        current.pid === registration.pid &&
        current.endpoint === registration.endpoint
      )
        rmSync(path, { force: true })
    } catch {
      // Another host replaced it or it was already removed.
    }
  }
}

export function registeredDeskBrowsers(
  root = deskBrowserRegistrationRoot()
): LocalBrowser[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const browsers: LocalBrowser[] = []
  for (const name of names
    .filter((candidate) => /^mako-dev-[a-f0-9]{16}\.json$/.test(candidate))
    .sort()) {
    if (browsers.length >= 32) break
    const path = join(root, name)
    try {
      const registration = readRegistration(path)
      const browser: LocalBrowser = {
        id: registration.id,
        name: registration.name,
        requiresApproval: false,
        kind: "desk",
        profile: registration.profile,
        origin: registration.origin,
        sourceRoot: registration.sourceRoot,
        endpoint: async () => {
          const current = readRegistration(path)
          if (
            !(await registeredProcessIsCurrentAsync(
              current.pid,
              current.startedAt,
              AbortSignal.timeout(2_000)
            ))
          )
            throw new Error("The registered Mako host is no longer running")
          return current.endpoint
        },
      }
      if (registration.fixture) browser.fixture = true
      browsers.push(browser)
    } catch {
      // A dead host or malformed same-user registration is unavailable.
    }
  }
  return browsers
}
