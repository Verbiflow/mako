export type TerminalSessionStatus = "running" | "exited" | "interrupted"

export interface TerminalSession {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  status: TerminalSessionStatus
  cols: number
  rows: number
  sequence: number
  exitCode?: number
}

export interface TerminalSnapshot {
  session: TerminalSession
  data: string
  sequence: number
}

export type TerminalEvent =
  | { type: "connection"; state: "connecting" | "ready" | "disconnected"; error?: string }
  | { type: "wake" }
  | { type: "snapshot"; snapshot: TerminalSnapshot }
  | { type: "output"; sessionId: string; sequence: number; data: string }
  | { type: "status"; session: TerminalSession }
  | { type: "removed"; sessionId: string }

export interface TerminalCreateOptions {
  cwd: string
  title?: string
  cols: number
  rows: number
}
