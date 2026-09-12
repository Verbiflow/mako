import { execFile } from "node:child_process"
import { environmentForExecutable, resolveExecutable } from "../../executable.js"
import {
  argumentAfter,
  dropUncarried,
  type NativeRunOptions,
  type NativeRunner,
  type PreparedRun,
} from "../native-runner.js"
import {
  describeCursorCliModel,
  parseCursorModelList,
  parseCursorSelection,
  resolveCursorCliModel,
} from "./model-ids.js"

/**
 * `cursor-agent -p` takes the model as one flat id from the account's own
 * list (`model-ids.ts`), so the selection is settled in `prepare` against
 * `cursor-agent --list-models` and the command then carries only that id.
 * A selection the list cannot express fails here, by name, rather than
 * running under whichever model Cursor would pick.
 *
 * Note that `--resume <id>` on an ACP session writes the continuation to a
 * second store under `~/.cursor/chats/`; the desk resumes ACP sessions over
 * `session/load` instead and reaches this runner only for the CLI's own
 * chats and for fresh handoffs.
 */
const LIST_TIMEOUT_MS = 20_000
const LIST_CACHE_MS = 10 * 60_000
const CARRIES = ["effort", "thinking", "fast"] as const

export type CursorModelLister = (env: NodeJS.ProcessEnv) => Promise<string[]>

export function listCursorCliModels(env: NodeJS.ProcessEnv): Promise<string[]> {
  const executable = resolveExecutable("cursor-agent", env)
  if (!executable) return Promise.reject(new Error("cursor-agent is not installed"))
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["--list-models"],
      {
        env: environmentForExecutable(executable, env),
        timeout: LIST_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const ids = parseCursorModelList(String(stdout))
        if (ids.length > 0) {
          resolve(ids)
          return
        }
        const detail =
          String(stderr).trim().split("\n").at(-1) ||
          String(stdout).trim().split("\n").at(-1) ||
          (error ? error.message : "no models listed")
        reject(new Error(`Cursor's model list could not be read: ${detail}`))
      }
    )
  })
}

export function createCursorNativeRunner(
  listModels: CursorModelLister = listCursorCliModels,
  now: () => number = Date.now
): NativeRunner {
  const cache = new Map<string, { at: number; ids: Promise<string[]> }>()
  const models = (env: NodeJS.ProcessEnv): Promise<string[]> => {
    // The list is per account; the key names which credentials answered.
    const key = `${env.CURSOR_API_KEY ? "key" : "login"}:${env.HOME ?? ""}:${env.CURSOR_CONFIG_DIR ?? ""}`
    const held = cache.get(key)
    if (held && now() - held.at < LIST_CACHE_MS) return held.ids
    const ids = listModels(env)
    cache.set(key, { at: now(), ids })
    ids.catch(() => cache.delete(key))
    return ids
  }
  const modelArgs = (options: NativeRunOptions | undefined): string[] =>
    options?.model ? ["--model", options.model] : []
  return {
    provider: "cursor",
    fastMode: "supported",
    carries: CARRIES,
    async prepare(options, env): Promise<PreparedRun> {
      const { base, tokens } = parseCursorSelection(options)
      const carried = dropUncarried(options, CARRIES)
      if (!base && tokens.size === 0) return carried
      const available = await models(env)
      // A live session keeps the provider's defaults; a flat id has to spell
      // them, so the catalog's defaults fill what the selection left unsaid.
      const defaults = dropUncarried({ options: options.defaults ?? {} }, CARRIES).options.options
      const selection = {
        model: base ?? "auto",
        options: { ...defaults, ...carried.options.options },
      }
      const defaultLevel = options.defaults?.effort
      const resolved = resolveCursorCliModel(
        selection,
        available,
        defaultLevel === true || defaultLevel === false ? undefined : defaultLevel
      )
      if (!resolved) {
        const asked = [selection.model, ...tokens].join(" ")
        throw new Error(
          `Cursor's command line has no model id for ${asked}; choose another model for this reply.`
        )
      }
      // The id carries the settings now; the command states nothing else.
      const prepared: PreparedRun = {
        options: { ...carried.options, model: resolved.id, options: {} },
        dropped: carried.dropped,
      }
      if (resolved.bareLevel !== undefined) prepared.implicit = ["effort"]
      return prepared
    },
    resume(id, prompt, options) {
      return {
        command: "cursor-agent",
        args: ["-p", prompt, "--resume", id, "--force", ...modelArgs(options)],
      }
    },
    fresh(prompt, options) {
      return {
        command: "cursor-agent",
        args: ["-p", prompt, "--force", ...modelArgs(options)],
      }
    },
    describe({ args }, catalog) {
      const id = argumentAfter(args, "--model")
      if (id === undefined) return { model: undefined, options: {} }
      return describeCursorCliModel(id, catalog)
    },
  }
}

export const cursorNativeRunner: NativeRunner = createCursorNativeRunner()
