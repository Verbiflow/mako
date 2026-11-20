import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Turn into project…: a chat's folder under `~/Mako/Chats` moves to where the person names, becomes a Git
 * repository, and every conversation in it goes on there; nothing moves while one can't, a destination that exists
 * or sits inside Chats is refused, and a conversation that doesn't resume puts everything back.
 */
const home = realpathSync(mkdtempSync(join(tmpdir(), "mako-chat-projects-")))
process.env.HOME = home
const { makeChatProject } = await import("@mako/host/workspaces/chat-projects")

type Session = { id: string; cwd: string; title: string }
function fakeLive(sessions: Session[], options: { blocked?: string; failsResume?: string } = {}) {
  const calls: string[] = []
  return {
    calls,
    sessions,
    live: {
      // SAFETY: makeChatProject reads only `session.id`, `session.cwd` and `session.title` of a summary.
      summaries: () => sessions.map((session) => ({ session }) as never),
      relocation: (id: string) => (id === options.blocked ? { kind: "wait" as const, reason: "is mid-turn" } : { kind: "now" as const }),
      relocate: async (id: string, cwd: string) => {
        const session = sessions.find((each) => each.id === id)!
        const from = session.cwd
        session.cwd = cwd
        calls.push(`relocate ${id} ${cwd}`)
        return from
      },
      resumeMoved: async (id: string, from: string) => {
        calls.push(`resume ${id}`)
        if (id !== options.failsResume) return undefined
        sessions.find((each) => each.id === id)!.cwd = from
        return "The harness didn't resume the session."
      },
    },
  }
}

try {
  const chats = join(home, "Mako", "Chats")
  const chat = join(chats, "2026-11-19-abc123")
  mkdirSync(join(chat, "notes"), { recursive: true })
  writeFileSync(join(chat, "notes", "plan.md"), "plan")

  const blocked = fakeLive([{ id: "a", cwd: chat, title: "Plan" }], { blocked: "a" })
  await assert.rejects(makeChatProject(blocked.live, { folder: chat, to: "~/plan" }), /can't move yet: “Plan” is mid-turn/)
  assert.ok(existsSync(chat) && blocked.calls.length === 0, "nothing moves while a conversation can't")

  const refusals = fakeLive([])
  await assert.rejects(makeChatProject(refusals.live, { folder: join(home, "elsewhere"), to: "~/plan" }), /Only a chat's own folder/)
  await assert.rejects(makeChatProject(refusals.live, { folder: chat, to: "plan" }), /whole path/)
  await assert.rejects(makeChatProject(refusals.live, { folder: chat, to: "~/Mako/Chats/plan" }), /outside the Chats folder/)
  await assert.rejects(makeChatProject(refusals.live, { folder: chat, to: "~/../plan" }), /without \. or \.\./)
  mkdirSync(join(home, "taken"))
  await assert.rejects(makeChatProject(refusals.live, { folder: chat, to: "~/taken" }), /already exists/)
  await assert.rejects(makeChatProject(refusals.live, { folder: chat, to: "~/missing/plan" }), /isn't a folder/)

  const failing = fakeLive([{ id: "a", cwd: chat, title: "Plan" }, { id: "b", cwd: join(chat, "notes"), title: "Notes" }], { failsResume: "b" })
  await assert.rejects(makeChatProject(failing.live, { folder: chat, to: "~/plan" }), /stayed where it was/)
  assert.ok(existsSync(join(chat, "notes", "plan.md")) && !existsSync(join(home, "plan")), "a conversation that didn't resume puts the folder back")
  assert.deepEqual(failing.sessions.map((session) => session.cwd), [chat, join(chat, "notes")], "and every conversation back in it")

  const moving = fakeLive([{ id: "a", cwd: chat, title: "Plan" }, { id: "b", cwd: join(chat, "notes"), title: "Notes" }, { id: "c", cwd: join(home, "other"), title: "Other" }])
  const made = await makeChatProject(moving.live, { folder: chat, to: "~/plan" })
  const project = join(home, "plan")
  assert.equal(made.path, project)
  assert.ok(!existsSync(chat), "the chat's folder left Chats")
  assert.ok(existsSync(join(project, "notes", "plan.md")), "with everything in it")
  assert.ok(existsSync(join(project, ".git")), "a Git repository now")
  assert.deepEqual(moving.sessions.map((session) => session.cwd), [project, join(project, "notes"), join(home, "other")], "its conversations go on there; others stay")
  assert.ok(moving.calls.includes("resume a") && moving.calls.includes("resume b") && !moving.calls.some((call) => call.includes(" c")))
  console.log("Chat projects checks clean: refusals, nothing moving while one can't, a failed resume put back, a chat made a project")
} finally {
  rmSync(home, { recursive: true, force: true })
}
