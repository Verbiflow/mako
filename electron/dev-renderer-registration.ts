import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  chmodSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import {
  processRegistrationStartedAt,
  registeredProcessIsCurrentAsync,
} from "./process-registration.js"

const FILE_NAME = "dev-renderer.json"
const MAX_BYTES = 8_192
const DevRendererRegistrationSchema = z
  .object({
    version: z.literal(1),
    runtimeId: z.string().regex(/^[a-f0-9]{16}$/),
    pid: z.number().int().positive(),
    startedAt: z.number().int().nonnegative(),
    publishedAt: z.number().int().positive(),
    profile: z.string().min(1).max(100),
    sourceRoot: z.string().min(1).max(4_096),
    url: z.string().url(),
  })
  .strict()

export type DevRendererRegistration = z.infer<
  typeof DevRendererRegistrationSchema
>

export function devRendererRegistrationRoot(): string {
  return join(homedir(), ".mako", "dev-renderers")
}

function runtimeId(runtimeDirectory: string): string {
  return createHash("sha256")
    .update(resolve(runtimeDirectory))
    .digest("hex")
    .slice(0, 16)
}

function validate(
  registration: DevRendererRegistration,
  expected?: {
    profile: string
    runtimeId: string
    sourceRoot: string
  }
): DevRendererRegistration {
  const url = new URL(registration.url)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("The development renderer must use a loopback URL")
  if (resolve(registration.sourceRoot) !== registration.sourceRoot)
    throw new Error("The development renderer source root must be absolute")
  if (
    expected &&
    (registration.runtimeId !== expected.runtimeId ||
      registration.profile !== expected.profile ||
      registration.sourceRoot !== resolve(expected.sourceRoot))
  )
    throw new Error("The development renderer belongs to another host")
  return registration
}

function readPath(
  path: string,
  expected?: {
    profile: string
    runtimeId: string
    sourceRoot: string
  }
): DevRendererRegistration | null {
  let file: number
  try {
    file = openSync(path, "r")
  } catch {
    return null
  }
  try {
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    const count = readSync(file, bytes)
    if (count > MAX_BYTES)
      throw new Error("Development renderer registration is too large")
    return validate(
      DevRendererRegistrationSchema.parse(
        JSON.parse(bytes.subarray(0, count).toString("utf8"))
      ),
      expected
    )
  } catch {
    return null
  } finally {
    closeSync(file)
  }
}

async function read(
  runtimeDirectory: string,
  expected: { profile: string; sourceRoot: string },
  root = devRendererRegistrationRoot()
): Promise<DevRendererRegistration | null> {
  const identity = runtimeId(runtimeDirectory)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return null
  }
  const registrations: DevRendererRegistration[] = []
  const pattern = new RegExp(`^${FILE_NAME.slice(0, -5)}-${identity}-\\d+\\.json$`)
  for (const name of names.filter((candidate) => pattern.test(candidate))) {
    const registration = readPath(join(root, name), {
      ...expected,
      runtimeId: identity,
    })
    if (registration) registrations.push(registration)
  }
  const sorted = registrations.sort(
    (left, right) =>
      right.publishedAt - left.publishedAt || right.pid - left.pid
  )
  for (const registration of sorted)
    if (
      await registeredProcessIsCurrentAsync(
        registration.pid,
        registration.startedAt,
        AbortSignal.timeout(2_000)
      )
    )
      return registration
  return null
}

export async function readDevRendererRegistration(
  runtimeDirectory: string,
  expected: { profile: string; sourceRoot: string },
  root = devRendererRegistrationRoot()
): Promise<DevRendererRegistration | null> {
  return read(runtimeDirectory, expected, root)
}

export function publishDevRendererRegistration(
  runtimeDirectory: string,
  input: {
    profile: string
    sourceRoot: string
    url: string
    pid?: number
  },
  root = devRendererRegistrationRoot()
): () => void {
  const pid = input.pid ?? process.pid
  const identity = runtimeId(runtimeDirectory)
  const registration = validate(
    DevRendererRegistrationSchema.parse({
      version: 1,
      runtimeId: identity,
      pid,
      startedAt: processRegistrationStartedAt(pid),
      publishedAt: Date.now(),
      profile: input.profile,
      sourceRoot: resolve(input.sourceRoot),
      url: input.url,
    })
  )
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  const path = join(root, `${FILE_NAME.slice(0, -5)}-${identity}-${pid}.json`)
  const temporary = `${path}.${registration.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(registration)}\n`, {
      mode: 0o600,
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return () => {
    const current = readPath(path)
    if (
      current?.pid === registration.pid &&
      current.startedAt === registration.startedAt &&
      current.url === registration.url
    )
      rmSync(path, { force: true })
  }
}

export function watchDevRendererRegistration(
  runtimeDirectory: string,
  expected: { profile: string; sourceRoot: string },
  listener: (registration: DevRendererRegistration | null) => void,
  root = devRendererRegistrationRoot()
): () => void {
  let watcher: FSWatcher | undefined
  let poller: NodeJS.Timeout | undefined
  let pending: NodeJS.Timeout | undefined
  let last: string | undefined
  let refreshing = false
  let refreshAgain = false
  let stopped = false
  const refresh = async (): Promise<void> => {
    if (refreshing) {
      refreshAgain = true
      return
    }
    refreshing = true
    try {
      do {
        refreshAgain = false
        const registration = await read(
          runtimeDirectory,
          {
            profile: expected.profile,
            sourceRoot: resolve(expected.sourceRoot),
          },
          root
        )
        if (stopped) return
        const serialized = JSON.stringify(registration)
        if (serialized !== last) {
          last = serialized
          listener(registration)
        }
      } while (refreshAgain)
    } finally {
      refreshing = false
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  void refresh()
  watcher = watch(root, () => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = undefined
      void refresh()
    }, 25)
    pending.unref()
  })
  watcher.on("error", () => {
    watcher?.close()
    if (pending) clearTimeout(pending)
    pending = undefined
    watcher = undefined
    void refresh()
  })
  poller = setInterval(() => void refresh(), 2_000)
  poller.unref()
  return () => {
    stopped = true
    watcher?.close()
    if (pending) clearTimeout(pending)
    pending = undefined
    if (poller) clearInterval(poller)
    poller = undefined
  }
}
