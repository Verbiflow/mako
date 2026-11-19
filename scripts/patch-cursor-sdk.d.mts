export interface CursorSdkSite {
  from: string
  to: string
  binds?: string[]
  label: string
}
export interface CursorSdkPatch {
  id: string
  build: "esm" | "cjs"
  change: string
  /** Where the patch was in the release its anchors were written against. */
  target: string
  sites: CursorSdkSite[]
}
export interface InstalledPatch {
  file: string
  source: string
  /** Each site where the installed SDK has it, with 1.4.0's names mapped to this release's. */
  sites: (CursorSdkSite & { index: number; length: number; names: Map<string, string> })[]
}
export const CURSOR_SDK_ANCHORED_ON: string
export const CURSOR_SDK_PATCHES: CursorSdkPatch[]
export function folderFiles(root: string): (build: string) => string[]
export function installedPatch(read: (target: string) => string, files: (build: string) => string[], id: string, build: string): InstalledPatch
