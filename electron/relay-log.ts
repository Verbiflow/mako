import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * The detached host runs with its stdio ignored, so `console` output from the
 * relay is lost. This log is the durable record: one line per lifecycle event,
 * lease, completion, and failure, each carrying the job id that the Slack
 * reply also shows, so a user-facing error can be traced to its cause.
 *
 * Bounded by rotation: when the file passes `maxBytes` it becomes `<path>.1`
 * and the previous `.1` is dropped. Writes are serialized and never throw;
 * a logging failure must not fail the relay.
 */
export interface RelayLog {
  readonly path: string
  info(message: string): void
  warn(message: string): void
  /** Resolves once every line written so far is on disk. */
  flush(): Promise<void>
}

export const RELAY_LOG_MAX_BYTES = 1024 * 1024

export function openRelayLog(
  path: string,
  options: { maxBytes?: number; now?: () => Date } = {}
): RelayLog {
  const maxBytes = options.maxBytes ?? RELAY_LOG_MAX_BYTES
  const now = options.now ?? (() => new Date())
  let queue: Promise<void> = Promise.resolve()

  const write = async (level: "info" | "warn", message: string) => {
    const line = `${now().toISOString()} ${level.padEnd(4)} ${message.replace(/\r?\n/g, " ")}\n`
    await mkdir(dirname(path), { recursive: true })
    const size = await stat(path)
      .then((entry) => entry.size)
      .catch(() => 0)
    if (size > 0 && size + line.length > maxBytes)
      await rename(path, `${path}.1`)
    await appendFile(path, line, "utf8")
  }

  const enqueue = (level: "info" | "warn", message: string) => {
    queue = queue.then(() => write(level, message)).catch(() => undefined)
  }

  return {
    path,
    info: (message) => enqueue("info", message),
    warn: (message) => enqueue("warn", message),
    flush: () => queue,
  }
}

/** The first eight characters: enough to find a job in the log and the tables. */
export function relayJobRef(jobId: string): string {
  return jobId.slice(0, 8)
}
