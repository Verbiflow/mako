import assert from "node:assert/strict"
import { checkInboxOpenBoundaries } from "./inbox-open-boundaries-ui.mjs"

/** Explicit navigation through the rendered rail and strip, without starting an agent. */
export async function checkInboxNavigation({ window, page, base, evaluate, until, frames, click, capture }) {
  await window.loadURL(`${base}?mock&app=apex`)
  await until(`Boolean(document.querySelector('.thread-jump-scope [data-apex-row]'))`, "navigation fixture")
  await click('.thread-jump-scope [data-apex-row]')
  await until(`Boolean(document.querySelector('[data-session-tab][aria-selected="true"]'))`, "the live Thread's selected tab")
  await evaluate(`Promise.all([import('/src/state/acp.ts'), import('/src/state/threads.ts'), import('/src/state/viewer.ts'), import('/src/state/thread-groups.ts')]).then(([{acp, acpStore}, {threadsStore}, {viewerStore}, {threadGroupsStore}]) => {
    const activate = acp.activate
    const activations = []
    acp.activate = (...args) => { activations.push(args[0]); return activate(...args) }
    window.navigationProbe = {key: acpStore.get().activeKey, activations, selection: () => ({key: acpStore.get().activeKey, path: threadsStore.get().viewing?.ref.path, panes: viewerStore.get().panes, focus: viewerStore.get().focusedPaneId, openDraft: threadGroupsStore.get().open})}
  })`)
  const liveRow = await evaluate(`document.querySelector('.thread-jump-scope [data-apex-row]').getAttribute('data-conversation-id')`)
  const selected = await evaluate(`document.querySelector('[data-session-tab][aria-selected="true"]').dataset.sessionTab`)
  const liveSelector = `.thread-jump-scope [data-conversation-id="${liveRow}"]`
  const tabSelector = `[data-session-tab="${selected}"]`
  await click('.composer-input')
  await page.debugger.sendCommand("Input.insertText", { text: "Keep this unsent navigation draft" })
  await until(`document.querySelector('.composer-input')?.value === 'Keep this unsent navigation draft'`, "unsent draft")
  await evaluate(`window.navigationInput = document.querySelector('.composer-input'); window.navigationInput.setSelectionRange(5, 14)`)
  const before = await evaluate(`window.navigationProbe.selection()`)
  const openInbox = async () => {
    await click('[data-rail-top-row="inbox"]')
    await until(`Boolean(document.querySelector('[data-inbox]'))`, "Inbox open")
  }
  const sameSelection = async () => {
    assert.deepEqual(await evaluate(`window.navigationProbe.selection()`), before, "same Thread retains tab, pane and selection")
    assert.equal(await evaluate(`document.querySelector('.composer-input')?.value`), "Keep this unsent navigation draft")
    assert.deepEqual(await evaluate(`({same: window.navigationInput === document.querySelector('.composer-input'), start: window.navigationInput.selectionStart, end: window.navigationInput.selectionEnd})`), {same: true, start: 5, end: 14}, "composer and text selection survive")
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    await openInbox()
    await evaluate(`window.navigationProbe.activations.length = 0`)
    await click(liveSelector)
    await frames()
    await capture(`navigation-live-same-${repeat}.png`)
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), false, "same live Thread leaves Inbox")
    assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [liveRow], "one live activation, never a forced alternate")
    await sameSelection()
    await openInbox()
    await evaluate(`window.navigationProbe.activations.length = 0`)
    await click(tabSelector)
    await frames()
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), false, "already-selected session tab leaves Inbox")
    assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [], "the selected tab does not reactivate or hydrate")
    await sameSelection()
  }
  console.log("PASS: Inbox -> same live Thread and selected tab, repeated, with draft/selection/pane preservation")

  const fin = await evaluate(`Promise.all([import('/src/state/apex-fins.ts'), import('/src/state/acp-state.ts')]).then(([{threadChildren, finOpening}, {acpStore}]) => {
    const state = acpStore.get(); const apex = state.conversations[state.activeKey].threadId
    const row = document.querySelector('[data-asking-fin][data-openable="true"]')
    const child = threadChildren(state, apex).find((agent) => agent.child?.thread === row.dataset.askingFin)
    window.navigationFin = {apex, thread: child.child.thread, key: finOpening(state, child).key}
    return window.navigationFin
  })`)
  await openInbox()
  await evaluate(`window.navigationProbe.activations.length = 0`)
  await click(`[data-asking-fin="${fin.thread}"][data-openable="true"]`)
  await frames()
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), false, "explicit Fin rail opening leaves Inbox")
  assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [fin.key], "Fin activates once")
  assert.deepEqual(await evaluate(`import('/src/state/apex-fins.ts').then(({apexViewStore}) => ({apex: apexViewStore.get().open?.apex, child: apexViewStore.get().open?.child}))`), {apex: fin.apex, child: fin.thread}, "Fin stays in its Apex context")
  await until(`Boolean(document.querySelector('[data-child-breadcrumb]'))`, "Fin breadcrumb")
  await openInbox()
  await evaluate(`window.navigationProbe.activations.length = 0`)
  await click(`[data-asking-fin="${fin.thread}"][data-openable="true"]`)
  await until(`!document.querySelector('[data-inbox]')`, "reopening the same Fin leaves Inbox")
  assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [fin.key])
  await openInbox()
  await evaluate(`window.navigationProbe.activations.length = 0`)
  await click(`[data-child-tab="${fin.thread}"]`)
  await until(`!document.querySelector('[data-inbox]')`, "selected Fin tab leaves Inbox")
  assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [], "selected Fin tab does not activate again")
  await openInbox()
  await evaluate(`window.navigationProbe.activations.length = 0`)
  await evaluate(`import('/src/state/window-routes.ts').then(({routeWindow}) => {window.navigationFinRoutes = []; window.navigationFinUnroute = routeWindow({open: () => {}, newSession: () => false, newThreadIn: () => {}, threadMenu: () => null, fin: (apex, child) => window.navigationFinRoutes.push({apex, child: child.child.thread})})})`)
  await click(`[data-asking-fin="${fin.thread}"][data-openable="true"]`)
  await until(`!document.querySelector('[data-inbox]')`, "routed Fin open leaves Inbox")
  assert.deepEqual(await evaluate(`window.navigationFinRoutes`), [{apex: fin.apex, child: fin.thread}], "routed Fin receives the same Apex and child once")
  assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [], "routed Fin does not also activate locally")
  await evaluate(`window.navigationFinUnroute()`)
  await openInbox()
  await evaluate(`window.navigationProbe.activations.length = 0`)
  await click(`[data-child-tab="${fin.thread}"] + button`)
  await until(`!document.querySelector('[data-inbox]')`, "Back to Apex leaves Inbox")
  await until(`window.navigationProbe.selection().key === window.navigationProbe.key`, "back to original Apex")
  assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [liveRow], "Back to Apex activates once")
  assert.equal(await evaluate(`document.querySelector('.composer-input')?.value`), "Keep this unsent navigation draft", "Apex draft survives Fin navigation")
  await evaluate(`window.navigationInput = document.querySelector('.composer-input'); window.navigationInput.setSelectionRange(5, 14)`)
  console.log("PASS: openable Fin rail row leaves Inbox once and retains Apex context and draft")

  // The production toast and app-menu components exercise the audited explicit openers too.
  await openInbox()
  await evaluate(`window.navigationProbe.activations.length = 0`)
  await evaluate(`import('/src/components/notifications/notification-toast.tsx').then(({showNotificationToast}) => showNotificationToast({id: 'navigation-notification', kind: 'finished', subject: {id: 'navigation-live', target: {kind: 'live', key: window.navigationFin.key}, title: 'Navigation notification', agent: 'Codex'}, body: 'Open the saved fixture conversation', at: Date.now(), seen: false}))`)
  await until(`Boolean(document.querySelector('[data-sonner-toast] [role="status"] button'))`, "rendered live notification")
  // Clicked where it rests: measured while it still slid in from above the window, the click landed on its top edge
  // only while that edge hadn't yet passed the point, and on a slow runner it had. At rest is in the window, nothing
  // animating, and the same box two frames apart (a transition shows in getAnimations only once a frame starts it).
  await until(`new Promise((resolve) => {
    const button = document.querySelector('[data-sonner-toast] [role="status"] button')
    const toast = button?.closest('[data-sonner-toast]')
    if (!toast) return resolve(false)
    const box = () => { const r = toast.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join() }
    const was = box()
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(box() === was && toast.getBoundingClientRect().top >= 0 &&
      !toast.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running'))))
  })`, "live notification at rest")
  await click('[data-sonner-toast] [role="status"] button')
  await until(`!document.querySelector('[data-inbox]') && window.navigationProbe.selection().key === window.navigationFin.key`, "live notification leaves Inbox")
  assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [fin.key])
  await click(liveSelector)
  await openInbox()
  await evaluate(`window.navigationProbe.activations.length = 0`)
  await evaluate(`import('/src/state/workspace-moves.ts').then(({applyWorkspaceMoves}) => applyWorkspaceMoves({requests: [{id: 'navigation-move', conversationId: window.navigationFin.key, harness: 'codex', project: '/Users/you/mako', changed: 0, state: 'asking'}], alwaysAllowed: []}))`)
  await until(`[...document.querySelectorAll('[data-sonner-toast] button')].some((button) => button.textContent === 'Show')`, "workspace Show toast")
  await evaluate(`[...document.querySelectorAll('[data-sonner-toast] button')].find((button) => button.textContent === 'Show').setAttribute('data-navigation-show', '')`)
  await until(`(() => {
    const toast = document.querySelector('[data-navigation-show]')?.closest('[data-sonner-toast]')
    return Boolean(toast && toast.dataset.mounted === 'true' && !toast.getAnimations().some((animation) => animation.playState === 'running'))
  })()`, "workspace Show toast entered")
  await click('[data-navigation-show]')
  await until(`!document.querySelector('[data-inbox]') && window.navigationProbe.selection().key === window.navigationFin.key`, "workspace Show leaves Inbox")
  assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [fin.key])
  await evaluate(`import('/src/state/workspace-moves.ts').then(({workspaceMovesStore}) => workspaceMovesStore.set({requests: [], alwaysAllowed: []}))`)
  await click(liveSelector)
  await evaluate(`Promise.all([import('/src/state/thread-app.ts'), import('/src/state/session.ts')]).then(([{putThreadApp, threadAppStore}, {store}]) => {
    const cwd = store.get().meta.cwd
    const view = {kind: 'setting-up', project: 'mako', root: cwd, thread: {title: 'Navigation Setup', harness: 'codex', conversation: window.navigationFin.key}}
    window.navigationApp = {cwd, previous: threadAppStore.get().byCwd[cwd], read: window.mako.threadApp}
    window.mako.threadApp = async (asked, ...rest) => asked === cwd ? view : window.navigationApp.read(asked, ...rest)
    putThreadApp(cwd, view)
  })`)
  await openInbox()
  await evaluate(`window.navigationProbe.activations.length = 0`)
  await click('[data-app-control]')
  await until(`Boolean(document.querySelector('[data-app-action="open-setup"]'))`, "Open Setup Thread menu item")
  await click('[data-app-action="open-setup"]')
  await until(`!document.querySelector('[data-inbox]') && window.navigationProbe.selection().key === window.navigationFin.key`, "Open Setup Thread leaves Inbox")
  assert.deepEqual(await evaluate(`window.navigationProbe.activations`), [fin.key])
  await evaluate(`import('/src/state/thread-app.ts').then(({putThreadApp}) => {window.mako.threadApp = window.navigationApp.read; putThreadApp(window.navigationApp.cwd, window.navigationApp.previous)})`)
  await click(liveSelector)
  await evaluate(`window.navigationInput = document.querySelector('.composer-input'); window.navigationInput.setSelectionRange(5, 14)`)
  console.log("PASS: rendered live notification, workspace Show and Open Setup Thread leave Inbox with one activation")

  await openInbox()
  await evaluate(`import('/src/state/acp.ts').then(({acp}) => acp.activate(window.navigationFin.key, false))`)
  await frames()
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), true, "generic activation remains non-navigating")
  await evaluate(`Promise.all([import('/src/state/thread-sessions.ts'), import('/src/state/acp-presence.ts'), import('/src/state/acp-state.ts')]).then(([{openSessionTab}, {selectAcpPresence}, {acpStore}]) => {const presence = selectAcpPresence(acpStore.get()).find((item) => item.key === window.navigationProbe.key); openSessionTab({kind: 'session', id: presence.sessionId, presence}, 'restore')})`)
  await until(`window.navigationProbe.selection().key === window.navigationProbe.key`, "background pane restores its Session")
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), true, "pane restoration leaves Inbox open")
  await click(liveSelector)
  await evaluate(`window.navigationInput = document.querySelector('.composer-input'); window.navigationInput.setSelectionRange(5, 14)`)
  console.log("PASS: generic activation and restored pane selection keep Inbox open")

  await openInbox()
  await evaluate(`Promise.all([import('/src/state/live-recovery.ts'), import('/src/state/acp-state.ts')]).then(([{hydrateLive}, {acpStore}]) => hydrateLive(acpStore.get().activeKey, true))`)
  await frames()
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), true, "background hydration leaves Inbox open")
  await sameSelection()
  const other = "/mock/claude.jsonl"
  assert.ok(other, "a different Thread is rendered")
  await click(`.thread-jump-scope [data-flip-key="${other}"]`)
  await until(`!document.querySelector('[data-inbox]') && (window.navigationProbe.selection().path === ${JSON.stringify(other)} || window.navigationProbe.selection().key !== window.navigationProbe.key)`, "different Thread leaves Inbox")
  await click(liveSelector)
  await until(`document.querySelector('.composer-input')?.value === 'Keep this unsent navigation draft'`, "return restores the original draft")
  console.log("PASS: different Thread navigates, background hydration does not, original draft returns")

  // These sidebar entries are Settings destinations and an external URL, not Inbox-like overlays.
  for (const destination of ["automations", "setup"]) {
    await openInbox()
    await click(`[data-rail-top-row="${destination}"]`)
    await until(`Boolean(document.querySelector('[aria-label="Search settings"]'))`, `${destination} full Settings`)
    assert.equal(await evaluate(`document.querySelector('[role="dialog"] main h2')?.textContent`), destination === "setup" ? "Apps" : "Automations")
    assert.equal(await evaluate(`window.navigationProbe.selection().key`), liveRow)
    await click('[role="dialog"] header button')
    await until(`!document.querySelector('[aria-label="Search settings"]')`, "Settings Back")
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), true, "Back returns to the Inbox that opened Settings")
    await click(liveSelector)
    await until(`!document.querySelector('[data-inbox]')`, "same Thread after Settings")
    assert.equal(await evaluate(`document.querySelector('.composer-input')?.value`), "Keep this unsent navigation draft")
  }
  await evaluate(`window.navigationUrls = []; const original = window.mako.openUrl; window.mako.openUrl = async (url) => {window.navigationUrls.push(url); return original(url)}; true`)
  await openInbox()
  await click('[data-rail-top-row="pulls"]')
  await until(`window.navigationUrls.length === 1`, "Pull requests opens external GitHub")
  assert.match(await evaluate(`window.navigationUrls[0]`), /^https:\/\/github\.com\/[^/]+\/[^/]+\/pulls$/)
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), true, "external GitHub leaves the current page in place")
  assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="Search settings"]'))`), false)
  await click('[data-rail-top-row="view.command-palette"]')
  await until(`Boolean(document.querySelector('[aria-label="Command palette"]'))`, "Search opens command palette")
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await until(`!document.querySelector('[aria-label="Command palette"]')`, "Search dismissed")
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), true, "dismissing Search returns to Inbox")
  await click('[data-rail-top-row="session.new"]')
  await until(`!document.querySelector('[data-inbox]')`, "New thread leaves Inbox")
  console.log("PASS: Automations/Setup Settings and Back, external Pull requests, Search and New thread")

  await window.loadURL(`${base}?mock&app=rail`)
  await until(`Boolean(document.querySelector('[data-thread-row][data-flip-key="/mock/devin.jsonl"]'))`, "native/folded rail fixture")
  const nativeRow = '[data-thread-row][data-flip-key="/mock/devin.jsonl"]'
  await click(nativeRow)
  await until(`import('/src/state/thread-store.ts').then(({threadsStore}) => threadsStore.get().viewing?.ref.path === '/mock/devin.jsonl' && !threadsStore.get().opening)`, "native transcript read")
  await click('.composer-input')
  await page.debugger.sendCommand("Input.insertText", { text: "Native draft stays here" })
  await until(`document.querySelector('.composer-input')?.value === 'Native draft stays here'`, "native draft")
  await openInbox()
  await click(nativeRow)
  await until(`!document.querySelector('[data-inbox]')`, "same native Thread leaves Inbox")
  assert.equal(await evaluate(`document.querySelector('.composer-input')?.value`), "Native draft stays here")
  await openInbox()
  await evaluate(`Promise.all([import('/src/state/thread-store.ts'), import('/src/state/thread-viewing.ts')]).then(([{threadsStore}, {followMovedThread}]) => {const ref = threadsStore.get().viewing.ref; followMovedThread(ref.path, {...ref, path: ref.path + '.moved'})})`)
  await frames()
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), true, "background reader relocation leaves Inbox open despite a changed path")

  const folded = await evaluate(`Promise.all([import('/src/state/thread-groups.ts'), import('/src/state/thread-store.ts')]).then(([{threadGroupsStore}, {threadsStore}]) => {
    const group = Object.values(threadGroupsStore.get().groups)[0]
    const members = threadsStore.get().threads.filter((ref) => group.sessions.some((session) => session.id === ref.sessionId))
    const rendered = [...document.querySelectorAll('[data-thread-row]')].find((row) => members.some((ref) => ref.path === row.dataset.flipKey))
    if (!rendered) throw new Error('Missing folded Thread')
    const first = members[0]
    threadGroupsStore.set({lastViewed: {...threadGroupsStore.get().lastViewed, [group.id]: first.sessionId}})
    window.navigationFolded = {thread: group.id, row: rendered.dataset.flipKey, path: first.path}
    return window.navigationFolded
  })`)
  const foldedRow = `[data-thread-row][data-flip-key="${folded.row}"]`
  await click(foldedRow)
  await until(`!document.querySelector('[data-inbox]')`, "folded native Thread leaves Inbox")
  await until(`import('/src/state/thread-store.ts').then(({threadsStore}) => threadsStore.get().viewing?.ref.path === window.navigationFolded.path && !threadsStore.get().opening)`, "folded row remembers its native Session")
  await openInbox()
  await click(foldedRow)
  await until(`!document.querySelector('[data-inbox]')`, "same folded native Thread leaves Inbox")
  await capture("navigation-folded-native.png")
  console.log("PASS: native and folded-native rows, same/different targets, background reader relocation")

  await click('[data-add-session="new"]')
  await until(`import('/src/state/thread-groups.ts').then(({threadGroupsStore}) => Boolean(threadGroupsStore.get().open))`, "new Session draft tab")
  await click('.composer-input')
  await page.debugger.sendCommand("Input.insertText", { text: "Draft tab is not sent or discarded" })
  await until(`document.querySelector('.composer-input')?.value === 'Draft tab is not sent or discarded'`, "new-tab draft")
  const draftTab = await evaluate(`document.querySelector('[data-session-tab][aria-selected="true"]').dataset.sessionTab`)
  await evaluate(`Promise.all([import('/src/state/thread-sessions.ts'), import('/src/state/session-panes.ts')]).then(([{currentThreadTabs}, {openInPane}]) => openInPane(currentThreadTabs(window.navigationFolded.thread)[0], window.navigationFolded.thread, 'down'))`)
  const draftState = await evaluate(`Promise.all([import('/src/state/viewer.ts'), import('/src/state/thread-groups.ts')]).then(([{viewerStore}, {threadGroupsStore}]) => ({viewer: viewerStore.get(), groups: threadGroupsStore.get()}))`)
  assert.equal(draftState.viewer.panes.length, 2, "a real split-pane layout")
  await openInbox()
  await click(`[data-session-tab="${draftTab}"][aria-selected="true"]`)
  await until(`!document.querySelector('[data-inbox]')`, "selected draft tab leaves Inbox even in a split pane")
  assert.equal(await evaluate(`document.querySelector('.composer-input')?.value`), "Draft tab is not sent or discarded")
  assert.deepEqual(await evaluate(`Promise.all([import('/src/state/viewer.ts'), import('/src/state/thread-groups.ts')]).then(([{viewerStore}, {threadGroupsStore}]) => ({viewer: viewerStore.get(), groups: threadGroupsStore.get()}))`), draftState, "selected draft retains group, draft and exact split-pane layout")
  await capture("navigation-selected-draft-split.png")
  console.log("PASS: already-selected draft tab retains draft, Session selection and split-pane layout")
  await checkInboxOpenBoundaries({ window, base, evaluate, until, frames, click })
}
