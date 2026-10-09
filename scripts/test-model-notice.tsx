import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import type { HarnessProfile } from "../src/lib/types"
import { ModelChoiceNotice } from "../src/components/composer/model-notice"
import { modelNoticeText } from "../src/lib/model-notice"
import { composerSettingsInput, replaceUnusableModel } from "../src/state/composer-settings"
import { prefsStore, setPref } from "../src/state/prefs"
import { providerProfileKey, providerStore } from "../src/state/providers"
import { threadsStore } from "../src/state/threads"

/**
 * A model chosen for the next message that can't start is explained above
 * the composer, with the model it was covering one click away.
 */

const refusal = "This version of Claude Code doesn't support it yet. Update Claude Code to use it."
const profile: HarnessProfile = {
  id: "claude",
  label: "Claude Code",
  available: true,
  transport: "sdk",
  models: [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", options: [] },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", options: [], unavailable: refusal },
  ],
  settings: { model: "claude-opus-5-5" },
}
const target = { kind: "new", harness: "claude", cwd: "" } as const
providerStore.set({ profiles: { claude: profile }, contexts: { [providerProfileKey("claude", "")]: profile } })
threadsStore.set({ composerHarness: "claude", viewing: null, opening: null })

assert.equal(renderToStaticMarkup(<ModelChoiceNotice />), "", "silent while the choice can start")

setPref("providerSettings", { claude: { source: "saved", settings: { model: "claude-opus-4-6" } } })
const gone = renderToStaticMarkup(<ModelChoiceNotice />)
assert.match(gone, /data-model-notice="saved"/)
assert.match(gone, /Claude Code doesn&#x27;t offer your default model, claude-opus-4-6, anymore\./)
assert.match(gone, />Use Claude Opus 5\.5</)
replaceUnusableModel(target, issueOf())
assert.equal(prefsStore.get().providerSettings.claude, undefined, "a saved default that can't start goes back to Mako's")
assert.equal(renderToStaticMarkup(<ModelChoiceNotice />), "")

setPref("settingsOverrides", { [JSON.stringify(["claude", "new", ""])]: { model: "claude-sonnet-5-5" } })
const issue = issueOf()
assert.equal(issue.source, "override")
const refused = renderToStaticMarkup(<ModelChoiceNotice />)
assert.match(refused, /data-model-notice="override"/)
assert.match(refused, /Claude Sonnet 5\.5 can&#x27;t start\. This version of Claude Code doesn&#x27;t support it yet\./)
replaceUnusableModel(target, issue)
assert.equal(composerSettingsInput(target).resolved.settings.model, "claude-opus-5-5", "a choice made here moves to the model it was covering")
assert.equal(renderToStaticMarkup(<ModelChoiceNotice />), "")

assert.equal(
  modelNoticeText({ kind: "model", model: "retired", source: "override", message: "" }, "Grok", []),
  "Grok doesn't offer retired anymore. Choose another model.",
  "with nothing to offer instead, the line says what to do"
)

console.log("model notice: a default or choice that can't start is explained above the composer, with the model it was covering one click away")

function issueOf() {
  const found = composerSettingsInput(target).resolved.issues.find((entry) => entry.kind === "model")
  assert.ok(found?.kind === "model")
  return found
}
