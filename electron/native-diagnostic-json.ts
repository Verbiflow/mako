import { z } from "zod"
import { stringValue, type JsonValue } from "./codex-app-json.js"
import { scrubSecrets } from "./host-log.js"

const SECRET_FIELD = /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|credentials|apikey|accesstoken|refreshtoken|idtoken|authtoken|oauthtoken|clientsecret|secretaccesskey|sessiontoken|token|secret)$/
/** `AXIOM_TOKEN`, `xai_api_key`, `dbPassword`: any name ending in a credential word. */
const SECRET_SUFFIX = /(?:apikey|token|secret|password|passwd|credential|credentials|privatekey)$/
/** Fields whose every value may be a credential: MCP server `env` and `headers`, as a map or `{ name, value }` pairs. */
const VALUES_FIELD = /^(?:env|environment|headers|httpheaders)$/

/** Preserve native JSON structure while removing known credential fields.
 * Arbitrary conversation content remains private; this is not a public-export sanitizer. */
export function nativeDiagnosticJson(value: JsonValue): string {
  return JSON.stringify(value, (key, item: JsonValue | undefined) => {
    if (item === undefined) return item
    const normalized = key.toLowerCase().replace(/[_-]/g, "")
    if (SECRET_FIELD.test(normalized) || SECRET_SUFFIX.test(normalized)) return REDACTED
    if (VALUES_FIELD.test(normalized)) return withoutValues(item)
    const text = stringValue(item)
    return text === undefined ? item : scrubSecrets(text)
  })
}

const Fields = z.record(z.string(), z.json())
const REDACTED = "[redacted]"

function withoutValues(item: JsonValue): JsonValue {
  if (Array.isArray(item))
    return item.map((entry) => {
      const pair = Fields.safeParse(entry)
      return pair.success ? Object.fromEntries(Object.keys(pair.data).map((field) => [field, /^(?:name|key)$/i.test(field) ? pair.data[field]! : REDACTED])) : REDACTED
    })
  const fields = Fields.safeParse(item)
  return fields.success ? Object.fromEntries(Object.keys(fields.data).map((name) => [name, REDACTED])) : REDACTED
}
