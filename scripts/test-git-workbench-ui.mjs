import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = await mkdtemp(join(tmpdir(), "mako-git-workbench-"))
  // A Thread already has its supervised Vite app on its own address.
  const threadUrl = process.env.MAKO_THREAD_URL
  const server = threadUrl ? undefined : await createServer({
    cacheDir: join(root, "cache"),
    server: { host: "127.0.0.1", port: 0, watch: null },
  })
  if (server) await server.listen()
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-git-workbench-check",
      main: fileURLToPath(import.meta.url),
    })
  )
  const env = {
    ...process.env,
    MAKO_GIT_CHECK_ROOT: root,
    MAKO_GIT_CHECK_URL: `${threadUrl ?? server.resolvedUrls.local[0]}/`.replace(/\/\/$/, "/"),
    MAKO_GIT_REAL_URL: process.argv[2] ?? "",
    MAKO_GIT_REAL_CWD: process.argv[3] ?? "",
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    if (server) await server.close()
  }
  console.log(`Git workbench evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_GIT_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const fixture = (code) =>
    evaluate(
      `import('/src/dev/git-workbench-check.tsx').then(m => { ${code} })`
    )
  // Menus and dialogs fade in; a screenshot waits for every animation that ends.
  const settled = "document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)"
  const capture = async (name, sidebar = false) => {
    await until(settled)
    await evaluate(
      "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))"
    )
    const rectangle = sidebar ? await evaluate("(() => { const aside=document.querySelector('aside'); const r=aside.getBoundingClientRect(); const last=aside.querySelector('fieldset')?.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(Math.min(r.height,(last?.bottom ?? r.bottom)-r.y+8))} })()") : undefined
    await writeFile(join(root, name), (await page.capturePage(rectangle)).toPNG())
  }
  const captureElement = async (name, selector) => {
    await evaluate("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))")
    const bounds = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)} })()`)
    await writeFile(join(root, name), (await page.capturePage(bounds)).toPNG())
  }
  const until = async (code) => {
    const end = Date.now() + 15000
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png")
        throw new Error(`Timed out: ${code}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const click = async (selector) => {
    await evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    const point = await evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el)throw new Error('Missing target'); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`
    )
    for (const type of ["mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        ...point,
      })
  }
  const timer = setTimeout(() => app.exit(1), 90000)
  try {
    await window.loadURL(
      `${process.env.MAKO_GIT_CHECK_URL}scripts/git-workbench.html`
    )
    await until(
      "document.querySelector('[data-change-list]')?.dataset.rowCount === '13000'"
    )
    assert.ok(
      await evaluate(
        "document.querySelectorAll('[data-change-row]').length < 80"
      )
    )
    assert.equal(
      await fixture("return m.calls.diffs"),
      0,
      "Opening Changes must not eagerly load a file"
    )
    const rendering = await fixture(`return (async () => {
      const results = [];
      for (const count of [610, 13000]) {
        const start = performance.now();
        m.selectProject('/fixture/performance-' + count, count);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        results.push({ files: count, paintMs: Math.round(performance.now() - start), rows: Number(document.querySelector('[data-change-list]').dataset.rowCount), mountedRows: document.querySelectorAll('[data-change-row]').length, diffs: m.calls.diffs });
      }
      m.selectProject('/fixture/large');
      return results;
    })()`)
    for (const result of rendering) {
      assert.equal(result.rows, result.files)
      assert.ok(result.mountedRows < 80, "the file count must not expand the mounted list")
      assert.equal(result.diffs, 0, "a large list must not fetch diffs before one is selected")
    }
    console.log(`Changes rendering: ${JSON.stringify(rendering)}`)
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '13000'")
    await capture("large-changes.png")
    await evaluate(
      "document.querySelector('[data-change-list]').scrollTop = 13000 * 24"
    )
    await until(
      "Boolean(document.querySelector('[aria-label=\"Stage file-12999.ts\"]'))"
    )
    await click('[aria-label="Stage file-12999.ts"]')
    await until(
      "document.querySelector('[aria-label=\"Unstage file-12999.ts\"]')?.getAttribute('aria-busy') === 'false'"
    )
    assert.equal(await fixture("return m.calls.stages"), 1)
    await capture("last-file-staged.png")
    const frames = await evaluate(
      "new Promise(resolve => { let last=performance.now(), worst=0, count=0; const tick=()=>{const now=performance.now();worst=Math.max(worst,now-last);last=now;if(++count===15)resolve(worst);else requestAnimationFrame(tick)};requestAnimationFrame(tick) })"
    )
    assert.ok(
      frames < 150,
      `Renderer stalled with a large change list: ${frames}ms`
    )
    assert.equal(
      await evaluate(
        "document.querySelectorAll('[data-push-control] button[aria-label=\"Push to main\"]').length"
      ),
      1
    )
    assert.equal(
      await evaluate(
        "document.querySelectorAll('button[aria-label=\"Push to main\"]').length"
      ),
      1
    )
    assert.ok(
      await evaluate(
        "document.querySelector('[aria-label=\"Commit message\"]').getBoundingClientRect().height >= 64"
      )
    )
    await click('[aria-label="Push to main"]')
    await until(
      "document.querySelector('[data-push-state=pushing]')?.disabled === true"
    )
    assert.equal(await fixture("return m.calls.pushes"), 1)
    await capture("pushing.png")
    await fixture("m.finishPush('/fixture/large', true)")
    await until(
      "document.querySelector('[data-push-control]')?.textContent.includes('Pushed')"
    )
    await capture("pushed.png")
    await fixture("m.resolveHistory('/fixture/large')")
    await until(
      "document.querySelector('[data-history-panel]')?.textContent.includes('Commit from /fixture/large')"
    )
    await fixture("m.startSwitch('/fixture/second')")
    await until("document.querySelectorAll('[data-git-loading]').length >= 2")
    assert.equal(
      await evaluate(
        "document.querySelector('[data-history-panel]').textContent.includes('Commit from /fixture/large')"
      ),
      false
    )
    await capture("switching-project.png")
    await fixture("m.finishSwitch('/fixture/second', 4)")
    await until(
      "document.querySelector('[data-change-list]')?.dataset.rowCount === '4'"
    )
    assert.equal(
      await evaluate(
        "document.querySelector('[data-history-panel]').textContent.includes('Commit from /fixture/large')"
      ),
      false
    )
    await fixture("m.resolveHistory('/fixture/second')")
    await until(
      "document.querySelector('[data-history-panel]').textContent.includes('Commit from /fixture/second')"
    )
    await click('[aria-label="Push to main"]')
    await until("Boolean(document.querySelector('[data-push-state=pushing]'))")
    await fixture("m.selectProject('/fixture/third', 3)")
    assert.equal(
      await evaluate(
        "Boolean(document.querySelector('[data-push-state=pushing]'))"
      ),
      false,
      "A push must not paint another project's button"
    )
    await fixture("m.finishPush('/fixture/second', false)")
    await fixture("m.selectProject('/fixture/second', 4)")
    await until(
      "document.querySelector('[data-push-control]')?.textContent.includes('Pull & merge 3')"
    )
    await capture("push-failed.png")
    assert.equal(await evaluate("document.body.textContent.includes('Retry push')"), false)
    await fixture("m.incoming('/fixture/second')")
    await until("Boolean(document.querySelector('[aria-label=\"Pull and merge 3 incoming commits\"]'))")
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Push to main\"]') === null"), true)
    window.setContentSize(1200, 400)
    await capture("pull-before-push.png", true)
    window.setContentSize(1200, 900)
    await click('[aria-label="Pull and merge 3 incoming commits"]')
    await until("document.querySelector('[data-push-control]')?.textContent.includes('Push 3')")
    await capture("merged-ready-to-push.png", true)
    await click('[aria-label="Push to main"]')
    await until("Boolean(document.querySelector('[data-push-state=pushing]'))")
    await page.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    })
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('[data-push-state=pushing] > svg')).animationName"
      ),
      "none"
    )
    await fixture("m.finishPush('/fixture/second', true)")
    await until(
      "document.querySelector('[data-push-control]')?.textContent.includes('Pushed')"
    )
    await fixture("m.selectProject('/fixture/commit', 3)")
    await until(
      "Boolean(document.querySelector('[aria-label=\"Commit message\"]'))"
    )
    await click('[aria-label="Commit message"]')
    await page.debugger.sendCommand("Input.insertText", {
      text: "Keep the full change set",
    })
    const submit = await evaluate(
      "[...document.querySelectorAll('[data-commit-box] button')].find(b=>b.textContent.startsWith('Commit all'))?.outerHTML"
    )
    assert.ok(submit)
    await evaluate(
      "[...document.querySelectorAll('[data-commit-box] button')].find(b=>b.textContent.startsWith('Commit all')).setAttribute('data-test-commit','')"
    )
    await click("[data-test-commit]")
    await until(
      "document.querySelector('[data-commit-box]').textContent.includes('Committing')"
    )
    await until(
      "document.querySelector('[aria-label=\"Commit message\"]')?.placeholder === 'Nothing to commit' && document.querySelector('[aria-label=\"Commit message\"]').disabled"
    )
    assert.equal(await fixture("return m.calls.commits"), 1)
    await capture("committed.png")
    await fixture("return m.showDirtyBlocker('/fixture/commit')")
    await until("document.body.textContent.includes('Local edits overlap incoming changes.')")
    assert.equal(await evaluate("document.body.textContent.includes('Git needs your local edits set aside')"), false)
    assert.equal(await evaluate("document.body.textContent.includes('Pull and keep my edits')"), false)
    assert.equal(await evaluate("document.querySelectorAll('[data-git-remote-notice]').length"), 1)
    assert.equal(await evaluate("document.querySelectorAll('[data-git-footer] [aria-label=\"Copy Git context\"]').length"), 1)
    await click('[aria-label="Copy Git context"]')
    await until("import('/src/dev/git-workbench-check.tsx').then(m => m.calls.context.includes('local-edit.ts'))")
    await captureElement('dirty-pull-recovery.png', '[data-git-footer]')
    await click('[aria-label="Pull 3 incoming commits with stash"]')
    assert.equal(await fixture("return m.calls.remoteAction"), "merge_autostash")
    await until("!document.querySelector('[data-git-remote-notice]') && document.querySelector('[data-push-control]').textContent.includes('Push')")
    await fixture("return m.showUntrackedBlocker('/fixture/commit')")
    await until("document.body.textContent.includes('A local file conflicts with incoming changes.')")
    assert.equal(await evaluate("document.body.textContent.includes('Continue merge')"), false)
    assert.equal(await evaluate("document.body.textContent.includes('Pull and keep my edits')"), false)
    await evaluate("document.querySelector('[aria-label=\"Copy Git context\"]').click()")
    await until("import('/src/dev/git-workbench-check.tsx').then(m => m.calls.context.includes('report.md'))")
    assert.ok((await fixture("return m.calls.context")).includes('recoverable copy'))
    await capture('untracked-collision.png', true)
    await captureElement('git-notice-collapsed.png', '[data-git-remote-notice]')
    await click('[aria-label="View Git details"]')
    await until("document.querySelector('[data-git-details] pre')?.textContent.includes('report.md')")
    await captureElement('git-notice-expanded.png', '[data-git-details]')
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))")
    await until("!document.querySelector('[data-git-details]')")
    await evaluate("document.querySelector('aside').style.width='300px'")
    await captureElement('git-notice-narrow.png', '[data-git-remote-notice]')
    assert.equal(await evaluate("(() => { const box=document.querySelector('[data-git-remote-notice]'); return box.scrollWidth <= box.clientWidth })()"), true)
    await evaluate("document.querySelector('aside').style.width=''")

    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.runGitRemote('fetch'))")
    window.setContentSize(1200, 360)
    await fixture("return m.showMergeConflict('/fixture/commit')")
    await until("document.body.textContent.includes('Continue merge')")
    assert.ok(await evaluate("document.querySelector('[data-git-remote-notice] [aria-label=\"Copy Git context\"]') !== null"))
    assert.equal(await evaluate("document.querySelector('[data-git-remote-notice]').textContent.includes('Resolve and stage')"), false)
    assert.equal(await evaluate("document.querySelectorAll('[data-git-footer] [aria-label=\"Copy Git context\"]').length"), 1)
    assert.equal(await evaluate("document.querySelectorAll('[data-git-footer] [aria-label=\"View Git details\"]').length"), 1)
    assert.ok(await evaluate("document.querySelector('[data-git-remote-notice] [aria-label=\"Copy Git context\"]').parentElement === document.querySelector('[data-git-remote-notice] [aria-label=\"View Git details\"]').parentElement"))
    await captureElement('active-conflict-row.png', '[data-git-remote-notice]')
    await click('[data-git-remote-notice] [aria-label="View Git details"]')
    await until("document.querySelector('[data-git-details] pre')?.textContent.includes('shared.ts')")
    assert.ok(await evaluate("document.querySelector('[data-git-remote-notice] [aria-label=\"Copy Git context\"]') !== null"))
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
    await until("!document.querySelector('[data-git-details]')")

    assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Continue merge').disabled"), true)
    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.rememberDraft(m.projectDraftKey('/fixture/commit'), 'Keep my existing draft.'))")
    await evaluate("document.querySelector('[aria-label=\"Copy Git context\"]').click()")
    await until("import('/src/dev/git-workbench-check.tsx').then(m => m.calls.context.includes('shared.ts') && m.calls.copied.includes('Saved at'))")
    const copied = await fixture("return m.calls.copied")
    const copiedHtml = await fixture("return m.calls.copiedHtml")
    const conflictContext = await fixture("return m.calls.context")
    assert.ok(copied.includes('commit-git-conflicts.md'))
    assert.ok(conflictContext.includes('/fixture/commit'))
    assert.ok(conflictContext.includes('shared.ts'))
    assert.ok(conflictContext.includes('capturedAt'))
    const identity = JSON.parse(conflictContext.slice(conflictContext.indexOf('{'), conflictContext.lastIndexOf('}') + 1))
    assert.equal(identity.repository, '/fixture/commit')
    assert.equal(identity.branch, 'main')
    assert.equal(identity.head, 'c'.repeat(40))
    assert.equal(identity.upstream, 'origin/main')
    assert.deepEqual(identity.conflictedPaths, ['shared.ts'])
    assert.equal(await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.draftText(m.projectDraftKey('/fixture/commit')))"), 'Keep my existing draft.')
    await capture("merge-conflicts.png", true)
    await captureElement("conflict-footer.png", "[data-commit-box]")
    window.setContentSize(1200, 560)
    await fixture("m.selectMultiRepositoryProject()")
    await until("document.querySelectorAll('section > button[aria-expanded]').length === 2")
    assert.equal(await evaluate("document.body.textContent.includes('Repositories')"), false)
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Changes in mako\"] [data-change-list]')?.dataset.rowCount"), "12")
    assert.equal(await evaluate("document.querySelectorAll('[data-commit-box]').length"), 1)
    assert.ok(await evaluate("document.querySelector('button[aria-label=mako-backend]').getBoundingClientRect().top < 650"), "The next repository follows content instead of being pushed to the panel bottom")
    await capture("repositories-app.png", true)
    await click('button[aria-label="mako"]')
    await until("document.querySelector('button[aria-label=mako]').getAttribute('aria-expanded') === 'false'")
    assert.equal(await evaluate("document.querySelectorAll('[data-commit-box]').length"), 1)
    await click('button[aria-label="mako"]')
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '12'")
    await click('button[aria-label="mako-backend"]')
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '1'")
    assert.equal(await fixture("return m.calls.selections"), 1)
    assert.equal(await evaluate("document.querySelectorAll('[data-git-actions]').length"), 1)
    assert.equal(await evaluate("document.querySelector('[data-git-actions]').dataset.repository"), '/fixture/mono/mako-backend')
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Changes in mako-backend\"] [data-push-control]')"), null)
    await captureElement("focused-repository-actions.png", "[data-git-footer]")
    assert.equal(await evaluate("import('/src/dev/git-workbench-check.tsx').then(m=>m.store.get().meta.cwd)"), "/fixture/mono")
    assert.equal(await evaluate("document.querySelector('button[aria-label=mako-backend]').getAttribute('aria-expanded') === 'true'"), true)
    assert.equal(await evaluate("document.querySelectorAll('[data-commit-box]').length"), 1)
    await capture("repositories-backend.png", true)
    await fixture("m.incoming('/fixture/mono', true)")
    await until("Boolean(document.querySelector('[aria-label=\"Copy Git context\"]'))")
    await evaluate("document.querySelector('[aria-label=\"Copy Git context\"]').click()")
    await until("import('/src/dev/git-workbench-check.tsx').then(m => m.calls.context.includes('/fixture/mono/mako-backend'))")
    assert.equal(await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.draftText(m.projectDraftKey('/fixture/mono')))"), '')
    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.store.set({git: {...m.store.get().git, files: m.store.get().git.files.map(file => ({...file, status: 'modified', staged: true}))}}))")
    await until("Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Continue merge' && !b.disabled)")
    await capture("merge-ready.png", true)
    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.store.set({git: {...m.store.get().git, operation: undefined}}))")
    await until("Boolean(document.querySelector('[aria-label=\"Commit message\"]'))")
    assert.equal(await evaluate("document.body.textContent.includes('Continue merge')"), false)

    await click('button[aria-label="mako"]')
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '12'")
    assert.equal(await evaluate("import('/src/dev/git-workbench-check.tsx').then(m=>m.store.get().meta.cwd)"), "/fixture/mono")
    console.log("Repository selection: switches both ways, keeps the workspace, and shows one shared commit box")

    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.store.set({git: {...m.store.get().git, files: m.store.get().git.files.map((file, index) => ({...file, path: `src/${index % 2 ? 'a' : 'b/c'}/${file.path}`}))}}))")
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '15'")
    await evaluate("document.querySelector('[aria-label=\"List by folder\"]').click()")
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '14'")
    assert.deepEqual(
      await evaluate("Array.from(document.querySelectorAll('[data-change-row]')).map(row => row.textContent).filter(text => text.startsWith('src/')).map(text => text.match(/^src\\/[a-z/]+/)[0])"),
      ["src/a", "src/b/c"],
      "By folder shows each folder once, by its full path"
    )
    await captureElement("files-by-folder.png", '[aria-label="Changes in mako"]')
    await evaluate("document.querySelector('[aria-label=\"Show as a tree\"]').click()")
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '15'")
    console.log("Files list: switches between the folded tree and one row per folder")

    window.setContentSize(1200, 900)
    await fixture("m.selectProject('/fixture/review', 5000)")
    const diffsBefore = await fixture("return m.calls.diffs")
    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.setPref('changesLayout', 'review'))")
    await until("document.querySelector('[data-review-stream]')?.dataset.fileCount === '5000'")
    await until(`import('/src/dev/git-workbench-check.tsx').then(m => m.calls.diffs > ${diffsBefore}) && document.querySelectorAll('[data-review-stream] diffs-container').length > 0`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const screenDiffs = (await fixture("return m.calls.diffs")) - diffsBefore
    assert.ok(screenDiffs < 60, `Review read ${screenDiffs} diffs for one screen of 5,000 files`)
    assert.ok(await evaluate("document.querySelectorAll('[data-review-file]').length < 80"), "Review keeps the DOM bounded")
    assert.equal(await evaluate("document.querySelectorAll('[data-change-list]').length"), 0, "Review has no staging tree")
    assert.equal(await evaluate("document.querySelectorAll('[data-commit-box]').length"), 1)
    await capture("review-stream.png", true)
    const scroller = "[...document.querySelectorAll('[data-review-stream] *')].find(node => node.scrollHeight > node.clientHeight + 4 && getComputedStyle(node).overflowY !== 'visible')"
    await evaluate("document.querySelector('[data-review-stream]').focus()")
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "j", code: "KeyJ", text: type === "keyDown" ? "j" : undefined, windowsVirtualKeyCode: 74 })
    await until(`(${scroller})?.scrollTop > 0`)
    // Diffs arriving at the end grow it, as they would under a person's scroll.
    await until(`(() => { const node = ${scroller}; node.scrollTop = node.scrollHeight; return Boolean(document.querySelector('[data-review-file="file-04999.ts"]')) })()`)
    await until("!document.querySelector('[data-review-stream]').textContent.includes('Reading…')")
    const reviewFrames = await evaluate(
      "new Promise(resolve => { let last=performance.now(), worst=0, count=0; const tick=()=>{const now=performance.now();worst=Math.max(worst,now-last);last=now;if(++count===15)resolve(worst);else requestAnimationFrame(tick)};requestAnimationFrame(tick) })"
    )
    assert.ok(reviewFrames < 150, `Review stalled at the end of 5,000 files: ${reviewFrames}ms`)
    const endDiffs = (await fixture("return m.calls.diffs")) - diffsBefore
    assert.ok(endDiffs > screenDiffs && endDiffs < 140, `Scrolling to the end read ${endDiffs} diffs; it must read the last files and not the ones skipped over`)
    await capture("review-stream-end.png", true)
    await evaluate("window.addEventListener('mako:insert', (event) => { window.reviewMention = event.detail }, { once: true }); void 0")
    await click('[aria-label="More for file-04999.ts"]')
    await until("[...document.querySelectorAll('[role=menuitem]')].some(node => node.textContent.includes('Ask the agent about this file'))")
    await evaluate("[...document.querySelectorAll('[role=menuitem]')].find(node => node.textContent.includes('Ask the agent about this file')).setAttribute('data-ask', ''); void 0")
    await click('[role=menuitem][data-ask]')
    await until("window.reviewMention !== undefined")
    assert.equal(await evaluate("window.reviewMention"), "@file-04999.ts ", "Ask the agent mentions the file the way the file palette does")
    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.setPref('theme', 'light'))")
    await capture("review-stream-light.png", true)
    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => { m.setPref('theme', 'dark'); m.setPref('changesLayout', 'files') })")
    console.log(`Review: 5,000 files in one stream, ${screenDiffs} diffs read for the first screen and ${endDiffs} after jumping to the end, j moves between files, worst frame ${Math.round(reviewFrames)}ms`)

    const escape = async () => {
      for (const type of ["keyDown", "keyUp"])
        await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
      await until("!document.querySelector('[role=menu]')")
    }
    const menuItem = (text) => `[...document.querySelectorAll('[role=menuitem],[role=menuitemradio]')].find(node => node.textContent.includes(${JSON.stringify(text)}))`
    await fixture("m.dismissToasts()")
    await fixture("m.selectMediaProject()")
    await until("document.body.textContent.includes('logo.png') && document.querySelector('[data-git-next]')?.dataset.gitNext === 'open-pull'")
    assert.equal(await evaluate("document.querySelectorAll('[data-push-control] button[aria-label=\"Push to feature/logo\"]').length"), 0, "Publishing isn't a second button beside Open pull request")
    await click('[aria-label="More Git actions"]')
    await until(`Boolean(${menuItem("Publish feature/logo")})`)
    await capture("git-control-menu.png", true)
    await escape()
    await click("[data-git-next] button")
    await until("Boolean(document.querySelector('[aria-label=\"Pull request base branch\"]'))")
    await capture("pull-request-form.png", true)
    await click('[aria-label="Cancel"]')
    await until("!document.querySelector('[aria-label=\"Pull request base branch\"]')")
    console.log("Git control: a feature branch opens its pull request, with Publish behind the chevron; the form opens from the control")

    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.commitDrafts.edit('/fixture/media', 'Refresh the logo'))")
    await until("document.querySelector('[aria-label=\"More ways to commit\"]')?.disabled === false")
    await click('[aria-label="More ways to commit"]')
    await until(`Boolean(${menuItem("Commit and open pull request")}) && Boolean(${menuItem("Commit and push")})`)
    await capture("commit-menu.png", true)
    await escape()
    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.commitDrafts.edit('/fixture/media', ''))")

    await evaluate("document.querySelector('[aria-label^=\"Discard changes to\"][aria-label$=\"app.ts\"]').click()")
    await until("document.querySelector('[data-confirm-dialog]')?.textContent.includes('Discard changes to app.ts?')")
    assert.ok(await evaluate("document.querySelector('[data-confirm-dialog]').textContent.includes('git stash pop')"), "The dialog says where discarded work goes")
    await capture("discard-confirm.png")
    await click("[data-confirm-action]")
    await until("import('/src/dev/git-workbench-check.tsx').then(m => m.calls.discarded.join() === 'src/app.ts')")
    await until("document.body.textContent.includes('Kept in Git')")
    await capture("discard-undo.png")
    await evaluate("[...document.querySelectorAll('[data-sonner-toast] button')].find(node => node.textContent === 'Undo').click()")
    await until(`import('/src/dev/git-workbench-check.tsx').then(m => m.calls.restored === ${JSON.stringify("d".repeat(40))})`)
    await fixture("m.dismissToasts()")
    await until("!document.querySelector('[data-sonner-toast]')")
    console.log("Discard: confirms with the files and where they go, stashes exactly those, and Undo restores that stash")

    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.setPref('changesLayout', 'review'))")
    await until("Boolean(document.querySelector('[data-review-file=\"assets/logo.png\"] img'))")
    assert.ok(await evaluate("document.querySelector('[data-review-file=\"assets/logo.png\"]').textContent.includes('→')"), "An image's header shows both sizes")
    await capture("review-image.png", true)
    await click('[aria-label^="Showing: "]')
    await until(`Boolean(${menuItem("Uncommitted")})`)
    await fixture("m.resolveHistory('/fixture/media')")
    await until(`Boolean(${menuItem("Commit from /fixture/media")}) && Boolean(${menuItem("Since main")})`)
    await capture("review-scope-menu.png", true)
    await evaluate(`${menuItem("Commit from /fixture/media")}.setAttribute('data-pick', ''); void 0`)
    await click("[data-pick]")
    await until("Boolean(document.querySelector('[aria-label^=\"Showing: commit bbbbbbb\"]')) && document.querySelectorAll('[data-review-file]').length > 0")
    await capture("review-commit-scope.png", true)
    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.setPref('changesLayout', 'files'))")
    console.log("Review: image thumbnails and sizes in the header; the scope picker lists Since main and recent commits and shows one commit")
    // A pull request is the harness's to write by default; the form is the override.
    await evaluate("window.__attached = []; window.addEventListener('mako:attach', (event) => window.__attached.push(event.detail.text('')))")
    await evaluate("import('/src/dev/git-workbench-check.tsx').then(m => m.pullComposer.open('/fixture/media'))")
    await until("Boolean(document.querySelector('section[aria-label=\"Open a pull request\"]'))")
    const card = "document.querySelector('section[aria-label=\"Open a pull request\"]')"
    assert.equal(await evaluate(`Boolean(${card}.querySelector('[aria-label="Pull request title"]'))`), false, "The harness writes the pull request unless you choose to")
    assert.match(await evaluate(`${card}.textContent`), /writes the title and description from the branch's commits/)
    assert.equal(await evaluate("document.querySelectorAll('.lucide-sparkles').length"), 0, "No sparkle icons")
    await capture("pull-request-harness.png", true)
    await evaluate(`[...${card}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Write it yourself').click()`)
    await until(`Boolean(${card}?.querySelector('[aria-label="Pull request title"]'))`)
    await capture("pull-request-written.png", true)
    await evaluate(`[...${card}.querySelectorAll('button')].find(b => b.textContent.startsWith('Let ')).click()`)
    await until(`!${card}?.querySelector('[aria-label="Pull request title"]')`)
    await evaluate(`[...${card}.querySelectorAll('button')].find(b => b.textContent.startsWith('Ask ')).click()`)
    await until("window.__attached.length === 1 && !document.querySelector('section[aria-label=\"Open a pull request\"]')")
    assert.match(await evaluate("window.__attached[0]"), /^Open a pull request for `feature\/logo` into `main`\. Call pull_request_status/)
    console.log("Pull request: the harness writes it by default, here or in a new session; Write it yourself is the override; no sparkles")
    console.log(
      "Git UI: 13,000 files with bounded DOM, last-file staging, frame responsiveness, one Push control, pending/success/failure with counts, pull/merge/conflicts, project isolation, history skeletons, commit feedback and reduced motion passed; fixture transport only, no remote pushes"
    )
    window.setContentSize(1200, 800)
    await window.loadURL(`${process.env.MAKO_GIT_CHECK_URL}scripts/live-workflow.html`)
    await until("Boolean(document.querySelector('.composer-input'))")
    await evaluate("import('/src/dev/live-workflow-check.tsx').then(m => m.store.set({git: {cwd:'/fixture/mono',root:'/fixture/mono/mako-backend',branch:'main',head:'abc123',ahead:0,behind:0,operation:'merge',files:[{path:'shared.ts',status:'conflicted',staged:false,insertions:null,deletions:null,binary:false}]}}))")
    await evaluate("window.dispatchEvent(new CustomEvent('mako:compose', {detail:{text:'Please inspect @git'}}))")
    await until("Array.from(document.querySelectorAll('[role=option]')).some(b => b.textContent.includes('Git conflicts'))")
    await capture("conflict-mention-menu.png")
    await evaluate("Array.from(document.querySelectorAll('[role=option]')).find(b => b.textContent.includes('Git conflicts')).click()")
    await until("Boolean(document.querySelector('[aria-label=\"Remove mako-backend-git-conflicts.md\"]'))")
    assert.ok(await evaluate("document.querySelector('.composer-input').value.startsWith('Please inspect ')") )
    assert.equal(await evaluate("document.querySelector('.composer-input').value.includes('mako:git-conflicts')"), false)
    await capture("conflict-attachment.png")
    await click('.composer-input')
    await evaluate(`(() => { const node = document.querySelector('.composer-input'); node.setSelectionRange(node.value.length, node.value.length); const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(copied)}); data.setData('text/html', ${JSON.stringify(copiedHtml)}); node.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:data})); })()`)
    await until("Boolean(document.querySelector('[aria-label=\"Remove commit-git-conflicts.md\"]'))")
    assert.ok(await evaluate("document.querySelector('.composer-input').value.includes('Git conflicts · mako-backend')"))
    await capture("conflict-contexts-in-chat.png")
    await captureElement("conflict-context-chips.png", "[data-composer]")
    await evaluate("(async () => { const {store}=await import('/src/dev/live-workflow-check.tsx'); const status={...store.get().git,operation:undefined,files:[{path:'report.md',status:'untracked',staged:false,insertions:null,deletions:null,binary:false}]}; store.set({git:status}); window.mako.gitStatus=async()=>status; window.mako.gitRemote=async()=>({status,problem:{kind:'untracked',message:'A local file conflicts with incoming changes.',detail:'report.md would be overwritten'}}); await (await import('/src/dev/live-workflow-check.tsx')).runGitRemote('merge'); window.dispatchEvent(new CustomEvent('mako:compose',{detail:{text:'Inspect @git'}})); })()")
    await until("Array.from(document.querySelectorAll('[role=option]')).some(b => b.textContent.includes('Git conflicts') && b.textContent.includes('incoming changes'))")
    await capture('untracked-conflict-reference.png')
    await evaluate("Array.from(document.querySelectorAll('[role=option]')).find(b => b.textContent.includes('Git conflicts')).click()")
    await until("document.querySelector('.composer-input').value.includes('Git conflicts · mako-backend')")
    await evaluate("(async () => { const {store}=await import('/src/dev/live-workflow-check.tsx'); const status={...store.get().git,files:[{path:'local-edit.ts',status:'modified',staged:false,insertions:null,deletions:null,binary:false}]}; store.set({git:status}); window.mako.gitStatus=async()=>status; window.mako.gitRemote=async()=>({status,problem:{kind:'dirty',message:'Local edits overlap incoming changes.',detail:'local-edit.ts would be overwritten'}}); await (await import('/src/dev/live-workflow-check.tsx')).runGitRemote('merge'); window.dispatchEvent(new CustomEvent('mako:compose',{detail:{text:'Inspect @git'}})); })()")
    await until("Array.from(document.querySelectorAll('[role=option]')).some(b => b.textContent.includes('Git conflicts') && b.textContent.includes('incoming changes'))")
    assert.ok(await evaluate("import('/src/dev/live-workflow-check.tsx').then(async m => (await m.gitConflictAttachment().file.text()).includes('local-edit.ts'))"))
    console.log("Conflict context: copying preserves drafts; nested repository remains explicit; @ menu inserts a removable attachment without sending")
    const pull = { number: 42, title: "Keep drafts across reloads", body: "## Summary\n- Drafts survive", state: "open", draft: false, url: "https://github.com/fixture/project/pull/42", head: "main", base: "release", additions: 12, deletions: 3, files: 2, mergeable: "clean", reviewDecision: "none", checks: [{ name: "build", state: "failed" }, { name: "lint", state: "passed" }], reviews: [] }
    await evaluate(`import('/src/dev/live-workflow-check.tsx').then(m => m.githubStore.set({ root: '/fixture/mono/mako-backend', statusRoot: '/fixture/mono/mako-backend', branch: 'main', loading: false, pull: ${JSON.stringify(pull)}, status: { installed: true, authenticated: true, repo: 'fixture/project', defaultBranch: 'main' } }))`)
    await evaluate("(async () => { const {store}=await import('/src/dev/live-workflow-check.tsx'); store.set({git:{...store.get().git,root:'/fixture/mono/mako-backend',branch:'main',operation:undefined,files:[]}}); window.dispatchEvent(new CustomEvent('mako:compose',{detail:{text:'Why does @42'}})); })()")
    await until("Array.from(document.querySelectorAll('[role=option]')).some(b => b.textContent.includes('Pull request #42'))")
    await capture("pull-request-mention-menu.png")
    await evaluate("Array.from(document.querySelectorAll('[role=option]')).find(b => b.textContent.includes('Pull request #42')).click()")
    await until("Boolean(document.querySelector('[aria-label=\"Remove mako-backend-pull-42.md\"]'))")
    assert.equal(await evaluate("document.querySelector('.composer-input').value.includes('mako:pull-request')"), false)
    await until("document.querySelector('[data-composer]').textContent.includes('open · main → release · 1 failing')")
    assert.match(await evaluate("document.querySelector('[data-composer]').textContent"), /open · main → release · 1 failing/)
    await captureElement("pull-request-attachment.png", "[data-composer]")
    console.log("Pull request context: the @ menu attaches the branch's pull request as a snapshot, with its state and failing checks")
    if (process.env.MAKO_GIT_REAL_URL && process.env.MAKO_GIT_REAL_CWD) {
      await window.loadURL(process.env.MAKO_GIT_REAL_URL)
      await until("Boolean(document.querySelector('.composer-input'))")
      const started = Date.now()
      await evaluate(
        `import('/src/dev/live-workflow-check.tsx').then(({actions}) => actions.openWorkspace(${JSON.stringify(process.env.MAKO_GIT_REAL_CWD)}))`
      )
      if (
        await evaluate(
          "Boolean(document.querySelector('[aria-label=\"Show the right sidebar\"]'))"
        )
      )
        await click('[aria-label="Show the right sidebar"]')
      await click('[data-surface-id="changes"]')
      await until("Boolean(document.querySelector('[data-change-list]'))")
      const metrics = await evaluate(
        "({rows:Number(document.querySelector('[data-change-list]').dataset.rowCount), mounted:document.querySelectorAll('[data-change-row]').length})"
      )
      assert.ok(metrics.mounted < 100)
      console.log(
        JSON.stringify({ realProjectMs: Date.now() - started, ...metrics })
      )
      await capture("real-project-changes.png")
      await evaluate(
        "document.querySelector('[data-change-list]').scrollTop = document.querySelector('[data-change-list]').scrollHeight"
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(
        await evaluate(
          "document.querySelectorAll('[data-change-row]').length < 100"
        )
      )
      await capture("real-project-last-files.png")
      const repositories = await evaluate("import('/src/dev/live-workflow-check.tsx').then(m => m.store.get().git?.repositories ?? [])")
      for (const repository of [...repositories].reverse()) {
        const selector = `button[aria-label=${JSON.stringify(repository.label)}]`
        await click(selector)
        await until(`import('/src/dev/live-workflow-check.tsx').then(m => m.store.get().git?.root === ${JSON.stringify(repository.root)} && Boolean(document.querySelector('[data-change-list]')))`)
        const selected = await evaluate("import('/src/dev/live-workflow-check.tsx').then(m => ({cwd:m.store.get().git?.cwd,root:m.store.get().git?.root,files:m.store.get().git?.files.length}))")
        assert.equal(selected.root, repository.root)
        assert.equal(selected.cwd, process.env.MAKO_GIT_REAL_CWD)
        assert.equal(await evaluate("document.querySelectorAll('[data-commit-box]').length"), 1)
        assert.equal(await evaluate("document.body.textContent.includes('Choose a repository in the current workspace')"), false)
        await capture(`real-repository-${repository.label}.png`)
        console.log(JSON.stringify({realRepository: repository.label, ...selected}))
      }
      console.log(
        "Real project inspected read-only: no staging, committing or pushing"
      )
    }
  } finally {
    clearTimeout(timer)
    app.quit()
  }
}
