import { z } from "zod"

export const NativeAuthoringFamilySchema = z.enum(["hooks", "commands"])
export type NativeAuthoringFamily = z.infer<typeof NativeAuthoringFamilySchema>
export interface NativeAuthoringTarget {
  provider: string
  family: NativeAuthoringFamily
  cwd: string
}
export interface NativeAuthoringDocument {
  id: string
  name: string
  path: string
  contents: string
  revision: string | null
}
export interface NativeAuthoringAvailability {
  provider: string
  family: NativeAuthoringFamily
  label: string
  supported: boolean
  detail: string
}
export interface NativeAuthoringCatalog {
  cwd: string
  capabilities: NativeAuthoringAvailability[]
}
export interface NativeAuthoringWrite extends NativeAuthoringTarget {
  id: string
  contents: string
  revision: string | null
}
export interface NativeAuthoringRemove extends NativeAuthoringTarget {
  id: string
  revision: string
}
