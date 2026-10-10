import type { NativeAuthoringDocument } from "@mako/host/contracts/native-authoring"

/** The existing shared editor owns writes; adapters declare where they apply. */
export interface ProviderEditingCapability {
  provider: string
  route: "mcp-registry" | "skill-registry"
  operations: readonly ("import" | "remove")[]
}

/** A native authoring integration must implement discovery and mutation together. */
export interface ProviderAuthoringCapability {
  provider: string
  /** Native reload timing and scope, shown before authoring. */
  detail: string
  list(cwd: string): Promise<{ id: string; name: string }[]>
  read(cwd: string, id: string): Promise<NativeAuthoringDocument>
  write(cwd: string, id: string, contents: string, revision: string | null): Promise<NativeAuthoringDocument>
  remove(cwd: string, id: string, revision: string): Promise<void>
}
