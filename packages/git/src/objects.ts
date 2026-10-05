import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { gitAtLeast, gitEnvironment, gitExecutable, run } from "./run.js"

export interface ObjectInfo {
  oid: string
  type: string
  size: number
}

export interface ObjectContents extends ObjectInfo {
  data: Buffer
}

interface Pending {
  contents: boolean
  resolve: (value: ObjectContents | ObjectInfo | null) => void
  reject: (error: Error) => void
}

/** A reader gone this long without a request ends its process. */
const IDLE_MS = 30_000

/**
 * Objects by name (`HEAD:path`, `:path` for the index, an oid), through one
 * `git cat-file --batch-command` per repository. A preview then costs a pipe
 * write instead of a process: 0.1 ms against 5 ms. Names with a newline, and
 * Git older than 2.36, take a process each.
 */
export class ObjectReader {
  private child: ChildProcessByStdio<Writable, Readable, null> | undefined
  private readonly pending: Pending[] = []
  private buffer: Buffer = Buffer.alloc(0)
  private body: { info: ObjectInfo; pending: Pending } | undefined
  private idle: NodeJS.Timeout | undefined
  private readonly root: string
  private batched: Promise<boolean> | undefined

  constructor(root: string) {
    this.root = root
  }

  info(name: string): Promise<ObjectInfo | null> {
    return this.request(name, false)
  }

  async contents(name: string): Promise<ObjectContents | null> {
    const found = await this.request(name, true)
    return found && "data" in found ? found : null
  }

  close(): void {
    clearTimeout(this.idle)
    this.idle = undefined
    const child = this.child
    this.child = undefined
    child?.stdin.end()
    this.fail(new Error("The object reader closed."))
  }

  private async request(name: string, contents: boolean): Promise<ObjectContents | ObjectInfo | null> {
    if (name.includes("\n") || !(await (this.batched ??= gitAtLeast(2, 36)))) return this.single(name, contents)
    return new Promise((resolve, reject) => {
      const child = this.process()
      clearTimeout(this.idle)
      this.idle = undefined
      hold(child, true)
      this.pending.push({ contents, resolve, reject })
      child.stdin.write(`${contents ? "contents" : "info"} ${name}\n`)
    })
  }

  private async single(name: string, contents: boolean): Promise<ObjectContents | ObjectInfo | null> {
    const check = await run({ cwd: this.root, args: ["cat-file", "--batch-check"], input: `${name.replace(/\n/g, "")}\n`, read: true }).catch(() => null)
    const info = check ? parseHeader(check.stdout.toString("utf8").split("\n")[0] ?? "") : null
    if (!info) return null
    if (!contents) return info
    const blob = await run({ cwd: this.root, args: ["cat-file", info.type, info.oid], read: true })
    return { ...info, data: blob.stdout }
  }

  private process(): ChildProcessByStdio<Writable, Readable, null> {
    if (this.child) return this.child
    const child = spawn(gitExecutable(), ["--no-optional-locks", "cat-file", "--batch-command"], {
      cwd: this.root,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    })
    this.child = child
    this.buffer = Buffer.alloc(0)
    this.body = undefined
    child.stdin.on("error", () => {})
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk))
    const ended = () => {
      if (this.child !== child) return
      this.child = undefined
      this.fail(new Error("Git's object reader stopped."))
    }
    child.on("error", ended)
    child.on("close", ended)
    return child
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (true) {
      if (this.body) {
        const { info, pending } = this.body
        if (this.buffer.length < info.size + 1) return
        const data = Buffer.from(this.buffer.subarray(0, info.size))
        this.buffer = this.buffer.subarray(info.size + 1)
        this.body = undefined
        pending.resolve({ ...info, data })
        continue
      }
      const end = this.buffer.indexOf(10)
      if (end < 0) break
      const header = this.buffer.subarray(0, end).toString("utf8")
      this.buffer = this.buffer.subarray(end + 1)
      const pending = this.pending.shift()
      if (!pending) continue
      const info = parseHeader(header)
      if (!info) pending.resolve(null)
      else if (pending.contents) this.body = { info, pending }
      else pending.resolve(info)
    }
    if (this.pending.length === 0 && !this.body) this.rest()
  }

  private rest(): void {
    if (this.child) hold(this.child, false)
    clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      if (this.pending.length === 0 && !this.body) this.close()
    }, IDLE_MS)
    this.idle.unref()
  }

  private fail(error: Error): void {
    const body = this.body
    this.body = undefined
    body?.pending.reject(error)
    for (const pending of this.pending.splice(0)) pending.reject(error)
  }
}

/** An idle reader doesn't keep the process alive; one with requests out does. */
function hold(child: ChildProcessByStdio<Writable, Readable, null>, held: boolean): void {
  // SAFETY: spawn's pipes are net.Socket instances, which have ref and unref; the optional calls skip any stream without them.
  const handles = [child, child.stdin as Writable & { ref?(): void; unref?(): void }, child.stdout as Readable & { ref?(): void; unref?(): void }]
  for (const handle of handles) {
    if (held) handle.ref?.()
    else handle.unref?.()
  }
}

/** `<oid> <type> <size>`, or null for `<name> missing` and its kin. */
function parseHeader(line: string): ObjectInfo | null {
  const match = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(line)
  return match ? { oid: match[1]!, type: match[2]!, size: Number(match[3]) } : null
}
