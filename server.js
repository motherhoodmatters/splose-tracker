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
  console.log('DB ready');
}

async function getCache(key){
  const r=await pool.query('SELECT value FROM cache WHERE key=$1',[key]);
  return r.rows.length?JSON.parse(r.rows[0].value):null;
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

function wait(ms){return new Promise(r=>setTimeout(r,ms));}
async function allPages(ep,params){
  params=params||{};
  const results=[];
  const qs=new URLSearchParams(params).toString();
  let url=BASE+ep+(qs?'?'+qs:'');
  while(url){
    const res=await fetch(url,{headers:HEADERS});
    if(res.status===429){console.log('Rate limited...');await wait(3000);continue;}
    if(res.status>=400){throw new Error('Splose '+res.status);}
    const body=await res.json();
    results.push.apply(results,body.data||[]);
    const next=body.links&&body.links.nextPage;
    url=next?'https://api.splose.com'+next:null;
    if(url)await wait(400);
  }
  return results;
}

app.use(express.static(path.join(__dirname,'public')));

app.get('/api/clients',async function(req,res){
  if(!API_KEY)return res.status(500).json({error:'SPLOSE_API_KEY not set'});
  const fullSync=req.query.full==='true';
  try{
    const allTasks=await getTasks();const allStatuses=await getStatuses();const removedMap=await getRemoved();const studentRemovedSet=await getStudentRemoved();
    if(!fullSync){
      const cached=await getCache('clients');
      if(cached&&cached.length>0){
        console.log('Serving '+cached.length+' clients from DB cache');
        const clients=cached.filter(function(c){return !removedMap[c.id];}).map(function(c){return Object.assign({},c,{tasks:allTasks[c.id]||c.tasks||[],manualStatus:allStatuses[c.id]||null});});
        return res.json({clients:clients,syncedAt:new Date().toISOString(),fromCache:true});
      }
    }
    console.log('Full sync starting...');
    const pracs=await allPages('/practitioners').catch(function(){return [];});
    const pnames={};
    pracs.forEach(function(p){pnames[p.id]=((p.firstname||'')+' '+(p.lastname||'')).trim();});
    const patients=await allPages('/patients');
    console.log(patients.length+' patients');
    const clients=[];
    for(var i=0;i<patients.length;i++){
      const p=patients[i];
      const name=((p.firstname||'')+' '+(p.lastname||'')).trim()||'Patient '+p.id;
      console.log('Patient '+(i+1)+'/'+patients.length+': '+name);
      const appts=await allPages('/appointments',{patientId:p.id});
      await wait(500);
      const realAppts=appts.filter(function(a){return a.start&&Number(a.serviceId)!==CHECKIN_ID;});
      const hasRecent=realAppts.some(function(a){return a.start>='2026-04-01';});
      if(!hasRecent){console.log('  skipping');continue;}
      
      // Skip if all appointments are student/mentoring services
      const hasNonStudentAppt=appts.some(function(a){return !STUDENT_IDS.has(Number(a.serviceId))&&Number(a.serviceId)!==CHECKIN_ID;});
      if(!hasNonStudentAppt){console.log('  skipping - student only');continue;}
      // Auto-restore if removed client has new appointment after removal date
      const removedAt=removedMap[String(p.id)];
      if(removedAt){
        const hasNewAppt=realAppts.some(function(a){return new Date(a.start)>new Date(removedAt);});
        if(hasNewAppt){
          console.log('  restoring - new appointment after removal');
          await pool.query('DELETE FROM removed WHERE client_id=$1',[String(p.id)]);
          delete removedMap[String(p.id)];
        } else {
          console.log('  skipping - removed and no new appointments');
          continue;
        }
      }
      const sorted=appts.filter(function(a){return !!a.start;}).sort(function(a,b){return new Date(b.start)-new Date(a.start);});
      const lastReal=sorted.find(function(a){return Number(a.serviceId)!==CHECKIN_ID;});
      clients.push({id:String(p.id),name:name,practitioner:pnames[p.practitionerId]||'',lastRealAppt:lastReal?lastReal.start.split('T')[0]:null,appointments:sorted.map(function(a){return {id:String(a.id),date:a.start.split('T')[0],serviceId:a.serviceId,isCheckin:Number(a.serviceId)===CHECKIN_ID};}),tasks:allTasks[String(p.id)]||allTasks[p.id]||[],manualStatus:allStatuses[String(p.id)]||null});
    }
    const finalClients=clients.filter(function(c){return !removedMap[c.id];});await setCache('clients',finalClients);
    console.log('DONE! '+finalClients.length+' clients');
    res.json({clients:finalClients,syncedAt:new Date().toISOString()});
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
    const cached=await getCache('onboarding');
    if(cached){
      const updated=cached.map(function(c){return c.id===clientId?Object.assign({},c,{tasks:tasks}):c;});
      await setCache('onboarding',updated);
    }
  }
  res.json({ok:true});
});
app.post('/api/status',async function(req,res){
  const clientId=req.body.clientId;
  const status=req.body.status||null;
  if(clientId){
    await setStatus(clientId,status);
    const cached=await getCache('clients');
    if(cached){
      const updated=cached.map(function(c){return c.id===clientId?Object.assign({},c,{manualStatus:status}):c;});
      await setCache('clients',updated);
    }
  }
  res.json({ok:true});
});
app.post('/api/action',async function(req,res){
  const clientId=req.body.clientId;
  const tasks=req.body.tasks;
  if(clientId&&tasks!==undefined){
    await setTasks(clientId,tasks);
    const cached=await getCache('clients');
    if(cached){
      const updated=cached.map(function(c){return c.id===clientId?Object.assign({},c,{tasks:tasks}):c;});
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
    if(!fullSync){
      const cached=await getCache('students');
      if(cached&&cached.length>0){
        console.log('Serving '+cached.length+' students from cache');
        const removedStudents=await getStudentRemoved();
        const students=cached.filter(function(c){return !removedStudents.has(c.id);}).map(function(c){return Object.assign({},c,{tasks:allTasks[c.id]||c.tasks||[]});});
        return res.json({students:students,syncedAt:new Date().toISOString(),fromCache:true});
      }
    }
    console.log('Full student sync starting...');
    const studentRemovedRows=await pool.query('SELECT client_id,removed_at FROM removed_students');
    const studentRemovedMap={};
    studentRemovedRows.rows.forEach(function(r){studentRemovedMap[r.client_id]=r.removed_at;});
    const pracs=await allPages('/practitioners').catch(function(){return [];});
    const pnames={};
    pracs.forEach(function(p){pnames[p.id]=((p.firstname||'')+' '+(p.lastname||'')).trim();});
    const patients=await allPages('/patients');
    console.log(patients.length+' patients to check for students');
    const MENTORING_IDS=new Set([399651,399621,415863,416098,416099,416100,416101,416173,425885,437283]);
    const INTERACTION_IDS=new Set([399651,399621,399669]);
    const students=[];
    for(var i=0;i<patients.length;i++){
      const p=patients[i];
      const name=((p.firstname||'')+' '+(p.lastname||'')).trim()||'Patient '+p.id;
      const appts=await allPages('/appointments',{patientId:p.id});
      await wait(500);
      const mentoringAppts=appts.filter(function(a){return a.start&&MENTORING_IDS.has(Number(a.serviceId));});
      if(!mentoringAppts.length)continue;
      const studentRemovedAt=studentRemovedMap?studentRemovedMap[String(p.id)]:null;
      if(studentRemovedAt){
        const hasNewAppt=mentoringAppts.some(function(a){return new Date(a.start)>new Date(studentRemovedAt);});
        if(hasNewAppt){
          await pool.query('DELETE FROM removed_students WHERE client_id=$1',[String(p.id)]);
        } else {
          continue;
        }
      }
      console.log('Student found: '+name);
      const interactions=mentoringAppts
        .filter(function(a){return INTERACTION_IDS.has(Number(a.serviceId));})
        .sort(function(a,b){return new Date(b.start)-new Date(a.start);});
      students.push({
        id:String(p.id),
        name:name,
        practitioner:pnames[p.practitionerId]||'',
        appointments:interactions.map(function(a){return {id:String(a.id),date:a.start.split('T')[0],serviceId:a.serviceId,isCheckin:Number(a.serviceId)===399669};}),
        tasks:allTasks[String(p.id)]||[]
      });
    }
    await setCache('students',students);
    console.log('DONE! '+students.length+' students');
    res.json({students:students,syncedAt:new Date().toISOString()});
  }catch(err){console.error('Error:',err.message);res.status(500).json({error:err.message});}
});


app.get('/api/onboarding',async function(req,res){
  if(!API_KEY)return res.status(500).json({error:'SPLOSE_API_KEY not set'});
  try{
    const allTasks=await getOnboardingTasks();
    const onboardingRemovedSet=await getOnboardingRemoved();
    const cached=await getCache('onboarding');
    if(cached){
      const clients=cached.filter(function(c){return !onboardingRemovedSet.has(c.id);}).map(function(c){return Object.assign({},c,{tasks:allTasks[c.id]||c.tasks||[]});});
      return res.json({clients:clients,syncedAt:new Date().toISOString(),fromCache:true});
    }
    const pracs=await allPages('/practitioners').catch(function(){return [];});
    const pnames={};
    pracs.forEach(function(p){pnames[p.id]=((p.firstname||'')+' '+(p.lastname||'')).trim();});
    const patients=await allPages('/patients');
    const DT=[{id:'ob1',assignee:'Annie',n:'Contact card sent to Felicity',done:false},{id:'ob2',assignee:'Annie',n:'Registration',done:false},{id:'ob3',assignee:'Annie',n:'Consent',done:false},{id:'ob4',assignee:'Annie',n:'Safety Checklist if Home',done:false},{id:'ob5',assignee:'Annie',n:'Address to consult if home',done:false},{id:'ob6',assignee:'Annie',n:'DOB and Medicare (if applicable) added',done:false},{id:'ob7',assignee:'Annie',n:'Joined Circle',done:false},{id:'ob8',assignee:'Annie',n:'Circle chat opened and welcome message sent',done:false}];
    const clients=[];
    for(var i=0;i<patients.length;i++){
      const p=patients[i];
      const name=((p.firstname||'')+ ' '+(p.lastname||'')).trim()||'Patient '+p.id;
      const appts=await allPages('/appointments',{patientId:p.id});
      await wait(500);
      if(!appts.length)continue;
      const sorted=appts.filter(function(a){return !!a.start;}).sort(function(a,b){return new Date(a.start)-new Date(b.start);});
      const firstAppt=sorted[0];
      if(!firstAppt||firstAppt.start<'2026-06-04')continue;
      if(onboardingRemovedSet.has(String(p.id)))continue;
      const existingTasks=allTasks[String(p.id)];
      const tasks=existingTasks||DT.map(function(t){return Object.assign({},t,{id:t.id+'_'+p.id});});
      clients.push({id:String(p.id),name:name,practitioner:pnames[p.practitionerId]||'',firstAppt:firstAppt.start.split('T')[0],tasks:tasks});
    }
    await setCache('onboarding',clients);
    console.log('DONE onboarding: '+clients.length+' clients');
    res.json({clients:clients,syncedAt:new Date().toISOString()});
  }catch(err){console.error('Error:',err.message);res.status(500).json({error:err.message});}
});

app.listen(process.env.PORT||3000,async function(){
  await initDB();
  console.log('Splose Tracker running at http://localhost:'+(process.env.PORT||3000));
});
