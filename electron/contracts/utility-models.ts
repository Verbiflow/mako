export type UtilityProvider =
  "google" | "openai" | "anthropic" | "openai-compatible"

export interface UtilityConnection {
  provider: UtilityProvider
  model: string
  baseUrl?: string
  contextTokens: number
}

export interface UtilityConnectionInput extends UtilityConnection {
  apiKey?: string
}

export interface UtilityProviderInfo {
  id: UtilityProvider
  name: string
  description: string
}

export interface UtilityCredentialInput {
  provider: UtilityProvider
  baseUrl?: string
  apiKey?: string
}

export type UtilityCatalogInput =
  | { source: "catalog"; provider: UtilityProvider; refresh?: boolean }
  | ({ source: "provider" } & UtilityCredentialInput)

export interface UtilityModel {
  id: string
  name: string
  contextTokens?: number
  releaseDate?: string
}

export interface UtilityCatalog {
  source: "catalog" | "provider"
  models: UtilityModel[]
  fetchedAt: number
  stale: boolean
  notice?: string
}

export interface UtilityModelSettings {
  providers: UtilityProviderInfo[]
  connections: UtilityConnection[]
  issues: Array<{ provider: UtilityProvider; message: string }>
  secureStorage: boolean
  /** The connected model that names Threads (`provider/model`); absent while automatic titles are off. */
  titleModel?: string
}

export type CommitAnalysisMode = "fast" | "deep"

export interface CommitGenerationInput {
  mode?: CommitAnalysisMode
  requestId: string
  cwd: string
  prompt?: string
  model?: string
}

export interface CommitGenerationResult {
  message: string
  model: string
  scope: "staged" | "working-tree"
  files: number
  warnings: string[]
  requests: number
}
