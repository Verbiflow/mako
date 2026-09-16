import assert from "node:assert/strict"
import {
  checkpointTask,
  recallTask,
} from "../dist/program/index.js"

const state = {}
assert.deepEqual(recallTask(state), {
  revision: 0,
  facts: {},
  completed: [],
  pending: [],
})
assert.deepEqual(
  checkpointTask(state, {
    objective: "Audit every settings section",
    location: "Settings > General",
    remember: {
      sections: ["General", "Account"],
      evidence: {
        path: "/tmp/settings.json",
        sha256: "fixture",
      },
    },
    completed: ["Open Settings"],
    pending: ["Open Settings", "Inspect Account"],
  }),
  {
    revision: 1,
    objective: "Audit every settings section",
    location: "Settings > General",
    facts: {
      sections: ["General", "Account"],
      evidence: {
        path: "/tmp/settings.json",
        sha256: "fixture",
      },
    },
    completed: ["Open Settings"],
    pending: ["Inspect Account"],
  }
)
assert.deepEqual(
  checkpointTask(state, {
    location: "Settings > Account",
    remember: { accountStatus: "Signed in" },
    completed: ["Inspect Account"],
  }),
  {
    revision: 2,
    objective: "Audit every settings section",
    location: "Settings > Account",
    facts: {
      sections: ["General", "Account"],
      evidence: {
        path: "/tmp/settings.json",
        sha256: "fixture",
      },
      accountStatus: "Signed in",
    },
    completed: ["Open Settings", "Inspect Account"],
    pending: [],
  }
)
await assert.rejects(
  async () =>
    checkpointTask(state, {
      remember: { oversized: "x".repeat(5_000) },
    }),
  /save large evidence as an artifact/
)

console.log("task state ok")
