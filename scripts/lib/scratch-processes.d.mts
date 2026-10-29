export interface ScratchProcess {
  pid: number
  args: string
}

export function processesUsingSync(folder: string): ScratchProcess[]
export function processesLeftIn(folder: string, timeoutMs?: number): Promise<ScratchProcess[]>
export function describeProcesses(processes: readonly ScratchProcess[]): string
export function removeScratch(folder: string, timeoutMs?: number): Promise<void>
export function removeScratchSync(folder: string): void
