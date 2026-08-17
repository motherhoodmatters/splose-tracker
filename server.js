const express=require('express'),path=require('path'),app=express();
const {Pool}=require('pg');
app.use(express.json());



const API_KEY=process.env.SPLOSE_API_KEY||'';
const BASE='https://api.splose.com/v1';
const HEADERS={'Authorization':'Bearer '+API_KEY,'User-Agent':'splose-tracker/1.0','Content-Type':'application/json'};
const CHECKIN_ID=399669;
const STUDENT_IDS=new Set([399651,399621,415863,416098,416099,416100,416101,416173,425885,437283,425993,425994]);

const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,idleTimeoutMillis:30000,max:3});

async function initDB(){
  await pool.query(`CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,value TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks(client_id TEXT PRIMARY KEY,data TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS statuses(client_id TEXT PRIMARY KEY,status TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS removed(client_id TEXT PRIMARY KEY,removed_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`ALTER TABLE removed ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`CREATE TABLE IF NOT EXISTS removed_students(client_id TEXT PRIMARY KEY,removed_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS removed_onboarding(client_id TEXT PRIMARY KEY,removed_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS onboarding_tasks(client_id TEXT PRIMARY KEY,data TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS followup_overrides(client_id TEXT PRIMARY KEY,days INTEGER,updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS last_actions(client_id TEXT PRIMARY KEY,updated_at TIMESTAMPTZ DEFAULT NOW())`);
  
  console.log('DB ready');
}

async function getCache(key,noExpiry){
  const r=await pool.query('SELECT value,updated_at FROM cache WHERE key=$1',[key]);
  if(!r.rows.length)return null;
  if(!noExpiry){
    var age=(Date.now()-new Date(r.rows[0].updated_at).getTime())/1000/60/60;
    if(age>6)return null;
  }
  return JSON.parse(r.rows[0].value);
}
async function setCache(key,value){
  await pool.query('INSERT INTO cache(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()',[key,JSON.stringify(value)]);
}
async function getTasks(){
  const r=await pool.query('SELECT client_id,data FROM tasks');
  const out={};
  r.rows.forEach(function(row){out[row.client_id]=JSON.parse(row.data);});
  console.log('Tasks in DB:', Object.keys(out).length, 'clients with tasks:', JSON.stringify(Object.keys(out)));
  return out;
}
async function setTasks(clientId,tasks){
  await pool.query('INSERT INTO tasks(client_id,data,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(client_id) DO UPDATE SET data=$2,updated_at=NOW()',[clientId,JSON.stringify(tasks)]);
}
async function getRemoved(){
  const r=await pool.query('SELECT client_id,removed_at FROM removed');
  const out={};
  r.rows.forEach(function(row){out[row.client_id]=row.removed_at;});
  return out;
}
async function getStudentRemoved(){
  const r=await pool.query('SELECT client_id FROM removed_students');
  return new Set(r.rows.map(function(row){return row.client_id;}));
}
async function addStudentRemoved(clientId){
  await pool.query('INSERT INTO removed_students(client_id) VALUES($1) ON CONFLICT DO NOTHING',[clientId]);
}
async function getOnboardingRemoved(){
  const r=await pool.query('SELECT client_id FROM removed_onboarding');
  return new Set(r.rows.map(function(row){return row.client_id;}));
}
async function addOnboardingRemoved(clientId){
  await pool.query('INSERT INTO removed_onboarding(client_id) VALUES($1) ON CONFLICT DO NOTHING',[clientId]);
}
async function addRemoved(clientId){
  await pool.query('INSERT INTO removed(client_id,updated_at) VALUES($1,NOW()) ON CONFLICT(client_id) DO NOTHING',[clientId]);
}
async function getOnboardingTasks(){
  const r=await pool.query('SELECT client_id,data FROM onboarding_tasks');
  const out={};
  r.rows.forEach(function(row){out[row.client_id]=JSON.parse(row.data);});
  return out;
}
async function setOnboardingTasks(clientId,tasks){
  await pool.query('INSERT INTO onboarding_tasks(client_id,data,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(client_id) DO UPDATE SET data=$2,updated_at=NOW()',[clientId,JSON.stringify(tasks)]);
}
async function getStatuses(){
  const r=await pool.query('SELECT client_id,status FROM statuses');
  const out={};
  r.rows.forEach(function(row){out[row.client_id]=row.status;});
  console.log('Statuses in DB:', JSON.stringify(out));
  return out;
}
async function setStatus(clientId,status){
  if(status){
    await pool.query('INSERT INTO statuses(client_id,status,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(client_id) DO UPDATE SET status=$2,updated_at=NOW()',[clientId,status]);
  }else{
    await pool.query('DELETE FROM statuses WHERE client_id=$1',[clientId]);
  }
}

async function touchLastAction(clientId){
  await pool.query('INSERT INTO last_actions(client_id,updated_at) VALUES($1,NOW()) ON CONFLICT(client_id) DO UPDATE SET updated_at=NOW()',[clientId]);
}
async function getLastActions(){
  const r=await pool.query('SELECT client_id,updated_at FROM last_actions');
  const out={};
  r.rows.forEach(function(row){out[row.client_id]=row.updated_at;});
  return out;
}
async function getFollowupOverrides(){
  const r=await pool.query('SELECT client_id,days FROM followup_overrides');
  const out={};
  r.rows.forEach(function(row){out[row.client_id]=row.days;});
  return out;
}
async function setFollowupOverride(clientId,days){
  if(days===null||days===undefined){
    await pool.query('DELETE FROM followup_overrides WHERE client_id=$1',[clientId]);
  }else{
    await pool.query('INSERT INTO followup_overrides(client_id,days,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(client_id) DO UPDATE SET days=$2,updated_at=NOW()',[clientId,days]);
  }
}

app.post('/api/followup-override',async function(req,res){
  const{clientId,days}=req.body;
  if(!clientId)return res.status(400).json({error:'clientId required'});
  try{
    await setFollowupOverride(clientId,days===''||days===null||days===undefined?null:Number(days));
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

function wait(ms){return new Promise(r=>setTimeout(r,ms));}
async function allPages(ep,params){
  params=params||{};
  const results=[];
  const qs=new URLSearchParams(params).toString();
  let url=BASE+ep+(qs?'?'+qs:'');
  let retries=0;
  while(url){
    const res=await fetch(url,{headers:HEADERS});
    if(res.status===429){
      retries++;
      if(retries>8){throw new Error('Splose rate limit - giving up after 8 retries');}
      const backoff=3000*retries;
      console.log('Rate limited... retry '+retries+'/8, waiting '+backoff+'ms');
      await wait(backoff);
      continue;
    }
    retries=0;
    if(res.status>=400){throw new Error('Splose '+res.status);}
    const body=await res.json();
    results.push.apply(results,body.data||[]);
    const next=body.links&&body.links.nextPage;
    url=next?'https://api.splose.com'+next:null;
    if(url)await wait(400);
  }
  return results;
}

const syncLock={active:false};
async function waitForFullSync(){
  let waited=0;
  while(syncLock.active&&waited<180000){
    await wait(1000);
    waited+=1000;
  }
}

const ONBOARDING_DEFAULT_TASKS=[{id:'ob1',assignee:'Annie',n:'Contact card sent to Felicity',done:false},{id:'ob2',assignee:'Annie',n:'Registration',done:false},{id:'ob3',assignee:'Annie',n:'Consent',done:false},{id:'ob4',assignee:'Annie',n:'Safety Checklist if Home',done:false},{id:'ob5',assignee:'Annie',n:'Address to consult if home',done:false},{id:'ob6',assignee:'Annie',n:'DOB and Medicare (if applicable) added',done:false},{id:'ob7',assignee:'Annie',n:'Joined Circle',done:false},{id:'ob8',assignee:'Annie',n:'Circle chat opened and welcome message sent',done:false}];

// Single shared full sync: one pass over all patients, one appointments fetch per patient,
// used to populate clients, students, and onboarding caches together instead of three
// separate full scans. Progress checkpoints go to *_staging keys (crash recovery only) -
// the live clients/students/onboarding cache keys are only written once the sync fully
// completes, so a page load mid-sync keeps serving the last complete list.
async function runFullSync(){
  syncLock.active=true;
  try{
    console.log('Full sync starting (clients+students+onboarding, shared pass)...');
    const allTasks=await getTasks();
    const allStatuses=await getStatuses();
    const removedMap=await getRemoved();
    const studentRemovedRows=await pool.query('SELECT client_id,removed_at FROM removed_students');
    const studentRemovedMap={};
    studentRemovedRows.rows.forEach(function(r){studentRemovedMap[r.client_id]=r.removed_at;});
    const allOverrides=await getFollowupOverrides();
    const onboardingRemovedSet=await getOnboardingRemoved();
    const allLastActions=await getLastActions();
    const onboardingTasksMap=await getOnboardingTasks();

    const pracs=await allPages('/practitioners').catch(function(){return [];});
    const pnames={};
    pracs.forEach(function(p){pnames[p.id]=((p.firstname||'')+' '+(p.lastname||'')).trim();});
    const patients=await allPages('/patients');
    console.log(patients.length+' patients');

    const MENTORING_IDS=new Set([399651,399621,415863,416098,416099,416100,416101,416173,425885,437283]);
    const INTERACTION_IDS=new Set([399651,399621,399669]);
    const ONBOARDING_STUDENT_IDS=new Set([399651,399621,415863,416098,416099,416100,416101,416173,425885,437283,444486]);

    const clients=[],students=[],onboarding=[];

    for(var i=0;i<patients.length;i++){
      const p=patients[i];
      const name=((p.firstname||'')+' '+(p.lastname||'')).trim()||'Patient '+p.id;
      var appts;
      try{
        appts=await allPages('/appointments',{patientId:p.id});
      }catch(syncErr){
        console.log('  sync interrupted at patient '+(i+1)+'/'+patients.length+' - staging partial results ('+clients.length+' clients, '+students.length+' students, '+onboarding.length+' onboarding)');
        await setCache('clients_staging',clients);
        await setCache('students_staging',students);
        await setCache('onboarding_staging',onboarding);
        throw syncErr;
      }
      await wait(700);

      // ---- Students ----
      const mentoringAppts=appts.filter(function(a){return a.start&&MENTORING_IDS.has(Number(a.serviceId));});
      if(mentoringAppts.length){
        const studentRemovedAt=studentRemovedMap[String(p.id)];
        var includeStudent=true;
        if(studentRemovedAt){
          const hasNewApptS=mentoringAppts.some(function(a){return new Date(a.start)>new Date(studentRemovedAt);});
          if(hasNewApptS){
            await pool.query('DELETE FROM removed_students WHERE client_id=$1',[String(p.id)]);
          } else {
            includeStudent=false;
          }
        }
        if(includeStudent){
          const interactions=mentoringAppts.filter(function(a){return INTERACTION_IDS.has(Number(a.serviceId));}).sort(function(a,b){return new Date(b.start)-new Date(a.start);});
          const statusVal=allStatuses[String(p.id)];
          const programs=(statusVal&&statusVal.indexOf('programs_')===0)?statusVal.slice(9).split(',').filter(Boolean):[];
          students.push({id:String(p.id),name:name,practitioner:pnames[p.practitionerId]||'',appointments:interactions.map(function(a){return {id:String(a.id),date:a.start.split('T')[0],serviceId:a.serviceId,isCheckin:Number(a.serviceId)===399669};}),tasks:allTasks[String(p.id)]||[],programs:programs,lastAction:allLastActions[String(p.id)]||null});
        }
      }

      // ---- Onboarding ----
      const sortedAsc=appts.filter(function(a){return !!a.start;}).sort(function(a,b){return new Date(a.start)-new Date(b.start);});
      const firstAppt=sortedAsc[0];
      var isOnboardingNow=false;
      if(firstAppt&&firstAppt.start>='2026-06-04'&&!onboardingRemovedSet.has(String(p.id))){
        const isStudentSvc=sortedAsc.some(function(a){return ONBOARDING_STUDENT_IDS.has(Number(a.serviceId));});
        if(!isStudentSvc){
          isOnboardingNow=true;
          const existingTasks=onboardingTasksMap[String(p.id)];
          const tasks=existingTasks||ONBOARDING_DEFAULT_TASKS.map(function(t){return Object.assign({},t,{id:t.id+'_'+p.id});});
          onboarding.push({id:String(p.id),name:name,practitioner:pnames[p.practitionerId]||'',firstAppt:firstAppt.start.split('T')[0],tasks:tasks});
        }
      }

      // ---- Clients ----
      const realAppts=appts.filter(function(a){return a.start&&Number(a.serviceId)!==CHECKIN_ID;});
      const hasRecent=realAppts.some(function(a){return a.start>='2026-04-01';});
      const hasNonStudentAppt=appts.some(function(a){return !STUDENT_IDS.has(Number(a.serviceId))&&Number(a.serviceId)!==CHECKIN_ID;});
      if(hasRecent&&hasNonStudentAppt&&!isOnboardingNow){
        const removedAt=removedMap[String(p.id)];
        var includeClient=true;
        if(removedAt){
          const hasNewAppt=realAppts.some(function(a){return new Date(a.start)>new Date(removedAt);});
          if(hasNewAppt){
            await pool.query('DELETE FROM removed WHERE client_id=$1',[String(p.id)]);
            delete removedMap[String(p.id)];
          } else {
            includeClient=false;
          }
        }
        if(includeClient){
          const sorted=appts.filter(function(a){return !!a.start;}).sort(function(a,b){return new Date(b.start)-new Date(a.start);});
          const lastReal=sorted.find(function(a){return Number(a.serviceId)!==CHECKIN_ID;});
          var mob=null;if(p.phoneNumbers&&p.phoneNumbers.length){var mobEntry=p.phoneNumbers.find(function(ph){return ph.type==='Mobile'||ph.type==='mobile';});var chosen=mobEntry||p.phoneNumbers[0];if(chosen)mob=(chosen.code||'')+(chosen.phoneNumber||'');}
          clients.push({id:String(p.id),name:name,mobile:mob,practitioner:pnames[p.practitionerId]||'',lastRealAppt:lastReal?lastReal.start.split('T')[0]:null,appointments:sorted.map(function(a){return {id:String(a.id),date:a.start.split('T')[0],serviceId:a.serviceId,isCheckin:Number(a.serviceId)===CHECKIN_ID};}),tasks:allTasks[String(p.id)]||allTasks[p.id]||[],manualStatus:allStatuses[String(p.id)]||null,followupDays:allOverrides[String(p.id)]||null,lastAction:allLastActions[String(p.id)]||null});
        }
      }

      if((i+1)%50===0){
        await setCache('clients_staging',clients);
        await setCache('students_staging',students);
        await setCache('onboarding_staging',onboarding);
        console.log('  progress checkpoint '+(i+1)+'/'+patients.length+' - '+clients.length+' clients, '+students.length+' students, '+onboarding.length+' onboarding so far (staged, not live yet)');
      }
    }

    await setCache('clients',clients);
    await setCache('students',students);
    await setCache('onboarding',onboarding);
    console.log('DONE! '+clients.length+' clients, '+students.length+' students, '+onboarding.length+' onboarding');
  } finally {
    syncLock.active=false;
  }
}

app.use(express.static(path.join(__dirname,'public')));

app.get('/api/clients',async function(req,res){
  if(!API_KEY)return res.status(500).json({error:'SPLOSE_API_KEY not set'});
  const fullSync=req.query.full==='true';
  try{
    const allTasks=await getTasks();const allStatuses=await getStatuses();const removedMap=await getRemoved();const allOverrides=await getFollowupOverrides();const allLastActions=await getLastActions();
    async function decorate(list){
      const onboardingSnap=await getCache('onboarding',true)||[];
      const onboardingIdSet=new Set(onboardingSnap.map(function(c){return c.id;}));
      const obRemovedSet=await getOnboardingRemoved();
      return list.filter(function(c){return !removedMap[c.id]&&(!onboardingIdSet.has(c.id)||obRemovedSet.has(c.id));}).map(function(c){return Object.assign({},c,{tasks:allTasks[c.id]||c.tasks||[],manualStatus:allStatuses[c.id]||null,followupDays:allOverrides[c.id]||null,lastAction:allLastActions[c.id]||null,mobile:c.mobile||null});});
    }
    if(!fullSync){
      const cached=await getCache('clients');
      if(cached&&cached.length>0){
        console.log('Serving '+cached.length+' clients from DB cache');
        return res.json({clients:await decorate(cached),syncedAt:new Date().toISOString(),fromCache:true});
      }
    }
    if(syncLock.active){
      console.log('Sync already in progress - waiting...');
      await waitForFullSync();
    } else {
      await runFullSync();
    }
    const fresh=await getCache('clients',true)||[];
    res.json({clients:await decorate(fresh),syncedAt:new Date().toISOString()});
  }catch(err){console.error('Error:',err.message);res.status(500).json({error:err.message});}
});

app.get('/api/clearremoved',async function(req,res){
  await pool.query('DELETE FROM removed');
  await setCache('clients',null);
  await setCache('students',null);
  console.log('Cleared all removed entries');
  res.json({ok:true,message:'All removed entries cleared'});
});
app.get('/api/unremove/:clientId',async function(req,res){
  await pool.query('DELETE FROM removed WHERE client_id=$1',[req.params.clientId]);
  console.log('Unremoved client:',req.params.clientId);
  res.json({ok:true});
});
app.post('/api/remove',async function(req,res){
  const clientId=req.body.clientId;
  const list=req.body.list||'clients';
  if(clientId){
    if(list==='students'){
      await addStudentRemoved(clientId);
      const cached=await getCache('students');
      if(cached)await setCache('students',cached.filter(function(c){return c.id!==clientId;}));
    } else if(list==='onboarding'){
      await addOnboardingRemoved(clientId);
      const cached=await getCache('onboarding');
      if(cached)await setCache('onboarding',cached.filter(function(c){return c.id!==clientId;}));
    } else {
      await addRemoved(clientId);
      const cached=await getCache('clients');
      if(cached)await setCache('clients',cached.filter(function(c){return c.id!==clientId;}));
    }
  }
  res.json({ok:true});
});
app.post('/api/onboarding-action',async function(req,res){
  const clientId=req.body.clientId;
  const tasks=req.body.tasks;
  if(clientId&&tasks!==undefined){
    await setOnboardingTasks(clientId,tasks);
    await touchLastAction(clientId);
    const now=new Date().toISOString();
    const cached=await getCache('onboarding');
    if(cached){
      const updated=cached.map(function(c){return c.id===clientId?Object.assign({},c,{tasks:tasks,lastAction:now}):c;});
      await setCache('onboarding',updated);
    }
    const cachedSO=await getCache('student-onboarding',true);
    if(cachedSO){
      const updatedSO=cachedSO.map(function(c){return c.id===clientId?Object.assign({},c,{tasks:tasks,lastAction:now}):c;});
      await setCache('student-onboarding',updatedSO);
    }
  }
  res.json({ok:true});
});
app.post('/api/status',async function(req,res){
  const clientId=req.body.clientId;
  const status=req.body.status||null;
  if(clientId){
    await setStatus(clientId,status);
    await touchLastAction(clientId);
    const cached=await getCache('clients');
    if(cached){
      const updated=cached.map(function(c){return c.id===clientId?Object.assign({},c,{manualStatus:status}):c;});
      await setCache('clients',updated);
    }
    const cachedStudents=await getCache('students');
    if(cachedStudents){
      var programs=(status&&status.indexOf('programs_')===0)?status.slice(9).split(',').filter(Boolean):[];
      const updatedStudents=cachedStudents.map(function(c){return c.id===clientId?Object.assign({},c,{programs:programs}):c;});
      await setCache('students',updatedStudents);
    }
  }
  res.json({ok:true});
});
app.post('/api/action',async function(req,res){
  const clientId=req.body.clientId;
  const tasks=req.body.tasks;
  if(clientId&&tasks!==undefined){
    await setTasks(clientId,tasks);
    await touchLastAction(clientId);
    const cached=await getCache('clients');
    if(cached){
      const updated=cached.map(function(c){return c.id===clientId?Object.assign({},c,{tasks:tasks,lastAction:new Date().toISOString()}):c;});
      await setCache('clients',updated);
    }
  }
  res.json({ok:true});
});


app.get('/api/students',async function(req,res){
  if(!API_KEY)return res.status(500).json({error:'SPLOSE_API_KEY not set'});
  const fullSync=req.query.full==='true';
  try{
    const allTasks=await getTasks();
    const allStatuses=await getStatuses();
    const allLastActions=await getLastActions();
    function programsFor(id){
      var s=allStatuses[id];
      if(s&&s.indexOf('programs_')===0)return s.slice(9).split(',').filter(Boolean);
      return [];
    }
    async function decorate(list){
      const removedStudents=await getStudentRemoved();
      return list.filter(function(c){return !removedStudents.has(c.id);}).map(function(c){return Object.assign({},c,{tasks:allTasks[c.id]||c.tasks||[],programs:programsFor(c.id),lastAction:allLastActions[c.id]||null});});
    }
    if(!fullSync){
      const cached=await getCache('students');
      if(cached&&cached.length>0){
        console.log('Serving '+cached.length+' students from cache');
        return res.json({students:await decorate(cached),syncedAt:new Date().toISOString(),fromCache:true});
      }
    }
    if(syncLock.active){
      console.log('Sync already in progress - waiting...');
      await waitForFullSync();
    } else {
      await runFullSync();
    }
    const fresh=await getCache('students',true)||[];
    res.json({students:await decorate(fresh),syncedAt:new Date().toISOString()});
  }catch(err){console.error('Error:',err.message);res.status(500).json({error:err.message});}
});


app.get('/api/onboarding',async function(req,res){
  if(!API_KEY)return res.status(500).json({error:'SPLOSE_API_KEY not set'});
  const fullSync=req.query.full==='true';
  try{
    const allTasks=await getOnboardingTasks();
    const onboardingRemovedSet=await getOnboardingRemoved();
    async function decorate(list){
      return list.filter(function(c){return !onboardingRemovedSet.has(c.id);}).map(function(c){return Object.assign({},c,{tasks:allTasks[c.id]||c.tasks||[]});});
    }
    if(!fullSync){
      const cached=await getCache('onboarding');
      if(cached){
        return res.json({clients:await decorate(cached),syncedAt:new Date().toISOString(),fromCache:true});
      }
    }
    if(syncLock.active){
      console.log('Sync already in progress - waiting...');
      await waitForFullSync();
    } else {
      await runFullSync();
    }
    const fresh=await getCache('onboarding',true)||[];
    res.json({clients:await decorate(fresh),syncedAt:new Date().toISOString()});
  }catch(err){console.error('Error:',err.message);res.status(500).json({error:err.message});}
});


app.post('/api/onboarding/add',async function(req,res){
  const{name}=req.body;
  if(!name)return res.status(400).json({error:'Name required'});
  try{
    const id='ob_'+require('crypto').randomBytes(8).toString('hex');
    const DT=[{id:'ob1',assignee:'Annie',n:'Contact card sent to Felicity',done:false},{id:'ob2',assignee:'Annie',n:'Registration',done:false},{id:'ob3',assignee:'Annie',n:'Consent',done:false},{id:'ob4',assignee:'Annie',n:'Safety Checklist if Home',done:false},{id:'ob5',assignee:'Annie',n:'Address to consult if home',done:false},{id:'ob6',assignee:'Annie',n:'DOB and Medicare (if applicable) added',done:false},{id:'ob7',assignee:'Annie',n:'Joined Circle',done:false},{id:'ob8',assignee:'Annie',n:'Circle chat opened and welcome message sent',done:false}];
    const tasks=DT.map(function(t){return Object.assign({},t,{id:t.id+'_'+id});});
    const newClient={id:id,name:name,firstAppt:new Date().toISOString().split('T')[0],tasks:tasks,manual:true};
    const cached=await getCache('onboarding',true)||[];
    await setCache('onboarding',[...cached,newClient]);
    res.json({ok:true,client:newClient});
  }catch(err){res.status(500).json({error:err.message});}
});

// Get chat link for a client
app.get('/api/chat-link/:clientId',async function(req,res){
  const token=await getOrCreateToken(req.params.clientId);
  const base=process.env.APP_URL||'https://splose-tracker.onrender.com';
  res.json({url:base+'/chat/'+token});
});

// Check PIN status / verify PIN
app.post('/api/chat/verify',async function(req,res){
  const{token,pin}=req.body;
  const r=await pool.query('SELECT client_id,pin_hash FROM chat_tokens WHERE token=$1',[token]);
  if(!r.rows.length)return res.status(404).json({error:'Invalid link'});
  if(!r.rows[0].pin_hash)return res.json({needsSetup:true});
  if(r.rows[0].pin_hash!==hashPin(pin))return res.status(401).json({error:'Wrong PIN. Try again.'});
  res.json({ok:true,clientId:r.rows[0].client_id});
});

// Set PIN (first time)
app.post('/api/chat/setup',async function(req,res){
  const{token,pin}=req.body;
  if(!token||!pin||pin.length<4)return res.status(400).json({error:'PIN must be 4 digits'});
  const r=await pool.query('SELECT client_id,pin_hash FROM chat_tokens WHERE token=$1',[token]);
  if(!r.rows.length)return res.status(404).json({error:'Invalid link'});
  if(r.rows[0].pin_hash)return res.status(400).json({error:'PIN already set'});
  await pool.query('UPDATE chat_tokens SET pin_hash=$1 WHERE token=$2',[hashPin(pin),token]);
  res.json({ok:true,clientId:r.rows[0].client_id});
});

// Get messages
app.get('/api/chat/messages/:token',async function(req,res){
  const r=await pool.query('SELECT client_id FROM chat_tokens WHERE token=$1',[req.params.token]);
  if(!r.rows.length)return res.status(404).json({error:'Invalid'});
  const msgs=await pool.query('SELECT id,from_type,body,created_at FROM messages WHERE client_id=$1 ORDER BY created_at ASC',[r.rows[0].client_id]);
  await pool.query('UPDATE chat_tokens SET last_read=NOW() WHERE token=$1',[req.params.token]);
  res.json({messages:msgs.rows,clientId:r.rows[0].client_id});
});

// Send message as client
app.post('/api/chat/send',async function(req,res){
  const{token,pin,body}=req.body;
  if(!body||!body.trim())return res.status(400).json({error:'Empty message'});
  const r=await pool.query('SELECT client_id,pin_hash FROM chat_tokens WHERE token=$1',[token]);
  if(!r.rows.length)return res.status(404).json({error:'Invalid'});
  if(r.rows[0].pin_hash!==hashPin(pin))return res.status(401).json({error:'Wrong PIN'});
  await pool.query('INSERT INTO messages(client_id,from_type,body) VALUES($1,$2,$3)',[r.rows[0].client_id,'client',body.trim()]);
  res.json({ok:true});
});

// Send message as practitioner
app.post('/api/chat/reply',async function(req,res){
  const{clientId,body}=req.body;
  if(!body||!body.trim())return res.status(400).json({error:'Empty message'});
  await pool.query('INSERT INTO messages(client_id,from_type,body) VALUES($1,$2,$3)',[clientId,'practitioner',body.trim()]);
  res.json({ok:true});
});

// Get all conversations for practitioner
app.get('/api/chat/conversations',async function(req,res){
  const r=await pool.query(`
    SELECT ct.client_id,
    m.body as last_message, m.from_type as last_from, m.created_at as last_time,
    (SELECT COUNT(*) FROM messages m2 WHERE m2.client_id=ct.client_id AND m2.from_type='client' AND (ct.last_read IS NULL OR m2.created_at>ct.last_read)) as unread
    FROM chat_tokens ct
    LEFT JOIN LATERAL (SELECT body,from_type,created_at FROM messages WHERE client_id=ct.client_id ORDER BY created_at DESC LIMIT 1) m ON true
    ORDER BY m.created_at DESC NULLS LAST
  `);
  res.json({conversations:r.rows});
});

// Get messages for practitioner (by clientId)
app.get('/api/chat/thread/:clientId',async function(req,res){
  const msgs=await pool.query('SELECT id,from_type,body,created_at FROM messages WHERE client_id=$1 ORDER BY created_at ASC',[req.params.clientId]);
  await pool.query('UPDATE chat_tokens SET last_read=NOW() WHERE client_id=$1',[req.params.clientId]);
  res.json({messages:msgs.rows});
});


app.get('/api/student-onboarding',async function(req,res){
  try{
    const allTasks=await getOnboardingTasks();
    const removedSet=await getOnboardingRemoved();
    const cached=await getCache('student-onboarding',true)||[];
    const students=cached.filter(function(c){return !removedSet.has(c.id);}).map(function(c){return Object.assign({},c,{tasks:allTasks[c.id]||c.tasks||[]});});
    res.json({clients:students,syncedAt:new Date().toISOString()});
  }catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/students-list',async function(req,res){
  try{
    const cached=await getCache('students')||[];
    res.json({students:cached.map(function(s){return {id:s.id,name:s.name};})});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/student-onboarding/add',async function(req,res){
  const{name,program}=req.body;
  if(!name)return res.status(400).json({error:'Name required'});
  try{
    const id='so_'+require('crypto').randomBytes(8).toString('hex');
    const DEFAULT_TASKS=[
      {id:'so1_'+id,a:'Annie',n:"T's & C's Sent",done:false},
      {id:'so2_'+id,a:'Annie',n:"T's & C's Signed",done:false},
      {id:'so3_'+id,a:'Annie',n:'Deposit Invoice sent',done:false},
      {id:'so4_'+id,a:'Annie',n:'Deposit Paid',done:false},
      {id:'so5_'+id,a:'Annie',n:'Signed Mentor Agreement & Application Email sent',done:false},
      {id:'so6_'+id,a:'Annie',n:'Application successful',done:false},
      {id:'so7_'+id,a:'Annie',n:'Circle invite sent',done:false},
      {id:'so8_'+id,a:'Annie',n:'Circle Released',done:false},
      {id:'so9_'+id,a:'Annie',n:'Welcome Direct message sent on Circle',done:false},
      {id:'so10_'+id,a:'Annie',n:'Emailed FH to confirm they are in',done:false},
      {id:'so11_'+id,a:'Annie',n:'Added to 2122',done:false}
    ];
    const newStudent={id:id,name:name,program:program||null,firstAppt:new Date().toISOString().split('T')[0],tasks:DEFAULT_TASKS};
    const cached=await getCache('student-onboarding',true)||[];
    await setCache('student-onboarding',[...cached,newStudent]);
    res.json({ok:true,student:newStudent});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/student-onboarding/complete',async function(req,res){
  const{clientId}=req.body;
  if(!clientId)return res.status(400).json({error:'clientId required'});
  try{
    // Remove from onboarding
    await addOnboardingRemoved(clientId);
    const cached=await getCache('student-onboarding',true)||[];
    const student=cached.find(function(c){return c.id===clientId;});
    await setCache('student-onboarding',cached.filter(function(c){return c.id!==clientId;}));
    // Add to students list if not already there
    if(student){
      const studentCache=await getCache('students')||[];
      const exists=studentCache.find(function(c){return c.name===student.name;});
      if(!exists){
        const newStudent={id:clientId,name:student.name,practitioner:'',appointments:[],tasks:[],program:student.program};
        await setCache('students',[...studentCache,newStudent]);
      }
    }
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});


app.post('/api/student-onboarding/program',async function(req,res){
  const{clientId,program}=req.body;
  if(!clientId)return res.status(400).json({error:'clientId required'});
  try{
    const cached=await getCache('student-onboarding');
    if(cached){
      const updated=cached.map(function(c){return c.id===clientId?Object.assign({},c,{program:program}):c;});
      await setCache('student-onboarding',updated);
    }
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

app.listen(process.env.PORT||3000,async function(){
  await initDB();
  console.log('Splose Tracker running at http://localhost:'+(process.env.PORT||3000));
});
