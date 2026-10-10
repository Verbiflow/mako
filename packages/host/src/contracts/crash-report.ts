/** A crash as it is recorded on this machine and shown in Settings. */
export type CrashKind =
  | "main-uncaught"
  | "main-rejection"
  | "renderer-error"
  | "renderer-rejection"
  | "renderer-gone"
  | "child-gone"

export interface CrashApp {
  version: string
  electron: string
  chrome: string
  node: string
}

export interface CrashOs {
  platform: string
  arch: string
  release: string
}

export interface CrashReport {
  id: string
  kind: CrashKind
  at: string
  message: string
  stack?: string
  /** Where it came from, when the renderer can say. */
  source?: string
  app: CrashApp
  os: CrashOs
  /** What the app was doing just before. */
  breadcrumbs: string[]
}
