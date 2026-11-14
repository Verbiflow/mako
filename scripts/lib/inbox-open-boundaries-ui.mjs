import assert from "node:assert/strict"

/** Production open actions with delayed mock bridge replies; no provider or real profile. */
export async function checkInboxOpenBoundaries({ window, base, evaluate, until, frames, click }) {
  const failures = []
  const load = async () => {
    await window.loadURL(`${base}?mock&app=apex`)
    await until(`Boolean(document.querySelector('.thread-jump-scope [data-apex-row]'))`, "open boundary fixture")
    await click('.thread-jump-scope [data-apex-row]')
    await until(`Boolean(document.querySelector('[data-session-tab][aria-selected="true"]'))`, "open boundary Session")
  }
  const startRelated = async () => {
    await load()
    await click('[data-rail-top-row="inbox"]')
    await evaluate(`Promise.all([import('/src/state/acp.ts'), import('/src/state/live-recovery.ts')]).then(async ([{acp, acpStore}, {hydrateLive}]) => {
    const key = Object.values(acpStore.get().conversations).find((item) => item.kind === 'live' && item.key !== acpStore.get().activeKey).key
    await hydrateLive(key, true)
    const method = Object.hasOwn(window.mako, 'liveRead') ? 'liveRead' : 'liveSnapshot'
    const original = window.mako[method]
    let release
    const pending = new Promise((resolve) => {release = resolve})
    window.openBoundary = {key, original, method, release, asked: false, reads: 0, activations: [], start: acpStore.get().activeKey}
    const activate = acp.activate
    acp.activate = (...args) => {window.openBoundary.activations.push(args[0]); return activate(...args)}
    window.mako[method] = async (...args) => {
      if (args[0] === key) {window.openBoundary.asked = true; window.openBoundary.reads++; await pending}
      return original(...args)
    }
    window.openBoundary.done = acp.openRelated(key)
    })`)
    await until(`window.openBoundary.asked`, "related open is waiting on hydration")
  }
  await startRelated()
  await click('[data-rail-top-row="inbox"]')
  await until(`Boolean(document.querySelector('[data-inbox]'))`, "newer Inbox selection")
  await evaluate(`window.openBoundary.release(); window.openBoundary.done`)
  await frames()
  const related = await evaluate(`import('/src/state/acp-state.ts').then(({acpStore}) => ({inbox: Boolean(document.querySelector('[data-inbox]')), key: acpStore.get().activeKey, start: window.openBoundary.start, activations: window.openBoundary.activations}))`)
  console.log("RELATED_OPEN_AFTER_NEWER_INBOX", JSON.stringify(related))
  if (!related.inbox || related.key !== related.start || related.activations.length) failures.push("related completion replaced newer Inbox/selection")

  await startRelated()
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), false, "known related target leaves Inbox at action start")
  await evaluate(`window.openBoundary.release(); window.openBoundary.done`)
  await frames()
  assert.deepEqual(await evaluate(`({once: window.openBoundary.activations.length === 1 && window.openBoundary.activations[0] === window.openBoundary.key, reads: window.openBoundary.reads})`), {once: true, reads: 1}, "related open activates once without a second hydration")
  await click('[data-rail-top-row="inbox"]')
  await evaluate(`import('/src/state/acp.ts').then(async ({acp}) => {window.openBoundary.invalid = acp.open('missing-navigation-target'); await acp.openRelated('missing-navigation-target')})`)
  assert.equal(await evaluate(`window.openBoundary.invalid`), false)
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-inbox]'))`), true, "invalid direct and related targets preserve Inbox")

  await startRelated()
  await click('[data-rail-top-row="inbox"]')
  await click('.thread-jump-scope [data-apex-row]')
  await evaluate(`window.openBoundary.activations.length = 0; window.openBoundary.release(); window.openBoundary.done`)
  await frames()
  assert.deepEqual(await evaluate(`import('/src/state/acp-state.ts').then(({acpStore}) => ({inbox: Boolean(document.querySelector('[data-inbox]')), same: acpStore.get().activeKey === window.openBoundary.start, calls: window.openBoundary.activations}))`), {inbox: false, same: true, calls: []}, "a newer same-Thread intent also wins when Inbox ends closed")

  await load()
  await click('[data-rail-top-row="inbox"]')
  await until(`Boolean(document.querySelector('[data-inbox]'))`, "Inbox before Search open")
  await evaluate(`import('/src/state/session.ts').then(({actions}) => {
    window.searchBoundary = {calls: [], original: window.mako.openSession}
    window.mako.openSession = async (path) => {window.searchBoundary.calls.push(path); return window.searchBoundary.original(path)}
    return actions.openSession('/mock/claude.jsonl')
  })`)
  await frames()
  const search = await evaluate(`({inbox: Boolean(document.querySelector('[data-inbox]')), calls: window.searchBoundary.calls})`)
  console.log("SEARCH_NON_TAB_OPEN", JSON.stringify(search))
  if (search.inbox || search.calls.length !== 1 || search.calls[0] !== "/mock/claude.jsonl") failures.push("Search non-tab open left Inbox over its target")

  for (const method of ["openSession", "openTab"]) {
    await load()
    await evaluate(`Promise.all([import('/src/state/session.ts'), import('/src/state/tabs.ts')]).then(([{actions, store}, {tabsStore}]) => {
      let release
      const pending = new Promise((resolve) => {release = resolve})
      window.searchBoundary = {release, method: '${method}', original: window.mako.${method}}
      window.mako.${method} = async (...args) => {
        const next = await window.searchBoundary.original(...args)
        await pending
        return next
      }
      window.searchBoundary.done = actions.${method}(${method === "openSession" ? "'/mock/claude.jsonl'" : "{cwd: '/Users/you/new-navigation-target'}"})
      window.searchBoundary.before = {meta: store.get().meta, tabs: tabsStore.get()}
    })`)
    await click('[data-rail-top-row="inbox"]')
    await until(`Boolean(document.querySelector('[data-inbox]'))`, "Inbox during delayed Search/tab open")
    await evaluate(`window.searchBoundary.release(); window.searchBoundary.done`)
    await frames()
    assert.deepEqual(await evaluate(`Promise.all([import('/src/state/session.ts'), import('/src/state/tabs.ts')]).then(([{store}, {tabsStore}]) => ({inbox: Boolean(document.querySelector('[data-inbox]')), unchanged: JSON.stringify({meta: store.get().meta, tabs: tabsStore.get()}) === JSON.stringify(window.searchBoundary.before)}))`), {inbox: true, unchanged: true}, `${method} completion keeps newer Inbox and its selected Session`)
  }

  for (const method of ["pickWorkspace", "newChat"]) {
    await load()
    await evaluate(`Promise.all([import('/src/state/session.ts'), import('/src/state/chat-folders.ts')]).then(([{actions, store}, {chatFoldersStore}]) => {
      let release
      const pending = new Promise((resolve) => {release = resolve})
      window.chooserBoundary = {release, opened: 0, asked: false}
      window.mako.openTab = async () => {window.chooserBoundary.opened++; return null}
      window.mako.pickFolder = async () => {window.chooserBoundary.asked = true; await pending; return '/Users/you/new-navigation-target'}
      window.mako.chatFolders = async () => {window.chooserBoundary.asked = true; await pending; return {root: '/Users/you/Chats', projects: []}}
      chatFoldersStore.set({root: ''})
      store.set({machine: {...store.get().machine, chooseFolder: true}})
      window.chooserBoundary.done = actions.${method}()
    })`)
    await until(`window.chooserBoundary.asked`, "folder lookup/chooser pending")
    await click('[data-rail-top-row="inbox"]')
    await until(`Boolean(document.querySelector('[data-inbox]'))`, "Inbox during folder lookup/chooser")
    await evaluate(`window.chooserBoundary.release(); window.chooserBoundary.done`)
    await frames()
    assert.deepEqual(await evaluate(`({inbox: Boolean(document.querySelector('[data-inbox]')), opened: window.chooserBoundary.opened})`), {inbox: true, opened: 0}, `${method} cannot turn an older answer into a fresh open`)
  }

  await load()
  await evaluate(`import('/src/state/acp.ts').then(({acp, acpStore}) => {
    const key = Object.values(acpStore.get().conversations).find((item) => item.kind === 'live' && item.key !== acpStore.get().activeKey).key
    window.lazyBoundary = {key, activations: [], start: acpStore.get().activeKey}
    const activate = acp.activate
    acp.activate = (...args) => {window.lazyBoundary.activations.push(args[0]); return activate(...args)}
  })`)
  await evaluate(`import('/src/components/notifications/notification-toast.tsx').then(({showNotificationToast}) => showNotificationToast({id: 'boundary-notification', kind: 'finished', subject: {id: 'boundary-live', target: {kind: 'live', key: window.lazyBoundary.key}, title: 'Delayed notification', agent: 'Codex'}, body: 'Open the fixture', at: Date.now(), seen: false}))`)
  await until(`Boolean(document.querySelector('[data-sonner-toast] [role="status"] button'))`, "notification boundary control")
  await evaluate(`import('/src/state/inbox-view.ts').then(({inboxView}) => {document.querySelector('[data-sonner-toast] [role="status"] button').click(); inboxView.open()})`)
  await frames()
  assert.deepEqual(await evaluate(`({inbox: Boolean(document.querySelector('[data-inbox]')), calls: window.lazyBoundary.activations})`), {inbox: true, calls: []}, "notification import cannot supersede newer Inbox")

  await evaluate(`import('/src/state/workspace-moves.ts').then(({applyWorkspaceMoves}) => applyWorkspaceMoves({requests: [{id: 'boundary-move', conversationId: window.lazyBoundary.key, harness: 'codex', project: '/Users/you/mako', changed: 0, state: 'asking'}], alwaysAllowed: []}))`)
  await until(`[...document.querySelectorAll('[data-sonner-toast] button')].some((button) => button.textContent === 'Show')`, "Show boundary control")
  await evaluate(`import('/src/state/inbox-view.ts').then(({inboxView}) => {[...document.querySelectorAll('[data-sonner-toast] button')].find((button) => button.textContent === 'Show').click(); inboxView.open()})`)
  await frames()
  assert.deepEqual(await evaluate(`({inbox: Boolean(document.querySelector('[data-inbox]')), calls: window.lazyBoundary.activations})`), {inbox: true, calls: []}, "workspace Show import cannot supersede newer Inbox")

  await evaluate(`Promise.all([import('/src/state/thread-app.ts'), import('/src/state/session.ts')]).then(([{putThreadApp}, {store}]) => {
    const cwd = store.get().meta.cwd
    const view = {kind: 'setting-up', project: 'mako', root: cwd, thread: {title: 'Delayed Setup', harness: 'codex', conversation: window.lazyBoundary.key}}
    window.mako.threadApp = async () => view
    putThreadApp(cwd, view)
  })`)
  await click('[data-app-control]')
  await until(`Boolean(document.querySelector('[data-app-action="open-setup"]'))`, "Setup boundary control")
  await evaluate(`import('/src/state/inbox-view.ts').then(({inboxView}) => {document.querySelector('[data-app-action="open-setup"]').click(); inboxView.open()})`)
  await frames()
  assert.deepEqual(await evaluate(`({inbox: Boolean(document.querySelector('[data-inbox]')), calls: window.lazyBoundary.activations})`), {inbox: true, calls: []}, "Setup Thread import cannot supersede newer Inbox")
  assert.deepEqual(failures, [], "explicit open boundaries")
  console.log("PASS: related/Search/tab/chooser opens respect newer intent; notification/Show/Setup import completions do not reopen")
}
