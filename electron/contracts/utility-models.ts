import type { UtilityWorkSettings } from "./utility-work.js"

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
  /** Which model does each small task, and what could. */
  work?: UtilityWorkSettings
}

export type CommitAnalysisMode = "fast" | "deep"

export interface CommitGenerationInput {
  mode?: CommitAnalysisMode
  requestId: string
  cwd: string
  prompt?: string
  /** `auto`, or a model id from `UtilityWorkSettings`; without one, the saved choice. */
  model?: string
}

export interface CommitGenerationResult {
  message: string
  model: string
  /** The model and who ran it, as a person reads them. */
  modelLabel: string
  scope: "staged" | "working-tree"
  files: number
  warnings: string[]
  requests: number
}

/** A title and description for the commits this branch has beyond `base`. */
export interface PullRequestDraftInput {
  mode?: CommitAnalysisMode
  requestId: string
  cwd: string
  /** The branch the pull request merges into, as GitHub names it. */
  base: string
  /** `auto`, or a model id from `UtilityWorkSettings`; without one, the saved choice. */
  model?: string
}

export interface PullRequestDraftResult {
  title: string
  body: string
  model: string
  modelLabel: string
  commits: number
  files: number
  warnings: string[]
  requests: number
}
