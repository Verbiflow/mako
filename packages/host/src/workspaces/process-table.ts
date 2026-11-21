/**
 * The process table as `ps` prints it, and the processes of a run in it. Pure, so the watcher child reads and matches
 * it off the host's thread (`members`) and the host reads it the same way when it must have the whole table.
 */

/** What `ps` is asked for: every process, with when it started, in the C locale. */
export const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,rss=,lstart=,command="] as const

export interface Row {
  pid: number
  ppid: number
  pgid: number
  rssKb: number
  startedMs: number
  command: string
}

/**
 * Windows' table, which has no `ps`: one CIM query of `Win32_Process` through Windows PowerShell, a line a process as
 * `pid|parent|working set KB|started ms|command line`. Windows has no process groups, so each process is its own
 * (`pgid` is its pid) and a run's members are its leader and its descendants by parent; a parent that ended stays its
 * children's parent there, so none is lost to a reparenting.
 */
export const WINDOWS_TABLE_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CreationDate,CommandLine,Name | ForEach-Object {",
  "  if ($_.CreationDate) {",
  "    $line = if ($_.CommandLine) { $_.CommandLine } else { $_.Name }",
  "    [Console]::Out.WriteLine(('{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, [int64]($_.WorkingSetSize / 1024), ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), ($line -replace '[\\r\\n]', ' ')))",
  "  }",
  "}",
].join("\n")

/** `WINDOWS_TABLE_SCRIPT`'s output, as rows. */
export function parseWindowsTable(stdout: string): Row[] {
  const rows: Row[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)\|(\d+)\|(\d+)\|(\d+)\|(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    rows.push({ pid, ppid: Number(match[2]), pgid: pid, rssKb: Number(match[3]), startedMs: Number(match[4]), command: match[5]! })
  }
  return rows
}

/** A run as the table is asked about it: its group's leader and when it started. */
export interface RunLeader {
  pid: number
  startedMs: number
}

/** `ps` output for `PS_ARGS`, as rows. */
export function parseTable(stdout: string): Row[] {
  const rows: Row[] = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*(.*)$/.exec(line)
    if (!match) continue
    const startedMs = Date.parse(match[5]!)
    if (Number.isFinite(startedMs)) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), rssKb: Number(match[4]), startedMs, command: match[6]! })
  }
  return rows
}

/**
 * A process table looked up by pid, group and parent, built once per table: a busy Mac's table is long, and every
 * look asks for each run of every app. `self` is the process that started the runs, never one of theirs.
 */
export class TableIndex {
  private readonly byPid = new Map<number, Row>()
  private readonly byGroup = new Map<number, Row[]>()
  private readonly byParent = new Map<number, Row[]>()

  constructor(rows: readonly Row[], self: number) {
    const add = (map: Map<number, Row[]>, key: number, row: Row) => {
      const known = map.get(key)
      if (known) known.push(row)
      else map.set(key, [row])
    }
    for (const row of rows) {
      this.byPid.set(row.pid, row)
      if (row.pid === self || row.pid <= 1) continue
      add(this.byGroup, row.pgid, row)
      add(this.byParent, row.ppid, row)
    }
  }

  /**
   * A run's group and every descendant that started after it, including ones that started a group of their own;
   * none when its pid now names another process. The system never reuses a pid while a group still carries it.
   */
  members(record: RunLeader): Row[] {
    const leader = this.byPid.get(record.pid)
    if (leader && leader.startedMs !== record.startedMs) return []
    const later = (row: Row) => row.startedMs >= record.startedMs
    const found = new Map((this.byGroup.get(record.pid) ?? []).filter(later).map((row) => [row.pid, row]))
    const queue = [...found.values()]
    for (let at = 0; at < queue.length; at += 1)
      for (const child of this.byParent.get(queue[at]!.pid) ?? [])
        if (later(child) && !found.has(child.pid)) {
          found.set(child.pid, child)
          queue.push(child)
        }
    return [...found.values()]
  }
}

/**
 * Only the rows of `runs`' processes, each once: what a look at running apps needs of a table of every process on the
 * Mac. Matching them to their runs again finds the same processes, since a run's members are its group and their
 * descendants, all of which are kept.
 */
export function membersOnly(rows: readonly Row[], runs: readonly RunLeader[], self: number): Row[] {
  const index = new TableIndex(rows, self)
  const kept = new Map<number, Row>()
  for (const record of runs) for (const row of index.members(record)) kept.set(row.pid, row)
  return [...kept.values()]
}
