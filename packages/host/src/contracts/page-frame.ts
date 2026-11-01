/**
 * The message a page served by URL posts to the frame showing it:
 * `{ type, height, drawn, settled }`. `height` is its content's height in
 * CSS pixels; `drawn` says whether anything in it takes up room (a page
 * whose script never ran is an empty root); `settled` that it has loaded,
 * scripts and all. A reader that knows only `height` keeps working, and a
 * page that reports no `drawn` counts as drawn.
 */
export const PAGE_HEIGHT_MESSAGE = "mako:page-height"

/** Below this a page's height says too little: it is walked for whether it draws anything, and what it draws outside its flow. */
export const PAGE_MIN_HEIGHT = 120

/**
 * Reports the page's height to the frame showing it, so the frame fits the
 * page instead of scrolling inside the transcript. It measures the content,
 * not the viewport (a page whose root fills the viewport reports the
 * frame's own height and stays put), and posts only changes, at most once
 * a frame. A page shorter than `PAGE_MIN_HEIGHT` is walked, at most 2,000
 * elements, for anything that takes up room and where the lowest of those
 * ends, so a page drawn in positioned layers isn't read as its empty body.
 */
export const PAGE_FIT_SCRIPT = `<script>(()=>{if(window.parent===window)return;const skip=new Set(["script","style","template","noscript","link","meta","title","base"]);let last="",queued=false;const measure=()=>{const root=document.documentElement,body=document.body;const content=body?Math.max(body.scrollHeight,body.getBoundingClientRect().bottom+parseFloat(getComputedStyle(body).marginBottom||"0")):0;let height=Math.ceil(Math.max(content,root.getBoundingClientRect().height)),drawn=true;if(body&&height<${PAGE_MIN_HEIGHT}){drawn=Boolean(body.innerText&&body.innerText.trim());let seen=0;for(const element of body.getElementsByTagName("*")){if(++seen>2000){drawn=true;break}if(skip.has(element.localName))continue;const box=element.getBoundingClientRect();if(box.width>0&&box.height>0){drawn=true;height=Math.max(height,Math.ceil(box.bottom+scrollY))}}}return{height,drawn,settled:document.readyState==="complete"}};const post=()=>{queued=false;const next=measure();const key=next.height+"/"+next.drawn+"/"+next.settled;if(key===last)return;last=key;parent.postMessage({type:"${PAGE_HEIGHT_MESSAGE}",...next},"*")};const soon=()=>{if(queued)return;queued=true;requestAnimationFrame(post)};const resized=new ResizeObserver(soon);resized.observe(document.documentElement);const changed=new MutationObserver(soon);addEventListener("DOMContentLoaded",()=>{if(document.body){resized.observe(document.body);changed.observe(document.body,{childList:true,subtree:true})}post()});addEventListener("load",post)})()</script>`
