import pathlib,re,base64,json,collections,statistics,subprocess,hashlib
root=pathlib.Path(__file__).parent
repo=root/'soundcn'
rows=[]
for p in sorted((repo/'registry/soundcn/sounds').rglob('*.ts')):
 t=p.read_text(); m=re.search(r'data:audio/([^;]+);base64,([^"\s]+)',t)
 if not m: continue
 b=base64.b64decode(m[2]); field=lambda k: (re.search(r'\b'+k+r':\s*"([^"]+)"',t).group(1))
 d=re.search(r'duration:\s*([0-9.]+)',t)
 rows.append(dict(name=field('name'),path=str(p.relative_to(repo)),binary_bytes=len(b),base64_bytes=len(m[2]),ts_bytes=p.stat().st_size,duration=float(d[1]) if d else None,license=field('license'),author=field('author'),sha256=hashlib.sha256(b).hexdigest()))
summary={'count':len(rows),'licenses':dict(collections.Counter(r['license'] for r in rows)), 'authors':dict(collections.Counter(r['author'] for r in rows)), 'unique_payloads':len(set(r['sha256'] for r in rows))}
for col in ['binary_bytes','base64_bytes','ts_bytes','duration']:
 vals=sorted(r[col] for r in rows if r[col] is not None); summary[col]={'total':sum(vals),'min':vals[0],'median':statistics.median(vals),'p95':vals[int(.95*(len(vals)-1))],'max':vals[-1]}
selected=[]
for name in ['click-soft','click-001','confirmation-001','error-001','switch-001','notification-001']:
 r=next((r for r in rows if r['name']==name),None)
 if r is None: continue
 t=(repo/r['path']).read_text();b=base64.b64decode(re.search(r'base64,([^"\s]+)',t)[1]);p=root/(name+'.mp3');p.write_bytes(b)
 probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(p)]))
 pcm=subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-f','f32le','-acodec','pcm_f32le','-'])
 import array,math
 values=array.array('f',pcm);peak=max(map(abs,values),default=0);rms=math.sqrt(sum(x*x for x in values)/max(1,len(values)))
 selected.append({**r,'stream':{k:probe['streams'][0].get(k) for k in ['sample_rate','channels','bit_rate','duration']},'decoded_frames':len(values),'decoded_peak_dbfs':20*math.log10(peak) if peak else None,'decoded_rms_dbfs':20*math.log10(rms) if rms else None})
summary['selected']=selected
summary['registry_items']=len(json.loads((repo/'registry.json').read_text())['items'])
summary['source_audio']=dict(collections.Counter(p.suffix for p in (repo/'assets').rglob('*') if p.suffix in ['.wav','.ogg','.mp3']))
(root/'measurements.json').write_text(json.dumps(summary,indent=2))
(root/'asset-inventory.json').write_text(json.dumps(rows,indent=2))
print(json.dumps(summary,indent=2))
