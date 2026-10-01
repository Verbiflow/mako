const WAIT = "Use tab.waitFor({url|title|text|selector, hidden?}) or tab.expect(...) with the same condition."
const FIND = "Use observe({query}) for refs, or handle.locator({role,name})."
const READ = "Use inspect(ref) on a tab, or locator.inspect(): {text, value, visible, attributes, box}."

/** Methods agents guess from Playwright and Puppeteer, and what this SDK calls them. */
const HINTS: Readonly<Record<string, string>> = {
  fill: "Use setValue(ref, text) on a handle, or locator.setValue(text).",
  type: "Use setValue(ref, text) on a handle, or locator.setValue(text).",
  setText: "Use setValue(ref, text) on a handle, or locator.setValue(text).",
  clear: 'Use setValue(ref, "") on a handle, or locator.setValue("").',
  press: "Use pressKey(key, {modifiers?, ref?}) on a handle, or locator.pressKey(key).",
  keyboard: "Use pressKey(key, {modifiers?}) on a handle.",
  dblclick: "Use click(ref, {count:2}).",
  doubleClick: "Use click(ref, {count:2}).",
  tap: "Use click(ref).",
  check: "Use click(ref), then expect({role, name, states:{checked:true}}).",
  uncheck: "Use click(ref), then expect({role, name, states:{checked:false}}).",
  goto: "Use tab.navigate(url).",
  visit: "Use tab.navigate(url).",
  reload: 'Use tab.raw("history", {go:"reload"}).',
  goBack: 'Use tab.raw("history", {go:"back"}).',
  goForward: 'Use tab.raw("history", {go:"forward"}).',
  newPage: "Use control.openTab({url}).",
  newTab: "Use control.openTab({url}).",
  url: "observe() prints the page title and URL in its first line; result.page has {title, url}.",
  title: "observe() prints the page title and URL in its first line; result.page has {title, url}.",
  content: "Use tab.evaluate(() => document.documentElement.outerHTML), or observe() for the accessible outline.",
  snapshot: "Use observe(); it returns the page's accessible outline with refs.",
  ariaSnapshot: "Use observe(); it returns the page's accessible outline with refs.",
  textContent: READ,
  innerText: READ,
  innerHTML: 'Use tab.evaluate((selector) => document.querySelector(selector)?.innerHTML, "css"), or inspect(ref).text for its text.',
  getText: READ,
  getAttribute: "Use inspect(ref, {attributes:[name]}).attributes[name].",
  isVisible: READ,
  isEnabled: "Use observe(): disabled elements print `disabled`.",
  isChecked: "Use observe(): checked elements print `checked`.",
  waitForSelector: WAIT,
  waitForURL: WAIT,
  waitForNavigation: WAIT,
  waitForLoadState: "Use tab.waitFor({networkIdle:true}) or navigate(url, {waitUntil}).",
  waitForTimeout: "Use await new Promise((resolve) => setTimeout(resolve, ms)).",
  waitForFunction: WAIT,
  $: FIND,
  $$: FIND,
  querySelector: FIND,
  querySelectorAll: FIND,
  getByRole: FIND,
  getByText: FIND,
  getByLabel: FIND,
  getByPlaceholder: FIND,
  find: FIND,
  setInputFiles: "Use tab.upload(ref, [paths]).",
  selectText: "Use click(ref, {count:3}).",
  focus: "Use click(ref), or pressKey(key, {ref}) to type into it directly.",
  scrollTo: "Use scroll({deltaY}) or scrollIntoView(ref).",
}

/** A failed call to a method this SDK lacks, explained with what it has. */
export function withMethodHint(message: string): string {
  const missing = /\.([\w$]+) is not a function/.exec(message)?.[1]
  const hint = missing !== undefined && Object.hasOwn(HINTS, missing) ? HINTS[missing] : undefined
  return hint ? `${message}. ${hint}` : message
}
