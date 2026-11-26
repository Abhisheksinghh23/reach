import fs from 'fs'; import zlib from 'zlib';
const src = fs.readFileSync('src/engine.ts','utf8');
import {transformSync} from 'esbuild'; const js=transformSync(src,{loader:'ts',format:'esm'}).code;
fs.writeFileSync('/tmp/engine.mjs',js);
const {Network,INF}=await import('/tmp/engine.mjs');
const meta=JSON.parse(zlib.gunzipSync(fs.readFileSync('public/data/reach-meta.json.gz')));
const b=zlib.gunzipSync(fs.readFileSync('public/data/reach.bin.gz'));
const ab=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
let t=performance.now(); const net=new Network(meta,ab); console.log('load ms',performance.now()-t, 'footpath edges', net.fpTo.length);
t=performance.now(); net.setDay(0); console.log('setDay ms',performance.now()-t,'connections',net.nConn);
for (const [h,lat,lon,nm] of [[9,12.9777,77.5722,'Majestic'],[4.5,12.9777,77.5722,'Majestic 4:30'],[23,12.9777,77.5722,'Majestic 23:00'],[8.5,12.9279,77.6271,'Koramangala'],[9,13.1986,77.7066,'Airport area']]) {
 for (const mins of [30,45,90]) {
  const r=net.scan(lat,lon,h*3600,mins*60); let n=0; for(const a of r.arr) if(a<INF) n++;
  console.log(nm,'h',h,'budget',mins,'reached',n,'scanned',r.connectionsScanned,'ms',r.ms.toFixed(0));
 }}
const r=net.scan(12.9777,77.5722,9*3600,45*60);
let best=-1,ba=0; r.arr.forEach((a,i)=>{ if(a<INF&&a>ba){ba=a;best=i}});
console.log('farthest',net.names[best],(ba-9*3600)/60); console.log(JSON.stringify(net.trace(r,best).map(l=>({...l,from:l.from<0?'pin':net.names[l.from],to:net.names[l.to]}))));
// sanity: after-midnight
net.setDay(1); const r2=net.scan(12.9777,77.5722,0.5*3600,30*60); let n2=0;for(const a of r2.arr) if(a<INF)n2++; console.log('00:30 Tue reached',n2);
// invariants: every reached stop has a consistent journey
{
 net.setDay(0); const t0=9*3600; const r=net.scan(12.9777,77.5722,t0,60*60); let bad=0,checked=0;
 for(let s=0;s<net.nStops;s+=7){ if(r.arr[s]>=INF) continue; checked++;
  const legs=net.trace(r,s); let t=t0, ok=legs.length>0;
  for(const l of legs){ if(l.dep<t-1||l.arr<l.dep) ok=false; t=l.arr; }
  if(!ok||legs[legs.length-1].arr!==r.arr[s]) bad++; }
 console.log('journey invariant: checked',checked,'bad',bad);
 // monotonic: larger budget never loses stops or worsens arrival
 const r2=net.scan(12.9777,77.5722,t0,90*60); let worse=0; for(let s=0;s<net.nStops;s++) if(r.arr[s]<INF && r2.arr[s]>r.arr[s]) worse++;
 console.log('budget monotonic violations',worse);
}
