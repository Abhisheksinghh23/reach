import puppeteer from 'puppeteer-core';
const url=process.argv[2]||'http://localhost:4173/';
const b=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',args:['--no-sandbox','--enable-unsafe-swiftshader']});
const errs=[];
async function run(name,vp,hash,actions){
 const p=await b.newPage(); await p.setViewport(vp);
 p.on('pageerror',e=>errs.push(name+': '+e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(name+' console: '+m.text())});
 await p.goto(url+hash,{waitUntil:'networkidle2'});
 await p.waitForFunction('window.__reach&&window.__reach.ready&&window.__reach.arrs.length',{timeout:30000});
 if(actions) await actions(p);
 await new Promise(r=>setTimeout(r,1500));
 await p.screenshot({path:`/tmp/shot-${name}.png`});
 const info=await p.evaluate(()=>({stats:document.getElementById('stats').innerText,meet:document.getElementById('meet').innerText,journey:document.getElementById('journey').innerText,hash:location.hash}));
 console.log(name,JSON.stringify(info)); return p;
}
await run('one',{width:1280,height:800},'#t=540&m=45&d=0');
await run('night',{width:1280,height:800},'#t=1380&m=45&d=0');
await run('two',{width:1280,height:800},'#a=12.9777,77.5722&b=12.9352,77.6245&t=540&m=60&d=0');
await run('mobile',{width:390,height:800},'#t=540&m=45&d=6');
await run('click',{width:1280,height:800},'#t=540&m=45&d=0',async p=>{
 await p.evaluate(()=>{const r=window.__reach; r.map.setView([12.9777,77.5722],13)}); await new Promise(r=>setTimeout(r,800));
 await p.mouse.click(700,330); await new Promise(r=>setTimeout(r,800));
});
console.log('errors',errs); await b.close();
