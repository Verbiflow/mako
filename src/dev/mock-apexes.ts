import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { checkPlanItem, ruleParts, RULES_BUDGET_CHARS, type ApexEntry, type ApexRulesReading, type Memory, type PersonLayers, type RuleLayer } from "@mako/host/contracts/apexes"
import type { MakoBridge } from "@mako/host/contracts/renderer-bridge"
import { APEX_CONVERSATION, APEX_CWD, APEX_THREAD, APEX_TITLE } from "./mock-apex-thread"

/**
 * The deliberate Apexes of the mock desk (`?mock&app=apex`): the scene's Apex made one on purpose, with a purpose, a
 * plan in the six sections, its rules and its Fins' rules, and the person's layers for its folder; `&apexes=none`
 * leaves it an Apex only by its Fins, and `&apex=new` is one made a moment ago, its plan still empty.
 */
const SEARCH = new URLSearchParams(globalThis.location?.search)
const SCENE = SEARCH.get("app") === "apex" && SEARCH.get("apexes") !== "none"
const NEW = SEARCH.get("apex") === "new"

const PLAN = `# ${APEX_TITLE}

The phone and iPad polish pass before 0.9: the quiet-hours notice, the iPad sheet, chips and dictation.

## Now

- [ ] fin:composer-chips wrap the composer's chips on an iPad, then the phone case
- [ ] fin:dictation fall back to the keyboard's dictation without an error
- [ ] fin:outbox retry the outbox once the page is back online
- [x] fin:swipe swipe to archive springs back below its threshold

## Waiting on you

- [ ] Merge word for you/mako#371 once the phone case is green
- [ ] Pick the TestFlight group for the 0.9 build

## Blocked

- [ ] fin:sheet-motion waits on npm ci's approval

## Decided

- [x] Pull to refresh reads the account list again, never a cache
- [x] One Fin per surface, never two on the composer

## Files

- docs/phone-polish.md, the before and after shots
- reports/sheet-motion.md

## Revisit

- The haptics audit once the share sheet copy lands
`

const NEW_PLAN = `# ${APEX_TITLE}

## Now

## Waiting on you

## Blocked

## Decided

## Files

## Revisit
`

export function mockApexes(emit: (event: HostEvent) => void): Pick<MakoBridge, "apexes" | "createApex" | "promoteApex" | "updateApex" | "demoteApex" | "gatherIntoApex" | "apexSeen" | "apexPlan" | "saveApexPlan" | "checkApexPlan" | "apexRules" | "saveRuleLayer" | "ruleLayers" | "forgetMemory"> {
  const now = Date.now()
  let apexes: ApexEntry[] = SCENE
    ? [{
        thread: APEX_THREAD,
        name: APEX_TITLE,
        purpose: NEW ? undefined : "Phone and iPad polish before 0.9: notices, sheets, chips, dictation",
        createdAt: now - 3 * 86_400_000,
        from: "new",
        by: "person",
        seenAt: now - 40 * 60_000,
        handle: "mako-7f3k",
        conversation: APEX_CONVERSATION,
        folder: APEX_CWD,
        harness: "claude",
      }]
    : []
  const plans = new Map<string, string>(SCENE ? [[APEX_THREAD, NEW ? NEW_PLAN : PLAN]] : [])
  const own = new Map<string, { apex?: string; "apex-fins"?: string }>(SCENE && !NEW ? [[APEX_THREAD, {
    apex: "Report pull requests and blockers, nothing else. Never merge without my word. Run the phone and iPad cases before you call anything done.",
    "apex-fins": "Open pull requests as drafts. End with: what changed, the PR, what you need from Mobile polish, and the shots.",
  }]] : [])
  let layers: PersonLayers = {
    you: "Sentence case everywhere. No emoji in copy.",
    youFolder: "",
    folder: "npm run lint before every push. UI runs go under the browser lock.",
    memories: SCENE ? [
      { id: "m1", scope: "folder", folder: APEX_CWD, topic: "phone cases", lesson: "Run npm run test:phone before a PR that touches the web client.", savedAt: now - 2 * 86_400_000, confirmedAt: now - 3_600_000 },
      { id: "m2", scope: "you", topic: "reports", lesson: "Lead with the decision, then the options.", savedAt: now - 5 * 86_400_000, confirmedAt: now - 86_400_000 },
    ] satisfies Memory[] : [],
  }
  const tell = () => emit({ type: "apexes", apexes })
  const reading = (thread: string, as: "apex" | "fin"): ApexRulesReading => {
    const apex = apexes.find((each) => each.thread === thread)
    const kept = own.get(thread) ?? {}
    const parts = ruleParts({
      ...(layers.you && { you: layers.you }),
      ...(layers.youFolder && { youFolder: layers.youFolder }),
      ...(layers.folder && { folder: layers.folder }),
      folderName: "mako",
      memories: layers.memories,
      apex: { name: apex?.name ?? APEX_TITLE, ...(kept.apex && { rules: kept.apex }), ...(kept["apex-fins"] && { finRules: kept["apex-fins"] }) },
      as,
    })
    return { as, parts, budget: RULES_BUDGET_CHARS, texts: { you: layers.you, "you-folder": layers.youFolder, folder: layers.folder, apex: kept.apex ?? "", "apex-fins": kept["apex-fins"] ?? "" }, folder: APEX_CWD, folderName: "mako", memories: layers.memories }
  }
  return {
    apexes: async () => apexes,
    createApex: async (input) => {
      const thread = crypto.randomUUID()
      const conversation = crypto.randomUUID()
      apexes = [...apexes, { thread, name: input.name, ...(input.purpose && { purpose: input.purpose }), createdAt: Date.now(), from: "new", by: "person", handle: `mako-${thread.slice(0, 4)}`, conversation, folder: input.cwd, harness: input.harness }]
      plans.set(thread, NEW_PLAN.replace(APEX_TITLE, input.name))
      tell()
      return { thread, conversation, name: input.name }
    },
    promoteApex: async (conversation, change) => {
      const thread = conversation === APEX_CONVERSATION ? APEX_THREAD : crypto.randomUUID()
      const entry: ApexEntry = { thread, name: change.name ?? "Apex", ...(change.purpose && { purpose: change.purpose }), createdAt: Date.now(), from: "thread", by: "person", handle: `mako-${thread.slice(0, 4)}`, conversation, folder: APEX_CWD }
      apexes = [...apexes.filter((apex) => apex.thread !== thread), entry]
      tell()
      return { apex: entry }
    },
    updateApex: async (thread, change) => {
      const before = apexes.find((apex) => apex.thread === thread)
      if (!before) return { refused: "not-apex", why: "That Thread isn't a deliberate Apex." }
      const next: ApexEntry = { ...before, ...(change.name && { name: change.name }) }
      if (change.purpose === null) delete next.purpose
      else if (change.purpose !== undefined) next.purpose = change.purpose
      apexes = apexes.map((apex) => (apex.thread === thread ? next : apex))
      tell()
      return { apex: next }
    },
    demoteApex: async (thread) => {
      apexes = apexes.filter((apex) => apex.thread !== thread)
      tell()
      return { released: [] }
    },
    gatherIntoApex: async (_apex, threads, confirm) => ({
      moved: confirm ? threads.map((thread) => ({ thread, title: "Moved Thread", name: "moved" })) : [],
      stayed: confirm ? [] : threads.map((thread) => ({ thread, title: "Refresh icons", refused: "access-wider" as const, why: `“Refresh icons” runs on Full access, more than ${APEX_TITLE}'s Auto. Moving it in lowers it to Auto.`, confirmable: true as const })),
    }),
    apexSeen: async (thread) => {
      apexes = apexes.map((apex) => (apex.thread === thread ? { ...apex, seenAt: Date.now() } : apex))
      tell()
    },
    apexPlan: async (thread) => {
      const text = plans.get(thread) ?? ""
      return { text, chars: text.length }
    },
    saveApexPlan: async (thread, text) => {
      plans.set(thread, text)
      emit({ type: "apex-plan", thread, plan: text })
      return { text, chars: text.length }
    },
    checkApexPlan: async (thread, section, item, done) => {
      const next = checkPlanItem(plans.get(thread) ?? "", section, item, done)
      if (next === undefined) return { refused: "invalid", why: `${section} has no item ${item}.` }
      plans.set(thread, next)
      emit({ type: "apex-plan", thread, plan: next })
      return { text: next, chars: next.length }
    },
    apexRules: async (thread, as) => reading(thread, as),
    saveRuleLayer: async (layer: RuleLayer, text, at) => {
      if ((layer === "apex" || layer === "apex-fins") && at.thread) own.set(at.thread, { ...own.get(at.thread), [layer]: text })
      else if (layer === "you") layers = { ...layers, you: text }
      else if (layer === "you-folder") layers = { ...layers, youFolder: text }
      else if (layer === "folder") layers = { ...layers, folder: text }
      emit({ type: "apex-rules", ...(at.thread && { thread: at.thread }) })
      return { chars: text.length }
    },
    ruleLayers: async () => layers,
    forgetMemory: async (id) => {
      layers = { ...layers, memories: layers.memories.filter((memory) => memory.id !== id) }
      emit({ type: "apex-rules" })
      return true
    },
  }
}
