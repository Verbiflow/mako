export type JsonValue = boolean | number | string | null | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }
