import assert from "node:assert/strict"

/** Read only our closed diagnostic field set, never provider output or secrets. */
export function launchEvidence(log, conversation) {
  return log.split("\n").filter(line => line.includes("provider-startup phase "))
    .map(line => Object.fromEntries([...line.matchAll(/\b(provider|conversation|attempt|step|phase|elapsedMs|durationMs|state)=([^\s]+)/g)]
      .map(([, key, value]) => [key, ["step", "elapsedMs", "durationMs"].includes(key) ? Number(value) : value])))
    .filter(record => record.conversation === conversation)
}

export function verifyLaunchEvidence(records) {
  assert.ok(records.length > 0, "the real driver must record its launch")
  assert.equal(new Set(records.map(record => record.attempt)).size, 1)
  assert.equal(records[0].phase, "launch")
  assert.equal(records[0].state, "started")
  assert.equal(records.at(-1).phase, "launch")
  assert.equal(records.at(-1).state, "done")
  for (const phase of ["account", "spawn", "mcp-preparation"])
    assert.ok(records.some(record => record.phase === phase && record.state === "done"), `missing ${phase} evidence`)
  assert.ok(records.some(record => ["session-open", "sdk-initialization"].includes(record.phase) && record.state === "done"), "native open/initialization evidence is required")
  for (const start of records.filter(record => ["started", "waiting"].includes(record.state))) {
    const end = records.filter(record => record.step === start.step && ["done", "failed"].includes(record.state))
    assert.equal(end.length, 1, `step ${start.step} must settle once`)
    assert.ok(end[0].elapsedMs >= start.elapsedMs)
    assert.ok(end[0].durationMs >= 0)
  }
}
