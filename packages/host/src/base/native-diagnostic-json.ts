import { z } from "zod"
import { stringValue } from "./json-values.js"
import type { JsonValue } from "../contracts/json.js"
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
    const kept = credentialFree(key, item)
    const text = kept === item ? stringValue(item) : undefined
    return text === undefined ? kept : scrubSecrets(text)
  })
}

function credentialFree(key: string, item: JsonValue | undefined): JsonValue | undefined {
  if (item === undefined) return item
  const normalized = key.toLowerCase().replace(/[_-]/g, "")
  if (SECRET_FIELD.test(normalized) || SECRET_SUFFIX.test(normalized)) return REDACTED
  if (VALUES_FIELD.test(normalized)) return withoutValues(item)
  return item
}

/**
 * Every key `credentialFree` changes, as JSON text writes it: a key whose
 * lowercase letters, `_` and `-` aside, end in one of these words, then `":`.
 * Each `SECRET_FIELD` and `VALUES_FIELD` name ends in one. Matching keys it
 * keeps costs only the replacer.
 */
const CREDENTIAL_KEY = new RegExp(
  `(?:${["apikey", "token", "secret", "password", "passwd", "credential", "credentials", "privatekey", "accesskey", "authorization", "cookie", "env", "environment", "headers"]
    .map((word) => [...word].join("[-_]*"))
    .join("|")})[-_]*":`,
  "iu"
)

/**
 * A frame as JSON with credential fields redacted and every other value
 * whole, the way a stream keeps it: what `JSON.stringify` writes, or
 * undefined where it writes nothing. The replacer runs only for text that
 * names such a field. `Frame` is the message as its harness's SDK or the
 * driver's wire decoder types it, so it's neither copied nor narrowed to
 * `JsonValue` first.
 */
export function nativeStreamJson<Frame>(value: Frame): string | undefined {
  const text = JSON.stringify(value)
  return text === undefined || !CREDENTIAL_KEY.test(text) ? text : credentialFreeJson(value)
}

/** `nativeStreamJson` by the replacer alone, which reads every key. */
export function credentialFreeJson<Frame>(value: Frame): string | undefined {
  return JSON.stringify(value, (key, item: JsonValue | undefined) => credentialFree(key, item))
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
