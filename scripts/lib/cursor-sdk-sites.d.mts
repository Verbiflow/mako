import type { CursorSdkPatch, InstalledPatch } from "../patch-cursor-sdk.mjs"

export const sdkRoot: string
export const sdkVersion: string
export function readSdk(target: string): string
export function sdkFiles(build: string): string[]
export function findInBuild(build: string, literal: string, what?: string): { target: string; source: string; index: number; length: number; names: Map<string, string> }
export function throughBlock(source: string, index: number): string
/** A vm context answering what `given` names, then the process's globals, then `stub` for any other name. */
export function bundleContext<T extends object, Stub>(given: T, stub: Stub): T
export function unpatched(build: string, id: string): string
export const CURSOR_SDK_PATCHES: CursorSdkPatch[]
export function installedPatch(read: (target: string) => string, files: (build: string) => string[], id: string, build: string): InstalledPatch
/** `text` with each of the bundler's names in `names` replaced (1.4.0's to this release's). */
export function rename(text: string, names: Map<string, string>): string
