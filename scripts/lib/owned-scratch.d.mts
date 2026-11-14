export function ownedScratch(prefix: string, options?: { root?: string; keep?: boolean }): {
  path: string
  dispose(): Promise<void>
}
