import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { apiBase, apiConfig, apiFetch } from '../mcp/src/api-client.js'
import { readProfile, preparePlan, prepareWeights, changeSummary, applyChange, previewSession, searchExercises, fail } from './operations.js'

const HELP = `opengym — compact OpenGym operations (Node 22+; no npm install)
  whoami
  exercises search --query TEXT [--limit 10]
  routines list [--limit 20] [--offset 0]
  routines get --id ID
  session preview --routine ID
  plan preview --file plan.json --out change.json
  weights preview --file weights.json --out change.json
  plan apply --file change.json
  auth pair --url URL --code-file FILE --out token-file
All results are JSON. Preview writes a private, exclusive change file; apply
refuses a different account, server or revision. No automatic conflict retry.
Auth: OPENGYM_URL + OPENGYM_TOKEN_FILE (or OPENGYM_TOKEN); optional OPENGYM_UID.
See docs/AGENT_CLI.md for the two input formats and limits.`
const output = value => process.stdout.write(JSON.stringify(value) + '\n')
const take = (value, fallback, max) => {
  if(value===undefined)return fallback
  const n=Number(value)
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(n)||n>max)throw fail('EINVAL','invalid limit or offset')
  return n
}
function readFile(file, raw=false) {
  if(!file)throw fail('EINVAL','--file is required')
  const stat=fs.statSync(file)
  if(!stat.isFile()||stat.size>1024*1024)throw fail('EINVAL','input must be a file no larger than 1 MiB')
  const text=fs.readFileSync(file,'utf8')
  if(raw)return text.trim()
  try{return JSON.parse(text)}catch{throw fail('EINVAL','input is not valid JSON')}
}
function writeFile(file, value) {
  if(!file)throw fail('EINVAL','--out is required')
  const fd=fs.openSync(file,'wx',0o600)
  try{fs.writeFileSync(fd,typeof value==='string'?value+'\n':JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
}
function config() {
  const env={...process.env}
  if(env.OPENGYM_TOKEN_FILE)env.OPENGYM_TOKEN=readFile(env.OPENGYM_TOKEN_FILE,true)
  return {...apiConfig(env),...(env.OPENGYM_UID?{uid:env.OPENGYM_UID}:{})}
}
function required(v,name){if(!v)throw fail('EINVAL',`${name} is required`);return v}
async function main() {
  const {values:v,positionals:p}=parseArgs({allowPositionals:true,options:{help:{type:'boolean',short:'h'},file:{type:'string'},out:{type:'string'},id:{type:'string'},routine:{type:'string'},query:{type:'string'},limit:{type:'string'},offset:{type:'string'},url:{type:'string'},'code-file':{type:'string'}}})
  if(v.help||p.length===0){process.stdout.write(HELP+'\n');return}
  const command=p.join(' ')
  const allowed={whoami:[], 'exercises search':['query','limit'], 'routines list':['limit','offset'], 'routines get':['id'], 'session preview':['routine'], 'plan preview':['file','out'], 'weights preview':['file','out'], 'plan apply':['file'], 'auth pair':['url','code-file','out']}
  if(!allowed[command])throw fail('EINVAL','unknown command; use --help')
  for(const key of Object.keys(v))if(!allowed[command].includes(key))throw fail('EINVAL',`--${key} is not supported for this command`)
  if(command==='exercises search'){
    output({exercises:searchExercises(required(v.query,'--query'),take(v.limit,10,50))});return
  }
  if(command==='auth pair'){
    const base=apiBase(required(v.url,'--url')),code=readFile(required(v['code-file'],'--code-file'),true)
    if(!/^[A-Za-z0-9-]{6,32}$/.test(code))throw fail('EINVAL','invalid pairing code format')
    required(v.out,'--out')
    // Reserve the path before consuming the one-use code.
    const fd=fs.openSync(v.out,'wx',0o600)
    try{
      const got=await apiFetch({base,token:''},'/api/pair/redeem',{method:'POST',body:{code}})
      if(typeof got.body?.token!=='string'||!got.body.token)throw fail('EAPI','pairing did not return a token')
      fs.writeFileSync(fd,got.body.token+'\n');fs.fsyncSync(fd)
      output({paired:true,server:base,token_file:v.out})
    }catch(e){fs.closeSync(fd);fs.unlinkSync(v.out);throw e}
    fs.closeSync(fd);return
  }
  const cfg=config()
  if(command==='plan apply'){output(await applyChange(cfg,readFile(v.file)));return}
  const snapshot=await readProfile(cfg)
  if(command==='whoami'){output({server:snapshot.url,id:snapshot.uid,name:snapshot.name,unit:snapshot.state?.unit||'kg',revision:snapshot.revision});return}
  if(command==='routines list'){
    const routines=snapshot.state?.routines||[],offset=take(v.offset,0,1000000),limit=take(v.limit,20,50)
    output({revision:snapshot.revision,total:routines.length,offset,routines:routines.slice(offset,offset+limit).map(r=>({id:r.id,name:r.name,exercises:r.ex?.length||0}))});return
  }
  if(command==='routines get'){
    const r=snapshot.state?.routines?.find(r=>r.id===required(v.id,'--id'))
    if(!r)throw fail('ENOENT','routine not found')
    output({revision:snapshot.revision,unit:snapshot.state.unit||'kg',routine:r});return
  }
  if(command==='session preview'){output(previewSession(snapshot,required(v.routine,'--routine')));return}
  const change=command==='plan preview'?preparePlan(snapshot,readFile(v.file)):prepareWeights(snapshot,readFile(v.file))
  writeFile(v.out,change)
  output({...changeSummary(change),change_file:v.out})
}
main().catch(error=>{
  const code=error.code?.startsWith('ERR_PARSE_ARGS')?'EINVAL':error.code||'ECLI'
  // Files, malformed arguments and remote responses can quote input; expose only known local diagnostics.
  const safe=['EINVAL','ETARGET','ECONFLICT','EPROFILE','ENOENT','EUNSUPPORTED','EVERIFY'].includes(code)
  output({error:code,message:safe?error.message:code==='EAUTH'?'Authentication failed; pair again.':code==='ENOCONFIG'?'Set OPENGYM_URL and OPENGYM_TOKEN_FILE (or OPENGYM_TOKEN).':code==='EEXIST'?'Output already exists; choose a new path.':'Operation failed; check configuration, input file and server availability.'})
  process.exitCode=code==='ECONFLICT'?3:code==='EAUTH'?4:code==='EINVAL'||code==='ETARGET'?2:1
})
