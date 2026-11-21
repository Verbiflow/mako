import type { Implementation, ServerCapabilities, Tool } from "@modelcontextprotocol/sdk/types.js"

export interface ComputerManifest { server: Implementation; capabilities: ServerCapabilities; instructions: string | null; tools: Tool[] }
export const COMPUTER_MANIFEST_FILE: string
export function liveComputerManifest(): Promise<ComputerManifest>
export function computerManifestText(manifest: ComputerManifest): string
