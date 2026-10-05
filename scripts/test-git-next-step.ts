import assert from "node:assert/strict"
import { gitNextStep, type GitStepFacts } from "../src/lib/git-next-step.ts"

const clean: GitStepFacts = {
  ahead: 0,
  behind: 0,
  published: true,
  changed: false,
  operation: null,
  conflicts: false,
  keepEdits: false,
  pushing: false,
  onDefault: false,
  pullBlocked: null,
  pull: null,
  worktree: null,
}
const kinds = (facts: Partial<GitStepFacts>) => {
  const steps = gitNextStep({ ...clean, ...facts })
  return [steps.primary?.kind ?? null, ...steps.more.map((step) => step.kind)]
}

assert.deepEqual(kinds({}), [null], "nothing to do offers nothing")
assert.deepEqual(kinds({ ahead: 2, onDefault: true }), ["push"], "the default branch pushes and opens nothing")
assert.deepEqual(kinds({ ahead: 2 }), ["open-pull", "push"], "a feature branch opens its pull request, with Push behind the chevron")
assert.deepEqual(kinds({ published: false }), ["open-pull", "push"], "an unpublished branch has work too")
assert.deepEqual(kinds({ ahead: 2, pullBlocked: "Sign in" }), ["push", "open-pull"], "without GitHub, Push leads and the menu says why a pull request can't open")
assert.deepEqual(kinds({ ahead: 2, pullBlocked: undefined }), ["push"], "while GitHub is checked, nothing claims it can open one")
assert.deepEqual(kinds({ ahead: 2, behind: 3 }), ["pull"], "incoming commits come before anything goes out")
assert.deepEqual(gitNextStep({ ...clean, ahead: 2, behind: 3 }).primary, { kind: "pull", commits: 3, way: "merge", blocked: null }, "diverged branches merge")
assert.deepEqual(gitNextStep({ ...clean, behind: 3, keepEdits: true }).primary, { kind: "pull", commits: 3, way: "merge_autostash", blocked: null }, "a pull stopped by local edits stashes them next time")
assert.deepEqual(kinds({ operation: "merge", conflicts: true, ahead: 2 }), ["continue", "abort"], "a merge under way comes first")
assert.deepEqual(gitNextStep({ ...clean, operation: "merge", conflicts: true }).primary, { kind: "continue", operation: "merge", blocked: "Resolve and stage every conflicted file first." })
assert.deepEqual(kinds({ pushing: true }), ["push"], "a push holds the button until it settles")

const pull = { number: 7, mergeBlocked: null, failing: [] }
assert.deepEqual(kinds({ pull }), ["view-pull", "merge-pull"], "an open pull request is viewed, and merged from the menu")
assert.deepEqual(kinds({ pull, ahead: 1 }), ["push", "view-pull", "merge-pull"], "new commits push to it first")
assert.deepEqual(kinds({ pull: { ...pull, failing: ["test"] } }), ["view-pull", "merge-pull", "fix-checks"], "failing checks can be handed to the agent")

const worktree = { into: "main", commits: 2, landed: false, mergeBlocked: null, last: undefined }
assert.deepEqual(kinds({ worktree, published: false }), ["land", "open-pull", "push"], "a worktree merges into main first")
assert.deepEqual(kinds({ worktree: { ...worktree, last: "pull" } }), ["open-pull", "land"], "the way this project used last leads")
assert.deepEqual(kinds({ worktree, changed: true, published: false }), ["push"], "changes not committed hold back landing")
assert.deepEqual(kinds({ worktree: { ...worktree, commits: 0 } }), [null])
assert.deepEqual(kinds({ worktree: { ...worktree, landed: true } }), ["remove-worktree"], "once its work is in, the worktree can go")
assert.deepEqual(kinds({ worktree, pull }), ["view-pull", "merge-pull", "land"], "with its pull request open, merging here stays in the menu")
assert.deepEqual(gitNextStep({ ...clean, worktree: { ...worktree, mergeBlocked: "main has edits" } }).primary, { kind: "land", into: "main", blocked: "main has edits" })

console.log("Git next step: one primary per state, from a merge under way to removing a landed worktree")
