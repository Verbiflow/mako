import assert from "node:assert/strict"
import {
  MAX_UI_EXTENSIONS,
  MAX_UI_EXTENSION_BYTES,
  uiExtensionName,
  validateUiExtensionWrite,
} from "@mako/host/tools/plugin-policy"

assert.equal(uiExtensionName("../../hello world"), "hello-world")
assert.equal(validateUiExtensionWrite("hello", "export {}", []), "hello")
assert.equal(
  validateUiExtensionWrite(
    "existing",
    "export {}",
    Array.from({ length: MAX_UI_EXTENSIONS }, (_, index) =>
      index === 0 ? "existing" : `extension-${index}`
    )
  ),
  "existing"
)
assert.throws(
  () =>
    validateUiExtensionWrite(
      "new",
      "export {}",
      Array.from(
        { length: MAX_UI_EXTENSIONS },
        (_, index) => `extension-${index}`
      )
    ),
  /at most 64/
)
assert.throws(
  () =>
    validateUiExtensionWrite(
      "large",
      "x".repeat(MAX_UI_EXTENSION_BYTES + 1),
      []
    ),
  /cannot exceed 512 KB/
)
assert.throws(() => validateUiExtensionWrite("..", "export {}", []), /needs a name/)

console.log("Local UI extension policy checks passed")
