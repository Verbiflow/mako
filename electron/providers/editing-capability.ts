import type { ProviderCapability } from "./registry.js"
import type { NativeAuthoringDocument } from "../contracts/native-authoring.js"

/** The existing shared editor owns writes; adapters declare where they apply. */
export interface ProviderEditingCapability extends ProviderCapability {
  route: "mcp-registry" | "skill-registry"
  operations: readonly ("import" | "remove")[]
}

/** A native authoring integration must implement discovery and mutation together. */
export interface ProviderAuthoringCapability extends ProviderCapability {
  /** Native reload timing and scope, shown before authoring. */
  detail: string
  list(cwd: string): Promise<{ id: string; name: string }[]>
  read(cwd: string, id: string): Promise<NativeAuthoringDocument>
  write(cwd: string, id: string, contents: string, revision: string | null): Promise<NativeAuthoringDocument>
  remove(cwd: string, id: string, revision: string): Promise<void>
}
