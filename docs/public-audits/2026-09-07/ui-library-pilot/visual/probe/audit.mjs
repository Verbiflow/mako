import { build } from '/Users/kashyab/pi-ui/node_modules/esbuild/lib/main.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const candidates={
 'dither-area':'dither-kit/registry/dither-kit/area-chart.tsx',
 'dither-gradient':'dither-kit/registry/dither-kit/gradient.tsx',
 'dither-sparkline':'dither-kit/registry/dither-kit/sparkline.tsx',
 'spell-chart':'spell-ui/registry/spell-ui/chart.tsx',
 'spell-rays':'spell-ui/registry/spell-ui/light-rays.tsx',
 'spell-gradient':'spell-ui/registry/spell-ui/animated-gradient.tsx',
};
const sizes=[];
for(const [name,entry] of Object.entries(candidates)){
 const result=await build({entryPoints:[path.join(root,entry)],bundle:true,write:false,minify:true,format:'esm',platform:'browser',jsx:'automatic',nodePaths:[path.join(root,'probe/node_modules')],external:['react','react-dom','react/*','react-dom/*'],alias:{'@/lib/utils':'/Users/kashyab/pi-ui/src/lib/utils.ts'},logLevel:'silent'});
 const bytes=result.outputFiles[0].contents;
 sizes.push({name,minifiedBytes:bytes.length,gzipBytes:gzipSync(bytes).length});
}
writeFileSync(path.join(root,'bundle-sizes.json'),JSON.stringify({method:'esbuild browser ESM minified, gzip; React/ReactDOM external; includes per-entry transitive imports, not incremental app delta; no CSS; dependencies locked in probe/package-lock.json',sizes},null,2));
console.log(sizes);
// Inventory records registry metadata separately from imports; missing deps are review leads.
const inventory={};
for(const repo of ['dither-kit','spell-ui']){
 const registry=JSON.parse(readFileSync(path.join(root,repo,'registry.json'),'utf8'));
 inventory[repo]=registry.items.map(item=>({name:item.name,dependencies:item.dependencies??[],registryDependencies:item.registryDependencies??[],files:(item.files??[]).map(f=>({path:f.path,imports:[...readFileSync(path.join(root,repo,f.path),'utf8').matchAll(/from\s+["']([^"']+)["']/g)].map(m=>m[1])}))}));
}
writeFileSync(path.join(root,'registry-inventory.json'),JSON.stringify(inventory,null,2));
