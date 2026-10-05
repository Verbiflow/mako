import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { cursorLegacyIdentity, cursorSdkReportedSettings, cursorSdkSelection, cursorStoreOrigin } from "@mako/sessions"
import type { SessionModel } from "@mako/sessions/settings"
import { headlessNodeExecutable } from "../../../headless-node.js"
import type { NativeCommand, NativeLaunch, NativeRunner, NativeRunOptions } from "../../native-runner.js"
import { cursorSdkChildEntry } from "./client.js"
import { CURSOR_SDK_HEADLESS, SdkHeadlessSpecSchema, type SdkHeadlessSpec, type SdkImportSource } from "./wire.js"

export interface CursorNativeRunnerDependencies {
  /** The child's environment: the account's, with Mako's own key when it holds one. */
  childLaunch(env?: NodeJS.ProcessEnv): Promise<NativeLaunch>
  stateRoot(): string
  /** The account's models and default, from the cache the live driver and profile share. */
  models(env: NodeJS.ProcessEnv): Promise<{ models: readonly SessionModel[]; defaultModel?: string }>
  home?: string
}

/**
 * Cursor's headless runs go through the same SDK child as its live sessions,
 * in its one-shot mode (`CURSOR_SDK_HEADLESS`), with the model selection the
 * live driver would send. There is no second transport to disagree with.
 */
export function cursorSdkNativeRunner(dependencies: CursorNativeRunnerDependencies): NativeRunner {
  /** Local SDK agents need a model on every run (SDK 1.0.31), so none selected means the account's default, as live. */
  async function selection(options: NativeRunOptions | undefined, env: NodeJS.ProcessEnv) {
    const catalog = await dependencies.models(env)
    const requested = options?.model ?? catalog.defaultModel ?? catalog.models[0]?.id
    const resolved = cursorSdkSelection({ ...options, model: requested }, catalog.models)
    if (!resolved) throw new Error(`Cursor does not offer the model "${requested ?? ""}" to this account`)
    return resolved
  }

  async function command(spec: Omit<SdkHeadlessSpec, "stateRoot" | "model">, options: NativeRunOptions | undefined, launchEnv?: NodeJS.ProcessEnv): Promise<NativeCommand> {
    const env = launchEnv ?? (await dependencies.childLaunch()).env
    const full: SdkHeadlessSpec = { ...spec, stateRoot: dependencies.stateRoot(), model: (await selection(options, env)).selection }
    const childEnv: NonNullable<NativeCommand["env"]> = { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" }
    if (env.CURSOR_API_KEY) childEnv.CURSOR_API_KEY = env.CURSOR_API_KEY
    return {
      command: headlessNodeExecutable(),
      args: [cursorSdkChildEntry(), CURSOR_SDK_HEADLESS, JSON.stringify(full)],
      env: childEnv,
    }
  }

  /** A thread still in a `cursor-agent` store is imported the first time it runs here, as the live driver does. */
  function importFrom(id: string, path: string | undefined): SdkImportSource | undefined {
    if (!path) return undefined
    const origin = cursorStoreOrigin(path, { home: dependencies.home })
    if (!origin || origin.origin === "sdk") return undefined
    return { path, identity: cursorLegacyIdentity(origin, id, dependencies.home ?? homedir()) }
  }

  return {
    provider: "cursor",
    transport: "cursor-sdk-headless",
    launchCredentials: { kind: "resolved", resolve: env => dependencies.childLaunch(env) },
    // The SDK ships inside Mako.
    available: () => true,
    fastMode: "unsupported",
    // Every option of the selected model rides its selection; `prepare` names what the model lacks.
    carries: [],
    async prepare(options, env) {
      return { options, dropped: (await selection(options, env)).dropped }
    },
    resume: (id, prompt, options, env) => command({ agentId: id, create: false, prompt, importFrom: importFrom(id, options?.nativePath) }, options, env),
    fresh: (prompt, options, env) => command({ agentId: randomUUID(), create: true, prompt }, options, env),
    describe({ args }, catalog) {
      let raw: unknown
      try {
        raw = JSON.parse(args[2] ?? "null")
      } catch {
        return {}
      }
      const spec = SdkHeadlessSpecSchema.safeParse(raw)
      if (!spec.success || !spec.data.model) return {}
      return cursorSdkReportedSettings(spec.data.model, catalog)
    },
  }
}
