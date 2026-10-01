/** Shared, versioned with the engine. No task IDs, credentials or app guesses. */
export const controlJsDescription = `Control browsers and native apps using persistent JavaScript and the initialized control SDK. Prefer a purpose-built API/CLI when it directly supports the task.
The first call prints the SDK documentation once; read it before acting. Start with one discovery call:
- Browser work: await control.browsers()
- Native app work: await control.apps(); if the task already supplies a pid, use await control.windows(pid) instead.
If you already have exact target IDs, bind that target and observe it instead. Never guess IDs or silently substitute a browser.
Use top-level await; bindings persist and can be redeclared in later cells. The last expression, or a returned value, prints: strings as text, SDK results in compact forms, your own values as compact JSON. Wait with expect() or tab.waitFor(), never fixed sleeps. Images require emitImage(await handle.screenshot()).
Focused help: await control.help({topic:"actions"}). Call control.rewriteDocumentation() only if the documentation is no longer in your context. Await every operation, verify the exact outcome, and never replay unknown input. This tool waits for completion; there are no numeric continuation tickets.`

export const controlReplDocumentation = `Mako browser and computer use — persistent JavaScript over the control SDK
The control SDK shares one task session with the mako-control CLI: the same targets, leases, refs, recordings and input guards. MCP never starts a CLI subprocess.

A typical task, one cell per line. Use an id that control.browsers() printed, and connect it first if its line says to. e4 stands for a ref that observe() printed.
  await control.browsers()
  const tab = await control.openTab({browser:id, url:'https://example.com/form'})
  await tab.observe()
  await tab.setValue('e4', 'Ada'); await tab.locator({role:'button', name:'Save'}).click()
  await tab.expect({text:'Saved'}, {timeoutMs:5000})

Cells
- Use top-level await. const and let bindings persist and can be redeclared. state is shared with CLI exec programs, which run as async functions.
- The last expression prints, and so does console.log: a string as itself, an SDK result in the compact form described below, any other value as compact JSON exactly as you built it. Printing never changes the value; view.nodes, receipt.status and tabs.pages stay available to code.
- return value also prints, but the cell then runs as a function and its declarations stay local; keep what you need in state.
- An error prints as one line, Error code (outcome): message, then the calls that changed something before it, if any. Those already happened: observe instead of rerunning the cell.
- Errors, including callbacks that throw after their cell, keep bindings. A timeout, cancellation or worker fault resets them; tabs, windows, leases and recordings survive.

Targets: discover, then use exact IDs only. Binding never observes; reads and images are explicit.
- control.browsers() prints one browser per line: id "name" status → the call its state allows next. Call await control.connectBrowser(id) only when that says so, and never switch browsers after a failure.
- let tab=await control.openTab({browser:id,url}) opens a task tab. control.tabs(id) prints open tabs ID first; await control.claimTab({browser:id,tab}) takes one.
- Native: control.apps() prints running apps pid first, control.windows(pid) their windows window_id first, then let win=control.window({pid,window_id}).
- In code these are objects: (await control.browsers()).browsers, (await control.tabs(id)).pages.

Reading a page
- await tab.observe() prints the title, URL and scroll position, then the accessible outline, one element per line, indented under its container: e12 button "Save" disabled. The leading e12 is its ref.
- Prose prints as text: lines, with links inside as [name](e12). Text that a control's name or label already contains is not printed again.
- text: lines and unnamed list, row and cell lines print without a ref, but they have one: view.nodes keeps every row as {ref?,role,name,depth,...}, and a text: line's rows there have role StaticText with the text in name.
- Long pages print in parts: the first line says rows 1–200 of 1450, and observe({offset:200}) reads on. When you know what you want, narrow instead: observe({within:[{role,name}],match:{role,name},query,max}), or observe({interactive:true}) for a flat list of controls. A filtered read (interactive or query) cannot prove absence.
- In code, view.get({role,name}).ref picks one element, and view.select({role?,text?}) prints the matching rows and keeps them in its .nodes.
- Roles are the browser's accessibility roles and can differ from a role attribute; copy them from observe().

Acting
- Pass refs to tab.click(ref), setValue(ref,text), pressKey(key,{ref}) or selectOption(ref,{label}).
- A page ref names one element of the current document. Reads keep it valid: observe, screenshot, inspect, expect and waitFor. Anything that can change the page expires the tab's refs: actions, and also evaluate, hover, scroll and navigate. Then observe again or use a locator.
- Native window refs (n12) belong to that window's latest observation only.
- A locator reads fresh and needs exactly one match: await tab.locator({role:'button',name:'Save'}).click().
- A string name is exact. name:{prefix:'Draft'}, name:{contains:'draft'} or name:/^Draft/ match names that carry live text such as counts, times or shortcuts.
- Scope duplicates with within:[{role:'dialog',name:'Settings'}]. Leave the name out for a container that is the only one of its role, such as within:[{role:'main'}].

Verifying: never sleep.
- A failed action throws. A receipt, printed when it is a cell's value or logged, is one line, dispatched setValue e4 · route · delivery. It means the input was sent; no action checks its own effect, so check it yourself.
- await tab.expect({role,name,within?,value?,states?,absent?},{timeoutMs}) polls fresh evidence for one element; absent:true waits until no such element exists.
- tab.expect({url?,title?,text?,selector?,hidden?},{timeoutMs}), the same as tab.waitFor, waits on the page; url, title and text are case-sensitive substrings, and hidden:true waits until the text and selector are gone.
- Both throw assertion-failed at the deadline. Text already on the page satisfies a wait at once, so to prove an action caused it, check its absence first or wait on something only the action produces.
- When an outcome is unknown, observe before deciding; never replay the input.

Page verbs
- tab.evaluate(fn,...args) or tab.evaluate('expression') returns a JSON value from page JavaScript; the function runs in the page and cannot see your variables.
- tab.inspect(ref,{attributes?:['href'],styles?:['color']}) reads tag, text, box, visibility, the named computed styles and the named attributes (default: the first 24 present) without changing the page. It prints the element, then what you asked for; the value keeps every field.
- tab.hover(ref), tab.drag(fromRef,toRef,{steps?}) for pointer and HTML5 drag and drop, tab.scrollIntoView(ref), tab.scroll({deltaY}), tab.navigate(url) and tab.dialog({}). Locators offer .hover(), .dragTo(otherLocator), .inspect() and .scrollIntoView().
- Use these before tab.cdp(): raw CDP input skips ref and view checks.

Pixels and files
- const shot=await tab.screenshot({region?}) prints its size and view token, never its pixels. emitImage(shot) shows it, and click({x,y,view:shot.view}) uses its coordinates (CSS pixels on pages).
- artifacts.save(name,value) writes JSON, or an image from screenshot(), to a file and returns {path,bytes}. Node modules load with await import('node:fs/promises') and the like.
- Large output spills whole to files; nothing is silently cut. checkpoint({remember}) and recall() keep bounded task notes in state.

More: await control.help({topic}) for one of discovery, connection, handles, actions, observations, assertions, recording, page, native, output or examples. This documentation is printed once per session; call control.rewriteDocumentation() only after it has left your context. Scripts are trusted local JavaScript, not an OS sandbox.`
