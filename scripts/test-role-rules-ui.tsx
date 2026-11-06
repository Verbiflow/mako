import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { ORCHESTRATION_INSTRUCTIONS } from "@mako/host/contracts/agent-tools"
import { finPolicyNote, roleRuleLines, roleRulesPreview, type FinChoicesReading, type FinPolicy, type FinTarget, type RoleRules } from "@mako/host/contracts/fin-tuning"
import { RoleRules as RoleRulesFields } from "../src/components/settings/role-rules"
import { FIELD } from "../src/components/ui/kit"
import { loadFinDefaults, saveRoleRules } from "../src/state/fin-defaults"
import { RoleRulesGroups } from "../src/web-client/fins"

/**
 * Settings › Fins' two fields for the person's standing rules, on the desk (`role-rules.tsx`) and the phone
 * (`web-client/fins.tsx`), rendered from a fixture reading without a window: each titled, with one line under the
 * title, the kit's raised field and an example placeholder, and a toggle named for what an agent reads; what it shows
 * is only what the rules add, built by the host's own functions; and a save sends one role's words alone.
 * `test-role-rules-window.mjs` types, cancels and opens them in a window.
 */
const policy: FinPolicy = {
  rules: [{ id: "a", when: "UI and CSS", target: { harness: "claude" } }],
  forFins: "Run the tests you touch before you report.",
  forApexes: "Ask me before starting more than four Fins.",
}
const reading: FinChoicesReading = { chosen: {}, used: {}, policy, moveOnLimit: true }
const sent: unknown[][] = []
Object.assign(globalThis, {
  window: {
    mako: {
      finDefaults: async () => reading,
      saveRoleRules: async (role: RoleRules, text: string) => {
        sent.push([role, text])
        return { ...reading, policy: { ...policy, [role]: text } }
      },
      saveFinPolicy: async () => assert.fail("a role's words are never saved by resending the whole policy"),
    },
  },
})
await loadFinDefaults()
const target = (each: FinTarget) => `${each.harness}, on the model the person uses there`
const textOf = (markup: string) => markup.replace(/<textarea[^>]*>[^<]*<\/textarea>/g, "").replace(/<[^>]+>/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean)

// ── What the rules add, as every device previews it: the role's line, and an Apex's model rules; never Mako's own paragraph.
{
  assert.deepEqual(roleRulesPreview("forFins", policy, target), [roleRuleLines(policy, { fin: true, apex: false, read: new Set() })["fin-rules"]])
  assert.deepEqual(roleRulesPreview("forApexes", policy, target), [roleRuleLines(policy, { fin: false, apex: true, read: new Set() })["apex-rules"], ...finPolicyNote(policy, target)])
  assert.ok(!roleRulesPreview("forApexes", policy, target).join("\n").includes(ORCHESTRATION_INSTRUCTIONS.slice(0, 40)), "Mako's own instructions aren't the person's rules")
  assert.deepEqual(roleRulesPreview("forFins", { rules: [] }, target), [], "nothing to add, nothing shown")
}

// ── The desk.
{
  const markup = renderToStaticMarkup(<RoleRulesFields target={target} />)
  assert.deepEqual(textOf(markup), [
    "For every Fin", "Your own words, which every Fin reads before it starts.", "What every Fin reads",
    "For every Apex", "Your own words, which every Apex reads before it starts a Fin.", "What every Apex reads",
  ], "each field titled, one line under its title, and a toggle named for what an agent reads")
  for (const role of ["forFins", "forApexes"]) {
    const field = new RegExp(`<textarea id="role-rules-${role}"[^>]*class="([^"]*)"`).exec(markup)?.[1]
    assert.ok(field, `${role} renders its field`)
    for (const kit of FIELD.split(" ").filter((name) => name !== "h-8")) assert.ok(field.split(" ").includes(kit), `the kit's field: ${kit}`)
    assert.ok(!/bg-shell|focus:bg-/.test(field), "not the sunken tone, nor a focus that changes the background")
  }
  assert.match(markup, /placeholder="Run the tests you touch before you report"[^>]*>Run the tests you touch before you report\.<\/textarea>/)
  assert.equal(markup.match(/aria-expanded="false"/g)?.length, 2, "each toggle starts closed")
}

// ── The phone: the same two rules, the same lines and toggles, in its touch layout.
{
  const saves: unknown[][] = []
  const markup = renderToStaticMarkup(<RoleRulesGroups policy={policy} target={target} onSave={(role, text) => saves.push([role, text])} />)
  assert.deepEqual(textOf(markup), [
    "For every Fin", "What every Fin reads", "Your own words, which every Fin reads before it starts.",
    "For every Apex", "What every Apex reads", "Your own words, which every Apex reads before it starts a Fin.",
  ], "each group titled, its toggle, and the same line under it")
  assert.match(markup, /<textarea aria-label="For every Fin" data-role-rules="forFins"[^>]*placeholder="Run the tests you touch before you report"[^>]*>Run the tests you touch before you report\.<\/textarea>/)
  assert.match(markup, /<textarea aria-label="For every Apex" data-role-rules="forApexes"[^>]*>Ask me before starting more than four Fins\.<\/textarea>/)
  const bare = renderToStaticMarkup(<RoleRulesGroups policy={{ rules: [] }} target={target} onSave={() => {}} />)
  assert.ok(!bare.includes("reads</span>"), "with nothing to add, no toggle")
}

await saveRoleRules("forFins", "Write a test for every fix.")
assert.deepEqual(sent, [["forFins", "Write a test for every fix."]], "the desk saves one role's words, alone")

console.log("role rules UI: the kit's field with a line under each title, previews of only what the rules add, and the same on the phone")
