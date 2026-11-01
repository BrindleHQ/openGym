import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const root=fileURLToPath(new URL('../',import.meta.url))
const run=(args,env={})=>spawnSync(process.execPath,['bin/opengym',...args],{cwd:root,encoding:'utf8',env:{...process.env,OPENGYM_TOKEN:'',OPENGYM_TOKEN_FILE:'',OPENGYM_URL:'',...env}})
test('CLI help and catalog lookup need no server, token or MCP installation',()=>{
  const help=run(['--help']);assert.equal(help.status,0);assert.match(help.stdout,/session preview/)
  const search=run(['exercises','search','--query','dumbbell bench press','--limit','2'])
  assert.equal(search.status,0);assert.equal(JSON.parse(search.stdout).exercises.length,2)
  assert.equal(search.stderr,'')
})
test('CLI validates flags and limits and emits bounded errors without quoting secret arguments',()=>{
  const secret='never-print-this-private-value'
  for(const args of [['wat',secret],['routines','list','--limit','-1'],['exercises','search','--query','bench','--limit','9999'],['routines','get','--token',secret]]){
    const r=run(args);assert.notEqual(r.status,0);assert(!r.stdout.includes(secret));assert(!r.stderr.includes(secret));assert(r.stdout.length<500)
  }
})

test('pairing keeps the one-use code and token out of output and reserves private output before redeeming',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gym-cli-pair-'))
  const code='ABCD-1234',token='private-session-value',out=path.join(dir,'token'),codeFile=path.join(dir,'code')
  fs.writeFileSync(codeFile,code,{mode:0o600})
  let requests=0
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part
    assert.equal(req.url,'/api/pair/redeem');assert.equal(JSON.parse(body).code,code)
    requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({token}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const pair=()=>new Promise(resolve=>{
    const child=spawn(process.execPath,['bin/opengym','auth','pair','--url',`http://127.0.0.1:${server.address().port}`,'--code-file',codeFile,'--out',out],{cwd:root})
    let stdout='',stderr='';child.stdout.on('data',d=>{stdout+=d});child.stderr.on('data',d=>{stderr+=d})
    child.on('close',status=>resolve({status,stdout,stderr}))
  })
  try{
    const first=await pair();assert.equal(first.status,0);assert(!first.stdout.includes(token));assert(!first.stdout.includes(code));assert.equal(first.stderr,'')
    assert.equal(fs.readFileSync(out,'utf8').trim(),token);assert.equal(fs.statSync(out).mode&0o777,0o600)
    const second=await pair();assert.notEqual(second.status,0);assert.equal(requests,1)
  }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true})}
})

test('CLI against real OpenGym API: preview, apply, conflict and weight setup', {timeout:30000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opengym-cli-'))
  const uid='cli-user',secret=crypto.randomBytes(32).toString('hex')
  const payload=`${uid}:${Date.now()+3600000}:0:b`
  const token=payload+'.'+crypto.createHmac('sha256',secret).update(payload).digest('base64url')
  fs.writeFileSync(path.join(dir,'secret'),secret,{mode:0o600})
  fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({users:[{id:uid,name:'CLI test',created:new Date().toISOString()}],creds:[],subs:[],invites:[]}))
  const initial={unit:'lb',routines:[],week:{},workouts:[{id:'history',d:'2026-01-01',entries:[]}],bodyweight:[{d:'2026-01-01',w:180}],restSec:120,targetW:170,_rev:1,_wid:'seed'}
  const statePath=path.join(dir,`state-${uid}.json`)
  fs.writeFileSync(statePath,JSON.stringify(initial))
  const tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,token,{mode:0o600})
  const child=spawn(process.execPath,['server.js'],{cwd:path.join(root,'api'),stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'0',DATA_DIR:dir,ORIGIN:'http://localhost:8080',RP_ID:'localhost'}})
  let log=''
  child.stderr.on('data',d=>{log+=d})
  try{
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('API startup timed out: '+log)),15000)
      child.stdout.on('data',d=>{log+=d;const m=/gym-api on :(\d+)/.exec(log);if(m){clearTimeout(timer);resolve(m[1])}})
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('API exited: '+log))})
    })
    const base=`http://127.0.0.1:${port}`,env={OPENGYM_URL:base,OPENGYM_TOKEN_FILE:tokenFile,OPENGYM_UID:uid}
    // Async children leave the API's event loop free to answer during each CLI request.
    const cli=args=>new Promise(resolve=>{
      const proc=spawn(process.execPath,['bin/opengym',...args],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']})
      let out='',err='';proc.stdout.on('data',d=>{out+=d});proc.stderr.on('data',d=>{err+=d})
      proc.on('close',status=>{assert(!out.includes(token));assert(!err.includes(token));resolve({status,out,err,json:JSON.parse(out)})})
    })
    const plan={opengym_plan:1,unit:'lb',routines:[{id:'new',name:'Upper',prog:'double',ex:[{id:'0289',sets:4,reps:12,repsMin:8,weight:65,dbLoad:'each',restSec:120}]}],week:{1:['new']}}
    const input=path.join(dir,'plan.json'),prepared=path.join(dir,'change.json')
    fs.writeFileSync(input,JSON.stringify(plan))
    await t.test('identifies the paired profile and defaults to compact output',async()=>{
      const r=await cli(['whoami']);assert.equal(r.status,0);assert.equal(r.json.id,uid)
      assert.equal((await cli(['routines','list'])).json.total,0)
    })
    await t.test('preview does not write profile, creates a private exclusive artifact',async()=>{
      const r=await cli(['plan','preview','--file',input,'--out',prepared])
      assert.equal(r.status,0);assert.equal(r.json.routines[0].action,'create')
      assert.equal(fs.statSync(prepared).mode&0o777,0o600)
      assert.deepEqual(JSON.parse(fs.readFileSync(statePath)),initial)
      const again=await cli(['plan','preview','--file',input,'--out',prepared]);assert.equal(again.json.error,'EEXIST')
    })
    await t.test('apply survives real server stamping and preserves history and settings',async()=>{
      const r=await cli(['plan','apply','--file',prepared]);assert.equal(r.status,0,r.out);assert.equal(r.json.verified,true)
      const doc=JSON.parse(fs.readFileSync(statePath))
      for(const k of ['workouts','bodyweight','restSec','targetW'])assert.deepEqual(doc[k],initial[k])
      assert.deepEqual(doc.week,{1:['new']})
      assert.equal(doc.routines[0].ex[0].weight,65)
    })
    await t.test('actual session preview and routine read distinguish targets from opening sets',async()=>{
      const r=await cli(['session','preview','--routine','new']);assert.equal(r.status,0,r.out)
      assert.equal(r.json.exercises[0].opening_sets.length,4)
      assert.equal(r.json.exercises[0].opening_sets[0].w,65)
      assert.equal((await cli(['routines','get','--id','new'])).json.routine.ex[0].dbLoad,'each')
    })
    await t.test('stale prepared changes fail without another write',async()=>{
      const rev=JSON.parse(fs.readFileSync(statePath))._rev
      const r=await cli(['plan','apply','--file',prepared]);assert.equal(r.status,3);assert.equal(r.json.error,'ECONFLICT')
      assert.equal(JSON.parse(fs.readFileSync(statePath))._rev,rev)
    })
    await t.test('repeat preview is idempotent and no-op apply does not increment revision',async()=>{
      const file=path.join(dir,'no-op.json'),rev=JSON.parse(fs.readFileSync(statePath))._rev
      const p=await cli(['plan','preview','--file',input,'--out',file]);assert.equal(p.json.no_change,true)
      const a=await cli(['plan','apply','--file',file]);assert.equal(a.json.no_change,true)
      assert.equal(JSON.parse(fs.readFileSync(statePath))._rev,rev)
    })
    await t.test('below-range references stop weight setup; valid setup preserves other exercise fields',async()=>{
      const file=path.join(dir,'weights.json'),change=path.join(dir,'weights-change.json')
      const input={unit:'lb',updates:[{routine_id:'new',position:1,weight:70,reported_reps:6}]}
      fs.writeFileSync(file,JSON.stringify(input))
      const bad=await cli(['weights','preview','--file',file,'--out',change]);assert.equal(bad.json.error,'ETARGET');assert(!fs.existsSync(change))
      input.updates[0].reported_reps=10;fs.writeFileSync(file,JSON.stringify(input))
      assert.equal((await cli(['weights','preview','--file',file,'--out',change])).status,0)
      const r=await cli(['plan','apply','--file',change]);assert.equal(r.status,0,r.out)
      const e=JSON.parse(fs.readFileSync(statePath)).routines[0].ex[0]
      assert.equal(e.weight,70);assert.equal(e.sets,4);assert.equal(e.dbLoad,'each');assert.equal(e.restSec,120)
    })
  }finally{
    child.kill('SIGKILL')
    await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve))
    fs.rmSync(dir,{recursive:true,force:true})
  }
})
