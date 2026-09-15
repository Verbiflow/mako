export type JsonScalar = boolean | number | string | null
export type JsonValue = JsonScalar | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}
