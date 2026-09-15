import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js"
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js"
import { z } from "zod"
import { normalizeDriverSchema } from "@mako/control/computer"

const json = z.json()

/** Validator for tool schemas published by the native driver. */
export function driverSchemaValidator(): jsonSchemaValidator {
  const base = new AjvJsonSchemaValidator()
  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const normalized = normalizeDriverSchema(json.parse(schema))
      // SAFETY: `normalized` is the same JSON Schema document the SDK typed as
      // JsonSchemaType, with only `format`, `minimum` and `maximum` members
      // rewritten; the SDK exposes no typed constructor for a rewritten
      // schema. scripts/test-computer-tools.ts checks that the rewritten
      // schema compiles and validates without unknown-format warnings.
      return base.getValidator<T>(normalized as JsonSchemaType)
    },
  }
}
