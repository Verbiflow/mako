import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { lock } from "proper-lockfile"
import { z } from "zod"
import type { NativeAuthoringDocument } from "../contracts/native-authoring.js"
import type { ProviderAuthoringCapability } from "./editing-capability.js"
import { onWindows } from "../platform.js"

const LIMIT = 256 * 1024
const IdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
const JsonObject = z.record(z.string(), z.json())
const writes = new Map<string, Promise<unknown>>()
const missing = ({ error }: { error: unknown }) => error instanceof Error && "code" in error && error.code === "ENOENT"
const revision = (contents: string | null) => contents === null ? null : createHash("sha256").update(contents).digest("hex")

async function boundedRead(path: string): Promise<string | null> {
  let file
  try { file = await open(path, "r") }
  catch (error) { if (missing({ error })) return null; throw error }
  try {
    if ((await file.stat()).size > LIMIT) throw new Error("This configuration exceeds the 256 KB editor limit. Edit it in your text editor.")
    const bytes = Buffer.alloc(LIMIT + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > LIMIT) throw new Error("This configuration grew beyond the 256 KB editor limit.")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))
  } finally { await file.close() }
}

async function writablePath(cwd: string, path: string): Promise<void> {
  const root = await realpath(cwd)
  let ancestor = path
  while (true) {
    try {
      const actual = await realpath(ancestor)
      const suffix = relative(root, actual)
      if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${onWindows() ? "\\" : "/"}`))
        throw new Error("This configuration links outside the project. Edit its original file in your text editor.")
      break
    } catch (error) {
      if (!missing({ error })) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
  const stat = await lstat(path).catch((error) => { if (missing({ error })) return null; throw error })
  if (stat?.isSymbolicLink()) throw new Error("This configuration is a symbolic link. Edit its original file in your text editor.")
}

/** One source-revision write across app profiles; no overwrite after an external edit. */
async function mutateFile<T>(cwd: string, path: string, run: () => Promise<T>): Promise<T> {
  const previous = writes.get(path) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    await writablePath(cwd, path)
    await mkdir(dirname(path), { recursive: true })
    // SAFETY: every profile uses this stable target and lease timing. A
    // compromised lease must fail closed rather than continuing a stale write.
    const release = await lock(path, { realpath: false, stale: 60_000, update: 5_000, retries: { retries: 20, minTimeout: 100, maxTimeout: 500 } })
    try { return await run() } finally { await release() }
  })
  writes.set(path, operation)
  try { return await operation }
  finally { if (writes.get(path) === operation) writes.delete(path) }
}

type HookConfiguration = z.infer<typeof JsonObject>

interface FileSource {
  path(cwd: string, id: string): string
  list(cwd: string): Promise<{ id: string; name: string }[]>
  decode(contents: string | null): string
  encode(contents: string, previous: string | null): string
  remove(previous: string): string | null
}

function authoring(provider: string, detail: string, source: FileSource): ProviderAuthoringCapability {
  const read = async (cwd: string, id: string): Promise<NativeAuthoringDocument> => {
    IdSchema.parse(id)
    const path = source.path(cwd, id)
    const contents = await boundedRead(path)
    return { id, name: id, path, contents: source.decode(contents), revision: revision(contents) }
  }
  return {
    provider, detail, list: source.list, read,
    write: async (cwd, id, contents, expected) => {
      IdSchema.parse(id)
      if (Buffer.byteLength(contents) > LIMIT) throw new Error("Keep this configuration below 256 KB.")
      const path = source.path(cwd, id)
      return mutateFile(cwd, path, async () => {
        const previous = await boundedRead(path)
        if (revision(previous) !== expected) throw new Error("This file changed after opening. Reload it before saving.")
        const next = source.encode(contents, previous)
        if (Buffer.byteLength(next) > LIMIT) throw new Error("The merged configuration exceeds the 256 KB editor limit.")
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, next, { mode: 0o600, flag: "wx" })
          if (revision(await boundedRead(path)) !== expected) throw new Error("This file changed while saving. Reload it before saving.")
          await writablePath(cwd, path)
          await rename(temporary, path)
        } finally { await unlink(temporary).catch((error) => { if (!missing({ error })) throw error }) }
        return { id, name: id, path, contents: source.decode(next), revision: revision(next) }
      })
    },
    remove: async (cwd, id, expected) => {
      IdSchema.parse(id)
      const path = source.path(cwd, id)
      await mutateFile(cwd, path, async () => {
        const previous = await boundedRead(path)
        if (previous === null || revision(previous) !== expected) throw new Error("This file changed after opening. Reload it before removing.")
        const next = source.remove(previous)
        await writablePath(cwd, path)
        if (next === null) {
          if (revision(await boundedRead(path)) !== expected) throw new Error("This file changed while removing. Reload it before removing.")
          await unlink(path)
        }
        else {
          const temporary = `${path}.${randomUUID()}.tmp`
          try {
            await writeFile(temporary, next, { mode: 0o600, flag: "wx" })
            if (revision(await boundedRead(path)) !== expected) throw new Error("This file changed while removing. Reload it before removing.")
            await rename(temporary, path)
          } finally { await unlink(temporary).catch((error) => { if (!missing({ error })) throw error }) }
        }
      })
    },
  }
}

/** Native Markdown command syntax remains unmodified, including frontmatter. */
export function markdownCommands(provider: string, directory: string): ProviderAuthoringCapability {
  return authoring(provider, "Project commands. Start a new agent connection to discover changes. Native frontmatter and argument syntax are preserved.", {
    path: (cwd, id) => join(cwd, directory, `${id}.md`),
    list: async (cwd) => {
      const entries = await readdir(join(cwd, directory), { withFileTypes: true }).catch((error) => { if (missing({ error })) return []; throw error })
      const commands = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && IdSchema.safeParse(entry.name.slice(0, -3)).success)
      if (commands.length > 128) throw new Error("This folder has more than 128 commands. Open it in your text editor.")
      return commands.map((entry) => ({ id: entry.name.slice(0, -3), name: `/${entry.name.slice(0, -3)}` })).sort((a, b) => a.name.localeCompare(b.name))
    },
    decode: (contents) => contents ?? "",
    encode: (contents) => { if (!contents.trim()) throw new Error("Write the command's instructions before saving."); return contents },
    remove: () => null,
  })
}

/** Edit only the hooks section; native unrelated settings remain intact. */
export function jsonHooks(provider: string, file: string, validate: (value: HookConfiguration) => HookConfiguration): ProviderAuthoringCapability {
  return authoring(provider, "Project hooks execute through the agent with its permissions. Start a new connection after editing. This editor changes only the hooks section.", {
    path: (cwd, id) => { if (id !== "configuration") throw new Error("Unknown hook configuration"); return join(cwd, file) },
    list: async () => [{ id: "configuration", name: "Hook configuration" }],
    decode: (contents) => JSON.stringify(contents === null ? {} : JsonObject.parse(JSON.parse(contents)).hooks ?? {}, null, 2),
    encode: (contents, previous) => {
      const hooks = validate(JsonObject.parse(JSON.parse(contents)))
      const config = previous === null ? {} : JsonObject.parse(JSON.parse(previous))
      return `${JSON.stringify({ ...config, hooks }, null, 2)}\n`
    },
    remove: (previous) => { const config = JsonObject.parse(JSON.parse(previous)); delete config.hooks; return `${JSON.stringify(config, null, 2)}\n` },
  })
}
