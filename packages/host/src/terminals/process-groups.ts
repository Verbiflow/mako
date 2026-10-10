import { execFileSync } from "node:child_process"
import { z } from "zod"

const PROCESS_TABLE_TIMEOUT_MS = 1_000
const PROCESS_TABLE_MAX_BYTES = 1024 * 1024
const errnoSchema = z.object({ code: z.string() })

interface ProcessRow {
  pid: number
  pgid: number
  tty: string
}

function runPs(args: string[]): string {
  return execFileSync("ps", args, {
    encoding: "utf8",
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    maxBuffer: PROCESS_TABLE_MAX_BYTES,
  })
}

function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const pgid = Number(match[2])
    const tty = match[3]
    if (pid > 0 && pgid > 1 && tty) rows.push({ pid, pgid, tty })
  }
  return rows
}

export function processGroupsForTerminal(
  output: string,
  rootPid: number,
  currentPid = process.pid
): number[] | null {
  const rows = parseProcessRows(output)
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || root.tty === "?" || root.tty === "??") return null
  if (rows.some((row) => row.pid === currentPid && row.tty === root.tty)) {
    return null
  }
  const groups = new Set(
    rows.filter((row) => row.tty === root.tty).map((row) => row.pgid)
  )
  if (!groups.has(root.pgid)) return null
  return [...groups].sort((left, right) => {
    if (left === root.pgid) return 1
    if (right === root.pgid) return -1
    return left - right
  })
}

function processTableForTerminal(rootPid: number): string {
  const root = runPs(["-p", String(rootPid), "-o", "pid=,pgid=,tty="])
  const rootRow = parseProcessRows(root).find((row) => row.pid === rootPid)
  if (!rootRow || rootRow.tty === "?" || rootRow.tty === "??") return root
  return `${root}\n${runPs(["-t", rootRow.tty, "-o", "pid=,pgid=,tty="])}`
}

export function killTerminalProcessGroups(
  rootPid: number,
  fallback: () => void
): void {
  if (process.platform === "win32") {
    fallback()
    return
  }
  let groups: number[] | null
  try {
    groups = processGroupsForTerminal(
      processTableForTerminal(rootPid),
      rootPid
    )
  } catch {
    groups = null
  }
  if (!groups || groups.length === 0) {
    fallback()
    return
  }
  let firstError: Error | undefined
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL")
    } catch (error) {
      const parsed = errnoSchema.safeParse(error)
      if ((!parsed.success || parsed.data.code !== "ESRCH") && !firstError) {
        firstError = error instanceof Error ? error : new Error(String(error))
      }
    }
  }
  if (firstError) throw firstError
}
