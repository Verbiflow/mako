import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
const win = new Window();
for (const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) {
 const value = key === 'window' ? win : Reflect.get(win,key);
 Object.defineProperty(globalThis,key,{value: typeof value === 'function' && /^(getComputedStyle|request|cancel)/.test(key) ? value.bind(win) : value, configurable:true});
}
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const {Toaster,toast} = await import('sonner');
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const host=document.createElement('div'); document.body.append(host);
const root=createRoot(host); root.render(<Toaster/>); await delay(50);
toast.loading('Working',{id:'op'}); await delay(30);
toast.success('Done',{id:'op'}); await delay(30);
assert.equal(document.querySelectorAll('[data-sonner-toast]').length,1);
assert.equal(document.querySelector('[data-title]')?.textContent,'Done');
console.log('PASS: loading → success keeps one toast');
toast.dismiss('op'); await delay(300);
toast('Focus lifetime',{id:'focus',duration:160}); await delay(30);
const target=document.querySelector<HTMLElement>('[data-sonner-toast]'); assert.ok(target); target.focus();
await delay(420);
console.log('Keyboard focus alone keeps toast alive:',Boolean(document.querySelector('[data-sonner-toast]')));
root.unmount(); await win.happyDOM.abort();
