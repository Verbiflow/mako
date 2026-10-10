/** A value JSON can carry, as it arrives: parsed, not yet read as anything. */
export type JsonScalar = boolean | number | string | null
export type JsonValue = JsonScalar | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}
