import { stringValue, type JsonValue } from "./codex-app-json.js"
import { scrubSecrets } from "./host-log.js"

const SECRET_FIELD = /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|credentials|apikey|accesstoken|refreshtoken|idtoken|authtoken|oauthtoken|clientsecret|secretaccesskey|sessiontoken|token|secret)$/

/** Preserve native JSON structure while removing known credential fields.
 * Arbitrary conversation content remains private; this is not a public-export sanitizer. */
export function nativeDiagnosticJson(value: JsonValue): string {
  return JSON.stringify(value, (key, item: JsonValue | undefined) => {
    if (item === undefined) return item
    const normalized = key.toLowerCase().replace(/[_-]/g, "")
    if (SECRET_FIELD.test(normalized) || /^(?:anthropic|openai|xai|aws|azure|google|github|gh).*(?:apikey|token|secret|password)$/.test(normalized))
      return "[redacted]"
    const text = stringValue(item)
    return text === undefined ? item : scrubSecrets(text)
  })
}
