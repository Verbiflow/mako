import { defineConfig } from "oxlint"
import base from "./oxlint.config.ts"

// Only `anti-slop/no-inline-schema-parse`, read by `scripts/check-inline-schemas.mjs` against its baseline: the schemas
// built inside a function and parsed there may only go down in number.
export default defineConfig({
  ignorePatterns: base.ignorePatterns,
  jsPlugins: base.jsPlugins,
  categories: { correctness: "off", suspicious: "off", pedantic: "off", perf: "off", style: "off", restriction: "off", nursery: "off" },
  rules: { "anti-slop/no-inline-schema-parse": "error" },
})
