import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preparePlan, prepareWeights, changeSummary, applyChange, previewSession, readProfile, searchExercises } from './operations.js'

const cfg={base:'http://localhost:9999',token:'test-token'}
const routine={id:'r1',name:'Upper',prog:'double',ex:[{id:'0289',sets:2,reps:12,repsMin:8,weight:20,dbLoad:'each',note:'Keep this note'}]}
const state=()=>({unit:'kg',routines:[structuredClone(routine)],week:{1:['r1']},customEx:[],workouts:[{id:'old-workout',entries:[]}],bodyweight:[{d:'2026-01-01',w:80}],targetW:75,_rev:5,_wid:'original'})
const snapshot=()=>({url:cfg.base,uid:'u1',revision:5,state:state()})
const plan=()=>({opengym_plan:1,unit:'kg',routines:[{...structuredClone(routine),name:'New name'}]})
function fake(initial=state(), {race=false,wrongReadback=false,uid='u1'}={}) {
  let doc=structuredClone(initial),puts=0
  const fetchImpl=async (url,options)=>{
    if(url.endsWith('/api/me'))return Response.json({user:{id:uid,name:'Test'}})
    if(options.method==='PUT'){
      puts++
      const body=JSON.parse(options.body)
      if(race)return Response.json({state:doc,rev:6},{status:409})
      assert.equal(body.baseRev,doc?._rev||0)
      if(doc?._wid)assert.equal(body.baseWid,doc._wid)
      doc={...body.state,_rev:(doc?._rev||0)+1,_wid:'new'}
      if(wrongReadback)doc.routines=[]
      return Response.json({rev:doc._rev})
    }
    return Response.json({state:doc,rev:doc?._rev||0})
  }
  return {options:{fetchImpl},get doc(){return doc},get puts(){return puts}}
}

test('plan preview is read-only, preserves input and describes exact edits',()=>{
  const s=snapshot(),before=structuredClone(s)
  const p=preparePlan(s,plan())
  assert.deepEqual(s,before)
  assert.equal(p.routines[0].before.name,'Upper')
  assert.equal(p.routines[0].after.name,'New name')
  assert.deepEqual(changeSummary(p).routines[0].fields,['name'])
})
test('weight updates convert pounds, preserve native metadata and do not fabricate history',()=>{
  const s=snapshot();s.state.routines[0].ex[0].warmupSets=2
  const p=prepareWeights(s,{unit:'lb',updates:[{routine_id:'r1',position:1,weight:65,reported_reps:12}]})
  assert.equal(p.routines[0].after.ex[0].weight,29.5)
  assert.equal(p.routines[0].after.ex[0].warmupSets,2)
  assert.equal(p.routines[0].after.ex[0].dbLoad,'each')
  assert.equal(s.state.workouts.length,1)
})
test('below-range performance needs explicit acknowledgement, not a guessed lower load',()=>{
  const input={unit:'kg',updates:[{routine_id:'r1',position:1,weight:25,reported_reps:6}]}
  assert.throws(()=>prepareWeights(snapshot(),input),{code:'ETARGET'})
  input.updates[0].acknowledge_rep_mismatch=true
  assert.equal(prepareWeights(snapshot(),input).routines[0].after.ex[0].weight,25)
})
test('invalid quantities, exercise IDs, unknown fields and duplicate owners are refused',()=>{
  for(const edit of [e=>e.sets=0,e=>e.repsMin=20,e=>e.weight=NaN,e=>e.id='not-an-exercise',e=>e.typo=1,e=>e.dbLoad='both']){
    const p=plan();edit(p.routines[0].ex[0]);assert.throws(()=>preparePlan(snapshot(),p),{code:'EINVAL'})
  }
  const p=plan();p.routines.push(p.routines[0]);assert.throws(()=>preparePlan(snapshot(),p),{code:'EINVAL'})
})
test('schedule is an explicit day patch; absent days survive and empty days become rest',()=>{
  const s=snapshot();s.state.week[4]=['r1']
  const p=plan();p.week={1:[],2:['r1']}
  assert.deepEqual(preparePlan(s,p).week.after,{2:['r1'],4:['r1']})
  p.week={3:['unknown']};assert.throws(()=>preparePlan(s,p),{code:'EINVAL'})
})
test('timed exercises cannot be silently authored as repetitions',()=>{
  const p=plan()
  const timed=searchExercises('plank',1)[0]
  p.routines[0].ex[0].id=timed.id
  assert.throws(()=>preparePlan(snapshot(),p),{code:'EINVAL'})
})
test('small converted loads cannot silently become zero or a default progression increment',()=>{
  const p=plan();p.unit='lb';p.routines[0].ex[0].inc=0.01
  assert.throws(()=>preparePlan(snapshot(),p),{code:'EINVAL'})
  assert.throws(()=>prepareWeights(snapshot(),{unit:'lb',updates:[{routine_id:'r1',position:1,weight:0.01}]}),{code:'EINVAL'})
})
test('apply preserves unrelated settings, workouts and weigh-ins and verifies read-back',async()=>{
  const s=snapshot(),server=fake(s.state),p=preparePlan(s,plan())
  const result=await applyChange(cfg,p,server.options)
  assert.equal(result.verified,true);assert.equal(server.puts,1)
  for(const k of ['workouts','bodyweight','targetW','week'])assert.deepEqual(server.doc[k],s.state[k])
  assert.equal(server.doc.routines[0].name,'New name')
})
test('reapplying an identical plan makes no write',async()=>{
  const s=snapshot(),p=preparePlan(s,{opengym_plan:1,unit:'kg',routines:[structuredClone(routine)]}),server=fake(s.state)
  assert.equal((await applyChange(cfg,p,server.options)).no_change,true)
  assert.equal(server.puts,0)
})
test('new profiles adopt the input unit without relabelling existing profiles',async()=>{
  const s={url:cfg.base,uid:'u1',revision:0,state:null},p=plan();p.unit='lb';p.routines[0].ex[0].weight=65
  const changes=preparePlan(s,p),server=fake(null)
  await applyChange(cfg,changes,server.options)
  assert.equal(server.doc.unit,'lb');assert.equal(server.doc.routines[0].ex[0].weight,65)
  assert.equal(preparePlan(snapshot(),p).routines[0].after.ex[0].weight,29.5)
})
test('another account, server, revision, write ID or unit invalidates a prepared change',async()=>{
  for(const field of ['account','server','revision','wid','unit']){
    const s=snapshot(),p=preparePlan(s,plan());let config=cfg,uid='u1'
    if(field==='account')uid='u2'
    if(field==='server')config={...cfg,base:'http://localhost:9998'}
    if(field==='revision')s.state._rev=6
    if(field==='wid')s.state._wid='restored'
    if(field==='unit')s.state.unit='lb'
    const server=fake(s.state,{uid})
    await assert.rejects(applyChange(config,p,server.options),{code:'ECONFLICT'})
    assert.equal(server.puts,0)
  }
})
test('a phone write racing the PUT is not retried over the phone change',async()=>{
  const s=snapshot(),server=fake(s.state,{race:true})
  await assert.rejects(applyChange(cfg,preparePlan(s,plan()),server.options),{code:'ECONFLICT'})
  assert.equal(server.puts,1);assert.equal(server.doc.routines[0].name,'Upper')
})
test('edited prepared files and wrong read-back are surfaced distinctly',async()=>{
  const p=preparePlan(snapshot(),plan());p.routines[0].after.name='edited'
  const server=fake()
  await assert.rejects(applyChange(cfg,p,server.options),{code:'EINVAL'});assert.equal(server.puts,0)
  const wrong=fake(state(),{wrongReadback:true})
  await assert.rejects(applyChange(cfg,preparePlan(snapshot(),plan()),wrong.options),{code:'EVERIFY'})
})
test('profile guard and future engine migrations fail closed',async()=>{
  await assert.rejects(readProfile({...cfg,uid:'different'},fake().options),{code:'EPROFILE'})
  const doc=state();doc.engineSchemaVersion=2
  await assert.rejects(readProfile(cfg,fake(doc).options),{code:'EUNSUPPORTED'})
})
test('session preview uses the real double-progression decision on completed history',()=>{
  const s=snapshot()
  s.state.workouts=[{id:'w1',d:'2026-10-01',routineId:'r1',routineIds:['r1'],entries:[{id:'0289',rid:'r1',target:{...routine.ex[0]},planned:{...routine.ex[0]},sets:[{w:20,r:12,done:true},{w:20,r:12,done:true}]}]}]
  const result=previewSession(s,'r1')
  assert.equal(result.exercises[0].prescription.kind,'up')
  assert.equal(result.exercises[0].opening_sets.length,2)
  assert(result.exercises[0].opening_sets[0].w>20)
  assert.equal(s.state.routines[0].ex[0].weight,20)
})
test('weight-only edits retain native exercise fields through apply',async()=>{
  const s=snapshot();s.state.routines[0].ex[0].warmupSets=2
  const p=prepareWeights(s,{unit:'kg',updates:[{routine_id:'r1',position:1,weight:25}]})
  const server=fake(s.state);await applyChange(cfg,p,server.options)
  assert.equal(server.doc.routines[0].ex[0].warmupSets,2)
})
test('weight-only apply preserves unchanged timed exercises in the same routine',async()=>{
  const s=snapshot(),timed={id:'3238',sets:2,mode:'time',sec:30,note:'Native hold'}
  s.state.routines[0].ex.push(timed)
  const p=prepareWeights(s,{unit:'kg',updates:[{routine_id:'r1',position:1,weight:25}]})
  const server=fake(s.state)
  assert.equal((await applyChange(cfg,p,server.options)).verified,true)
  assert.equal(server.doc.routines[0].ex[0].weight,25)
  assert.deepEqual(server.doc.routines[0].ex[1],timed)
  assert.deepEqual(server.doc.workouts,s.state.workouts)
})
test('plan preview refuses removals the API would restore before proposing a save',()=>{
  const s=snapshot();Object.assign(s.state.routines[0].ex[0],{pyramid:[12,10,8],pyramidWeight:[20,22,24]})
  const before=structuredClone(s)
  assert.throws(()=>preparePlan(s,plan()),{code:'EINVAL',message:/API retains omitted native exercise fields/})
  assert.deepEqual(s,before)
})
test('schedule-only changes reference existing routines without replacing prescriptions',async()=>{
  const s=snapshot(),server=fake(s.state)
  const p=preparePlan(s,{opengym_plan:1,unit:'kg',routines:[],week:{1:[],2:['r1']}})
  assert.deepEqual(p.routines,[])
  assert.equal((await applyChange(cfg,p,server.options)).verified,true)
  assert.deepEqual(server.doc.week,{2:['r1']})
  assert.deepEqual(server.doc.routines,s.state.routines)
  assert.deepEqual(server.doc.workouts,s.state.workouts)
})
