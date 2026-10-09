import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { resolveSessionSettings, type SessionModel } from "@mako/sessions/settings"
import { workDefault, workDefaultProblems, type HarnessDefaults } from "../electron/contracts/harness-defaults.ts"
import { providerHost } from "../electron/providers/index.ts"
import { MODEL_CATALOG_ROOT, recordedCatalog } from "./model-catalogs.ts"

/**
 * Each harness's default model against its recorded catalog, so a renamed
 * model or a changed option fails here instead of in a session. The
 * catalogs are what Mako discovered (`npm run harness:catalogs`); a failure
 * means the default or the catalog is out of date, and re-recording shows
 * which.
 */

const problems: string[] = []
const loaders = providerHost.profiles.list()
for (const { provider, defaults } of loaders) {
  const catalog = recordedCatalog(provider)
  if (defaults.work.length === 0) {
    if (catalog) problems.push(`${provider}: names no default model, so its recorded catalog holds nothing to account`)
    continue
  }
  if (!catalog) {
    problems.push(`${provider}: has no recorded catalog; run \`npm run harness:catalogs -- --harness ${provider}\``)
    continue
  }
  for (const problem of workDefaultProblems(defaults, catalog.models))
    problems.push(`${provider}: ${problem} (catalog recorded ${catalog.recorded}${catalog.version ? ` from ${catalog.version}` : ""})`)
  const [pick] = defaults.work
  const started = workDefault(defaults, catalog.models)
  if (pick && started && !workDefaultProblems(defaults, catalog.models).length)
    assert.deepEqual(started.options, pick.options ?? {}, `${provider} starts on every option its default names`)
}
const known = new Set(loaders.map(({ provider }) => provider))
for (const file of readdirSync(MODEL_CATALOG_ROOT))
  if (!known.has(file.replace(/\.json$/, ""))) problems.push(`${file}: no installed harness records this catalog`)
assert.deepEqual(problems, [], `default models disagree with their catalogs:\n  ${problems.join("\n  ")}`)

// The check, on catalogs shaped like each failure.
const effort = (values: string[]): SessionModel["options"][number] => ({
  id: "effort", label: "Effort", role: "reasoning", kind: "select", values: values.map((value) => ({ value, label: value })),
})
const model = (id: string, extra: Partial<SessionModel> = {}): SessionModel => ({ id, label: id.toUpperCase(), options: [effort(["low", "high"])], ...extra })
const defaults: HarnessDefaults = { work: [{ model: "next", options: { effort: "high" } }, { model: "prior" }] }

assert.deepEqual(workDefaultProblems(defaults, [model("next"), model("prior")]), [])
assert.deepEqual(workDefaultProblems(defaults, [model("prior")]), ["next isn't in the catalog"], "a renamed model fails")
assert.deepEqual(workDefaultProblems(defaults, [model("next", { options: [effort(["low"])] })]), ["next doesn't accept effort high"])
assert.deepEqual(workDefaultProblems(defaults, [model("next", { options: [] })]), ["next has no effort option"])
assert.deepEqual(
  workDefaultProblems(defaults, [model("next", { unavailable: "Needs an update." }), model("prior")]),
  ["next is listed but can't start: Needs an update."]
)
assert.deepEqual(
  workDefault(defaults, [model("next", { unavailable: "Needs an update." }), model("prior")]),
  { model: "prior", options: {} },
  "a listed model the harness refuses yields to the next pick"
)
assert.deepEqual(workDefaultProblems({ work: [], none: "Its own providers." }, []), [])

// A choice the catalog no longer offers, or the harness refuses, says so instead of sending.
const catalog = [model("current"), model("refused", { unavailable: "This version doesn't support it yet." })]
const provider = { model: "current" }
const gone = resolveSessionSettings({ models: catalog, context: "new", preference: { source: "saved", settings: { model: "retired" } }, defaults: provider })
assert.deepEqual(gone.issues, [{ kind: "model", model: "retired", source: "saved", message: "retired isn't offered anymore. Choose another model.", instead: "current" }])
const refused = resolveSessionSettings({ models: catalog, context: "new", overrides: { model: "refused" }, defaults: provider })
assert.deepEqual(refused.issues, [{ kind: "model", model: "refused", source: "override", message: "REFUSED can't start. This version doesn't support it yet.", instead: "current" }])
const nothingElse = resolveSessionSettings({ models: catalog, context: "new", overrides: { model: "retired" } })
assert.deepEqual(nothingElse.issues, [{ kind: "model", model: "retired", source: "override", message: "retired isn't offered anymore. Choose another model." }], "with no other choice there is nothing to offer instead")
const running = resolveSessionSettings({ models: catalog, context: "existing", session: { model: "retired" } })
assert.deepEqual(running.issues, [], "a session's own model is what the harness reported")
const unread = resolveSessionSettings({ models: [], context: "new", preference: { source: "saved", settings: { model: "retired" } } })
assert.deepEqual(unread.issues, [], "a catalog not read yet says nothing about a choice")
const ok = resolveSessionSettings({ models: catalog, context: "new", preference: { source: "saved", settings: { model: "current" } } })
assert.deepEqual(ok.issues, [])

console.log(`model defaults: ${loaders.filter(({ defaults }) => defaults.work.length).length} harness defaults are offered by their recorded catalogs; renamed, refused and unaccepted choices are explained`)
