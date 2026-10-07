import type { LiveSnapshot } from "../electron/contracts/live-conversations.js"
import type { randomUUID } from "node:crypto"

export function auditId(index: number): ReturnType<typeof randomUUID> {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
}

export function auditSnapshot(
  turns: number,
  harness = "fixture",
  answerChars = 1024,
  toolChars = 2048
): LiveSnapshot {
  const snapshot: LiveSnapshot = {
    session: {
      id: auditId(0),
      harness,
      nativeId: "fixture-native",
      cwd: "/performance-fixture",
      title: "Performance fixture",
      status: "running",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    revision: 1,
    createdAt: 1,
    base: null,
    blocks: [],
    requests: [],
    permissions: [],
  }
  for (let turn = 0; turn < turns; turn++) {
    const requestId = auditId(turn + 1)
    snapshot.requests.push({
      id: requestId,
      text: `Inspect file ${turn}.`,
      attachments: [],
      status: turn === turns - 1 ? "dispatching" : "completed",
    })
    snapshot.blocks.push(
      { type: "user", text: `Inspect file ${turn}.`, requestId },
      {
        type: "tool",
        id: `tool-${turn}`,
        title: "Read",
        toolKind: "read",
        status: "completed",
        input: JSON.stringify({ path: `src/file-${turn % 128}.ts` }),
        output: `Fixture output ${turn}\n${"line of output\n".repeat(Math.ceil(toolChars / 15)).slice(0, toolChars)}`,
      },
      {
        type: "text",
        id: `text-${turn}`,
        text: `## Finding ${turn}\n\n${"The implementation preserves identity and clear interaction feedback. ".repeat(Math.ceil(answerChars / 68)).slice(0, answerChars)}`,
      }
    )
  }
  return snapshot
}

/**
 * A conversation shaped like a long agent session rather than a chat: few
 * prompts, each answered by hundreds of tool calls and thinking blocks. Mako's
 * own longest conversations look like this (43 prompts, 12k blocks, 6k tool
 * calls averaging 2.5 KB, turns of 900 blocks with 120 answers), and
 * windowing by turn alone mounts all of it.
 */
export function auditAgentSession(
  turns: number,
  stepsPerTurn: number,
  conversation = 0,
  status: LiveSnapshot["session"]["status"] = "running"
): LiveSnapshot {
  const snapshot = auditSnapshot(0, "cursor")
  snapshot.session = { ...snapshot.session, id: auditId(conversation), nativeId: `fixture-native-${conversation}`, status }
  for (let turn = 0; turn < turns; turn++) {
    const requestId = auditId(turn + 1)
    snapshot.requests.push({
      id: requestId,
      text: `Continue the refactor, step ${turn}.`,
      attachments: [],
      status: turn === turns - 1 ? "dispatching" : "completed",
    })
    snapshot.blocks.push({ type: "user", text: `Continue the refactor, step ${turn}.`, requestId })
    for (let step = 0; step < stepsPerTurn; step++) {
      const id = `${turn}-${step}`
      snapshot.blocks.push(
        {
          type: "thinking",
          id: `thinking-${id}`,
          text: "Checking how the reader and the decoder agree on this record. ".repeat(9),
        },
        {
          type: "tool",
          id: `tool-${id}`,
          title: step % 3 === 0 ? "Shell" : "Read",
          name: step % 3 === 0 ? "Shell" : "Read",
          toolKind: step % 3 === 0 ? "execute" : "read",
          status: "completed",
          input: JSON.stringify({ command: `rg -n "decode" src/file-${step}.ts`, description: "Search" }),
          output: `src/file-${step}.ts:${step}: const decoded = decoder.decode(message)\n`.repeat(36),
        }
      )
      if (step % 4 === 3)
        snapshot.blocks.push({
          type: "text",
          id: `text-${id}`,
          text: `The decoder for step ${step} agrees with the store: \`decodeSession\` returns **${step} blocks** for [decoder.ts](/performance-fixture/src/decoder.ts:${step}).\n\n- \`readRecording\` keeps the header\n- the reader drops \`_meta\` keys\n`,
        })
    }
  }
  return snapshot
}

export function auditStats(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  return {
    samples: values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms:
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ??
      0,
    maxMs: sorted.at(-1) ?? 0,
  }
}
