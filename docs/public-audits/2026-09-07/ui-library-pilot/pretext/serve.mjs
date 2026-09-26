import http from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
const files=new Map([['/',['standalone.html','text/html']],['/index.html',['standalone.html','text/html']],['/results.json',['results.json','application/json']]]);
http.createServer(async(req,res)=>{
 try{
 if(req.method==='POST'&&req.url==='/results'){
 const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1000000){res.writeHead(413).end();return;}chunks.push(chunk);}
 const data=Buffer.concat(chunks);JSON.parse(data.toString());await writeFile(new URL('results.json',import.meta.url),data);res.writeHead(204).end();return;
 }
 const file=files.get(new URL(req.url,'http://localhost').pathname);if(!file){res.writeHead(404).end();return;}res.setHeader('Content-Type',file[1]);res.end(await readFile(new URL(file[0],import.meta.url)));
 }catch{res.writeHead(500).end();}
}).listen(43917,'127.0.0.1',()=>console.log('http://127.0.0.1:43917'));
