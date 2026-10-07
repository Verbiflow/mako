export type JsonRpcId = string | number
export type JsonScalar = boolean | number | string | null
export type JsonValue = JsonScalar | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

export function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value
  const half = Math.floor((limit - 32) / 2)
  return `${value.slice(0, half)}\n… output truncated …\n${value.slice(-half)}`
}

export function objectValue(
  value: JsonValue | undefined
): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

export function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

export function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined
}

export function booleanValue(
  value: JsonValue | undefined
): boolean | undefined {
  return isBoolean(value) ? value : undefined
}

export function isJsonObject(
  value: JsonValue | undefined
): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

export function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

export function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

export function isBoolean(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}
