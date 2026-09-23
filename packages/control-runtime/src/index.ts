import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { BrowserService } from "./browser-service.js"
import type { LocalBrowser } from "./browser-discovery.js"
import { createControlSession } from "./control-session.js"
import type { ComputerDriverProcess } from "./computer-driver-client.js"
import type { BrowserCall } from "./browser-tools-runtime.js"

export type { ControlSession } from "./control-session.js"
export type { LocalBrowser } from "./browser-discovery.js"
export type { ComputerDriverProcess } from "./computer-driver-client.js"

export interface ControlRuntimeOptions {
  /** Absolute program-result artifact directory. Files survive close(). */
  artifacts: string
  /** Explicit targets only. Discovery and connection remain separate operations. */
  browsers?: LocalBrowser[]
  /** Optional external native driver; started lazily on the first native call. */
  native?: ComputerDriverProcess
}

/** Owns one task, its connections and program worker. No desktop discovery. */
export function createControlRuntime(options: ControlRuntimeOptions) {
  if (!isAbsolute(options.artifacts))
    throw new Error("Control runtime artifacts must be an absolute directory")
  const owner = randomUUID()
  const browsers = new BrowserService(options.browsers ?? [])
  const browserCall: BrowserCall = Object.assign(
    (command: Parameters<BrowserCall>[0], signal: AbortSignal) =>
      browsers.execute(owner, command, signal),
    {
      async close() {
        try { await browsers.releaseOwner(owner, { finalizeRecordings: true }) }
        finally { browsers.close() }
      },
    }
  )
  return createControlSession(options.native, owner, undefined, {
    browserCall,
    artifacts: options.artifacts,
    previewEnvironment: {},
  })
}
