/** One package's schema module (`patch-sdk-schemas.mjs`). */
export interface SdkSchemasTarget {
  package: string
  version: string
  /** The build's folder in the package, and the module in it. */
  build: string
  module: string
  exported: RegExp
  whole?: RegExp
  schemas: number
  lazy: number
}
export const SDK_SCHEMAS: SdkSchemasTarget[]
export const SDK_SCHEMAS_MARK: string
export function pristineName(file: string): string
export function lazySchemas(source: string, exported: RegExp, whole?: Set<string>): { text: string; schemas: number; lazy: string[] }
export function patchedModule(root: string, target: SdkSchemasTarget, source: string): string
export function installedPackage(name: string): string | undefined
