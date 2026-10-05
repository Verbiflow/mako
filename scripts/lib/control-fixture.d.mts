import type { ChildProcess } from "node:child_process"

/** The pid of the frontmost application, read from AppKit. */
export function frontmostPid(): Promise<number>

/** Every distinct frontmost pid seen while sampling, with how often it was seen. */
export function sampleFrontmost(intervalMs?: number): { stop(): Promise<Map<number, number>> }

export type FixturePolicy = "prohibited" | "regular"

export function electronFixtureSource(input: {
  title: string
  html: string
  status: string
  userData: string
  policy: FixturePolicy
}): string

export function fixtureHtml(input: { title: string; initial?: string; form?: boolean; visual?: string }): string

/** What the fixture window writes to its status file every 100 ms. */
export interface FixtureStatus {
  pid: number
  argv: string[]
  /** The Proof field's text. */
  input: string
  /** Length of the Proof field's selection. */
  selection: number
  /** The result line's text. */
  value: string
}

export interface ElectronFixture {
  /** Null when started with `start: false`. */
  process: ChildProcess | null
  main: string
  html: string
  status: string
  /** The status file as last written by the window. */
  state(): Promise<FixtureStatus>
  until<T>(check: () => T | Promise<T>, what: string, timeoutMs?: number): Promise<NonNullable<T>>
  started(): Promise<FixtureStatus>
  stop(): void
}

export function startElectronFixture(input: {
  root: string
  name: string
  title: string
  policy?: FixturePolicy
  initial?: string
  form?: boolean
  visual?: string
  start?: boolean
}): Promise<ElectronFixture>
