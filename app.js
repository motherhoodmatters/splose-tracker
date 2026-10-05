const express=require('express'),path=require('path');
const D=require('./lib/derive');

// createApp builds the whole tracker around an injected database pool and
// fetch, so the real server and the automated tests run exactly the same code.
function createApp(deps){
  const pool=deps.pool;
  const fetchFn=deps.fetch||fetch;
  const API_KEY=deps.apiKey!==undefined?deps.apiKey:(process.env.SPLOSE_API_KEY||'');
  const BASE=deps.base||'https://api.splose.com/v1';
  const ORIGIN=new URL(BASE).origin;
  const sleep=deps.sleep||function(ms){return new Promise(function(r){setTimeout(r,ms);});};
  const now=deps.now||function(){return Date.now();};
  const log=deps.log||function(){console.log.apply(console,arguments);};
  const cfg=Object.assign({
    apptGapMs:700,      // pause between per-patient appointment fetches
    pageGapMs:400,      // pause between pages of one list
    maxRetries:8,       // 429 retries before giving up on this cycle
    backoffMs:3000,
    cycleMs:10*60*1000, // background cycle every 10 minutes
    hotMaxAgeMs:20*60*1000, // refresh recently-active patients at least this often
    hotDays:45,         // "recently active" = appointment within this many days (or any future one)
    rollingBatch:60,    // plus this many of the longest-unrefreshed other patients each cycle
    nudgeMinGapMs:3*60*1000 // a page load may start a cycle if none ran in this long
  },deps.config||{});
  const HEADERS={'Authorization':'Bearer '+API_KEY,'User-Agent':'splose-tracker/1.0','Content-Type':'application/json'};

  const app=express();
  app.use(express.json());

  // ---------------------------------------------------------------- database
  async function initDB(){
    const q=function(s){return pool.query(s);};
    await q(`CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,value TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS tasks(client_id TEXT PRIMARY KEY,data TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS statuses(client_id TEXT PRIMARY KEY,status TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS removed(client_id TEXT PRIMARY KEY,removed_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`ALTER TABLE removed ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ DEFAULT NOW()`);
    await q(`CREATE TABLE IF NOT EXISTS removed_students(client_id TEXT PRIMARY KEY,removed_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS removed_onboarding(client_id TEXT PRIMARY KEY,removed_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS onboarding_tasks(client_id TEXT PRIMARY KEY,data TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS followup_overrides(client_id TEXT PRIMARY KEY,days INTEGER,updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS last_actions(client_id TEXT PRIMARY KEY,updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS student_phone(client_id TEXT PRIMARY KEY,phone TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`ALTER TABLE removed ADD COLUMN IF NOT EXISTS known_appt_ids TEXT`);
    await q(`ALTER TABLE removed_students ADD COLUMN IF NOT EXISTS known_appt_ids TEXT`);
    // Permanent exclusion for patients who aren't Felicity's client at all.
    await q(`CREATE TABLE IF NOT EXISTS not_my_client(client_id TEXT PRIMARY KEY,added_at TIMESTAMPTZ DEFAULT NOW())`);
    // NEW: what Splose last told us about each patient. Written one patient at
    // a time by the sync, so an interrupted sync never loses what it already got.
    await q(`CREATE TABLE IF NOT EXISTS patient_snapshots(client_id TEXT PRIMARY KEY,name TEXT,practitioner TEXT,mobile TEXT,appointments TEXT,appts_synced_at TIMESTAMPTZ,meta_updated_at TIMESTAMPTZ DEFAULT NOW())`);
    // NEW: things entered by hand (list = 'onboarding' or 'clients'). The sync never touches this table.
    await q(`CREATE TABLE IF NOT EXISTS manual_entries(list TEXT,client_id TEXT,data TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(list,client_id))`);
    // NEW: new students whose Student Onboarding has been completed (or who were removed from it on purpose).
    await q(`CREATE TABLE IF NOT EXISTS student_onboarding_done(client_id TEXT PRIMARY KEY,done_at TIMESTAMPTZ DEFAULT NOW())`);
    // NEW: sync bookkeeping (last success, last error) so the app can report its own health honestly.
    await q(`CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await migrateLegacyManual();
    log('DB ready');
  }
  // Exposed so tests can simulate a restart without re-running table creation.
  const migrate=migrateLegacyManual;

  // One-off, repeatable-safely copy of hand-entered people out of the old
  // cache into manual_entries (INSERT ... DO NOTHING; the old cache is left
  // exactly as it was, nothing is deleted).
  async function migrateLegacyManual(){
    const ob=(await getCache('onboarding'))||[];
    for(const o of ob){
      if(o&&(o.manual||/^ob_/.test(String(o.id)))){
        await pool.query('INSERT INTO manual_entries(list,client_id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',['onboarding',String(o.id),JSON.stringify(o)]);
      }
    }
    const cl=(await getCache('clients'))||[];
    for(const c of cl){
      if(c&&/^(ob|so)_/.test(String(c.id))){
        await pool.query('INSERT INTO manual_entries(list,client_id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',['clients',String(c.id),JSON.stringify(c)]);
      }
    }
  }

  async function getCache(key){
    const r=await pool.query('SELECT value FROM cache WHERE key=$1',[key]);
    if(!r.rows.length||r.rows[0].value===null)return null;
    try{return JSON.parse(r.rows[0].value);}catch(e){return null;}
  }
  async function setCache(key,value){
    await pool.query('INSERT INTO cache(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()',[key,JSON.stringify(value)]);
  }
  async function getState(key){
    const r=await pool.query('SELECT value FROM sync_state WHERE key=$1',[key]);
    if(!r.rows.length)return null;
    try{return JSON.parse(r.rows[0].value);}catch(e){return null;}
  }
  async function setState(key,value){
    await pool.query('INSERT INTO sync_state(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()',[key,JSON.stringify(value)]);
  }

  async function getJsonMap(table,col){
    const r=await pool.query('SELECT client_id,'+col+' FROM '+table);
    const out={};
    r.rows.forEach(function(row){try{out[row.client_id]=JSON.parse(row[col]);}catch(e){}});
    return out;
  }
  const getTasks=function(){return getJsonMap('tasks','data');};
  const getOnboardingTasks=function(){return getJsonMap('onboarding_tasks','data');};
  async function setTasks(clientId,tasks){
    await pool.query('INSERT INTO tasks(client_id,data,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(client_id) DO UPDATE SET data=$2,updated_at=NOW()',[clientId,JSON.stringify(tasks)]);
  }
  async function setOnboardingTasks(clientId,tasks){
    await pool.query('INSERT INTO onboarding_tasks(client_id,data,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(client_id) DO UPDATE SET data=$2,updated_at=NOW()',[clientId,JSON.stringify(tasks)]);
  }
  async function getRemoved(){
    const r=await pool.query('SELECT client_id,removed_at,known_appt_ids FROM removed');
    const out={};
    r.rows.forEach(function(row){out[row.client_id]={at:row.removed_at,ids:row.known_appt_ids?JSON.parse(row.known_appt_ids):[]};});
    return out;
  }
  async function getStudentRemovedMap(){
    const r=await pool.query('SELECT client_id,removed_at,known_appt_ids FROM removed_students');
    const out={};
    r.rows.forEach(function(row){out[row.client_id]={at:row.removed_at,ids:row.known_appt_ids?JSON.parse(row.known_appt_ids):[]};});
    return out;
  }
  async function addStudentRemoved(clientId,knownApptIds){
    await pool.query('INSERT INTO removed_students(client_id,removed_at,known_appt_ids) VALUES($1,NOW(),$2) ON CONFLICT(client_id) DO UPDATE SET removed_at=NOW(),known_appt_ids=$2',[clientId,JSON.stringify(knownApptIds||[])]);
  }
  async function getIdSet(table){
    const r=await pool.query('SELECT client_id FROM '+table);
    return new Set(r.rows.map(function(row){return row.client_id;}));
  }
  const getOnboardingRemoved=function(){return getIdSet('removed_onboarding');};
  const getNotMyClient=function(){return getIdSet('not_my_client');};
  async function addOnboardingRemoved(clientId){
    await pool.query('INSERT INTO removed_onboarding(client_id) VALUES($1) ON CONFLICT DO NOTHING',[clientId]);
  }
  async function addNotMyClient(clientId){
    await pool.query('INSERT INTO not_my_client(client_id) VALUES($1) ON CONFLICT DO NOTHING',[clientId]);
  }
  // Re-removing re-snapshots the appointments on the books right now.
  async function addRemoved(clientId,knownApptIds){
    await pool.query('INSERT INTO removed(client_id,removed_at,updated_at,known_appt_ids) VALUES($1,NOW(),NOW(),$2) ON CONFLICT(client_id) DO UPDATE SET removed_at=NOW(),updated_at=NOW(),known_appt_ids=$2',[clientId,JSON.stringify(knownApptIds||[])]);
  }
  async function getStatuses(){
    const r=await pool.query('SELECT client_id,status FROM statuses');
    const out={};
    r.rows.forEach(function(row){out[row.client_id]=row.status;});
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
  async function getStudentPhones(){
    const r=await pool.query('SELECT client_id,phone FROM student_phone');
    const out={};
    r.rows.forEach(function(row){out[row.client_id]=row.phone;});
    return out;
  }
  async function setStudentPhone(clientId,phone){
    if(phone===null||phone===undefined||phone===''){
      await pool.query('DELETE FROM student_phone WHERE client_id=$1',[clientId]);
    }else{
      await pool.query('INSERT INTO student_phone(client_id,phone,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(client_id) DO UPDATE SET phone=$2,updated_at=NOW()',[clientId,phone]);
    }
  }
  async function getManual(list){
    const r=await pool.query('SELECT client_id,data FROM manual_entries WHERE list=$1 ORDER BY created_at',[list]);
    const out=[];
    r.rows.forEach(function(row){try{const o=JSON.parse(row.data);o.id=String(row.client_id);out.push(o);}catch(e){}});
    return out;
  }
  async function addManual(list,entry){
    await pool.query('INSERT INTO manual_entries(list,client_id,data) VALUES($1,$2,$3) ON CONFLICT(list,client_id) DO NOTHING',[list,String(entry.id),JSON.stringify(entry)]);
  }
  async function loadSnapshots(){
    const r=await pool.query('SELECT client_id,name,practitioner,mobile,appointments,appts_synced_at FROM patient_snapshots');
    return r.rows.map(function(row){
      var appts=[];try{appts=row.appointments?JSON.parse(row.appointments):[];}catch(e){}
      return {id:String(row.client_id),name:row.name,practitioner:row.practitioner,mobile:row.mobile,appointments:appts,apptsSyncedAt:row.appts_synced_at?new Date(row.appts_synced_at).getTime():null};
    });
  }

  // Everything the rules need, loaded fresh. Never cached, never written.
  async function loadContext(){
    const results=await Promise.all([loadSnapshots(),getRemoved(),getStudentRemovedMap(),getOnboardingRemoved(),getNotMyClient(),getTasks(),getStatuses(),getFollowupOverrides(),getLastActions(),getStudentPhones(),getOnboardingTasks(),getManual('onboarding'),getManual('clients'),getCache('clients'),getCache('students'),getCache('onboarding'),getIdSet('student_onboarding_done'),getCache('students_manual'),getCache('student-onboarding'),getState('student_onboarding_start')]);
    return {snapshots:results[0],removedClients:results[1],removedStudents:results[2],onboardingRemoved:results[3],notMyClient:results[4],tasks:results[5],statuses:results[6],overrides:results[7],lastActions:results[8],phones:results[9],onboardingTasks:results[10],manual:{onboarding:results[11],clients:results[12]},legacy:{clients:results[13]||[],students:results[14]||[],onboarding:results[15]||[]},studentOnboardingDone:results[16],studentManualNames:new Set((results[17]||[]).map(function(m){return D.normName(m.name);})),studentOnboardingManual:results[18]||[],studentOnboardingStart:results[19]&&results[19].date?results[19].date:null};
  }
  async function lists(){return D.deriveAll(await loadContext());}

  // --------------------------------------------------------- Splose requests
  async function allPages(ep,params){
    params=params||{};
    const results=[];
    const qs=new URLSearchParams(params).toString();
    let url=BASE+ep+(qs?'?'+qs:'');
    let retries=0;
    while(url){
      const res=await fetchFn(url,{headers:HEADERS});
      if(res.status===429){
        retries++;
        if(retries>cfg.maxRetries){const e=new Error('Splose rate limit - giving up after '+cfg.maxRetries+' retries');e.rateLimited=true;throw e;}
        const backoff=cfg.backoffMs*retries;
        log('Rate limited... retry '+retries+'/'+cfg.maxRetries+', waiting '+backoff+'ms');
        await sleep(backoff);
        continue;
      }
      retries=0;
      if(res.status>=400){throw new Error('Splose '+res.status);}
      const body=await res.json();
      results.push.apply(results,body.data||[]);
      const next=body.links&&body.links.nextPage;
      url=next?ORIGIN+next:null;
      if(url)await sleep(cfg.pageGapMs);
    }
    return results;
  }

  // Always fetches live so a removal snapshot reflects what is really booked;
  // falls back to the stored snapshot if Splose can't be reached.
  async function knownApptIdsFor(clientId){
    try{
      const live=await allPages('/appointments',{patientId:clientId});
      return live.filter(function(a){return a.start;}).map(function(a){return String(a.id);});
    }catch(e){
      log('Live appointment fetch failed for removal snapshot, using stored snapshot:',e.message);
      const r=await pool.query('SELECT appointments FROM patient_snapshots WHERE client_id=$1',[String(clientId)]);
      if(r.rows.length&&r.rows[0].appointments){try{return JSON.parse(r.rows[0].appointments).map(function(a){return String(a.id);});}catch(e2){}}
      return [];
    }
  }

  function mobileOf(p){
    if(!p.phoneNumbers||!p.phoneNumbers.length)return null;
    const m=p.phoneNumbers.find(function(ph){return ph.type==='Mobile'||ph.type==='mobile';});
    const chosen=m||p.phoneNumbers[0];
    return chosen?((chosen.code||'')+(chosen.phoneNumber||'')):null;
  }

  // ------------------------------------------------------------------- sync
  // One cycle: fetch the patient list (cheap), save any new patients at once,
  // then fetch appointments for - in this order - patients we have never
  // fetched (new clients land here within seconds), recently-active patients,
  // and a rolling slice of everyone else. Every patient is saved the moment
  // it is fetched, so a rate-limit stop halfway loses nothing and the next
  // cycle carries on. Nothing here ever writes the Clients/Students/Onboarding
  // lists - those are derived on read.
  const syncLock={active:false,startedAt:null};
  async function runCycle(reason){
    if(!API_KEY)return {skipped:'no api key'};
    if(syncLock.active)return {skipped:'already running'};
    syncLock.active=true;syncLock.startedAt=now();
    const stats={reason:reason||'scheduled',startedAt:new Date(now()).toISOString(),patients:0,newPatients:0,fetched:0,failed:0,stoppedEarly:false,error:null};
    try{
      await setState('last_started',{at:stats.startedAt});
      const pnames={};
      try{(await allPages('/practitioners')).forEach(function(p){pnames[p.id]=((p.firstname||'')+' '+(p.lastname||'')).trim();});}catch(e){log('Practitioner list failed (keeping stored names):',e.message);}
      const patientsRaw=await allPages('/patients');
      const seen=new Set();
      const patients=patientsRaw.filter(function(p){if(seen.has(String(p.id)))return false;seen.add(String(p.id));return true;});
      stats.patients=patients.length;
      if(patientsRaw.length-patients.length>0)log('  dropped '+(patientsRaw.length-patients.length)+' duplicate patient id(s) from Splose response');

      const existing={};
      (await pool.query('SELECT client_id,name,practitioner,mobile,appts_synced_at,appointments FROM patient_snapshots')).rows.forEach(function(r){existing[r.client_id]=r;});

      // Save/refresh patient details for everyone (cheap, no appointment calls).
      for(const p of patients){
        const id=String(p.id);
        const name=((p.firstname||'')+' '+(p.lastname||'')).trim()||'Patient '+p.id;
        const ex=existing[id];
        const prac=pnames[p.practitionerId]||(ex&&ex.practitioner)||'';
        const mob=mobileOf(p);
        if(!ex){
          await pool.query('INSERT INTO patient_snapshots(client_id,name,practitioner,mobile,appointments,appts_synced_at,meta_updated_at) VALUES($1,$2,$3,$4,NULL,NULL,NOW()) ON CONFLICT(client_id) DO NOTHING',[id,name,prac,mob]);
          existing[id]={client_id:id,name:name,practitioner:prac,mobile:mob,appts_synced_at:null,appointments:null};
          stats.newPatients++;
        }else if(ex.name!==name||ex.practitioner!==prac||ex.mobile!==mob){
          await pool.query('UPDATE patient_snapshots SET name=$2,practitioner=$3,mobile=$4,meta_updated_at=NOW() WHERE client_id=$1',[id,name,prac,mob]);
          ex.name=name;ex.practitioner=prac;ex.mobile=mob;
        }
      }

      // Work queue.
      const t=now();
      const hotCut=new Date(t-cfg.hotDays*86400000).toISOString().split('T')[0];
      const isHot=function(row){
        if(!row.appointments)return false;
        try{return JSON.parse(row.appointments).some(function(a){return a.start&&D.dateOf(a.start)>=hotCut;});}catch(e){return false;}
      };
      const syncedMs=function(row){return row.appts_synced_at?new Date(row.appts_synced_at).getTime():0;};
      const ids=patients.map(function(p){return String(p.id);});
      const never=ids.filter(function(id){return !existing[id].appts_synced_at;});
      const fetchedIds=ids.filter(function(id){return !!existing[id].appts_synced_at;}).sort(function(a,b){return syncedMs(existing[a])-syncedMs(existing[b]);});
      const hot=fetchedIds.filter(function(id){return isHot(existing[id])&&(t-syncedMs(existing[id]))>=cfg.hotMaxAgeMs;});
      const hotSet=new Set(hot);
      const rest=fetchedIds.filter(function(id){return !hotSet.has(id);}).slice(0,cfg.rollingBatch);
      const queue=never.concat(hot,rest);
      log('Sync cycle ('+stats.reason+'): '+patients.length+' patients, '+stats.newPatients+' new, queue '+queue.length+' ('+never.length+' never fetched, '+hot.length+' active, '+rest.length+' rolling)');

      const removedClients=await getRemoved();
      const removedStudents=await getStudentRemovedMap();
      for(const id of queue){
        var appts;
        try{
          appts=await allPages('/appointments',{patientId:id});
        }catch(e){
          if(e.rateLimited){stats.stoppedEarly=true;stats.error=e.message;log('  stopped early at '+stats.fetched+' fetched: '+e.message+' (everything fetched so far is saved)');break;}
          stats.failed++;log('  skipping patient '+id+': '+e.message);
          await sleep(cfg.apptGapMs);continue;
        }
        const slim=appts.filter(function(a){return a.start;}).map(function(a){return {id:String(a.id),start:a.start,serviceId:a.serviceId};});
        await pool.query('UPDATE patient_snapshots SET appointments=$2,appts_synced_at=NOW() WHERE client_id=$1',[id,JSON.stringify(slim)]);
        stats.fetched++;
        // A removed person returns only if a genuinely new appointment id appeared.
        const real=slim.filter(function(a){return Number(a.serviceId)!==D.CHECKIN_ID;});
        if(removedClients[id]&&D.hasNewAppt(real,removedClients[id].ids)){await pool.query('DELETE FROM removed WHERE client_id=$1',[id]);delete removedClients[id];}
        const mentoring=slim.filter(function(a){return D.MENTORING_IDS.has(Number(a.serviceId));});
        if(removedStudents[id]&&mentoring.length&&D.hasNewAppt(mentoring,removedStudents[id].ids)){await pool.query('DELETE FROM removed_students WHERE client_id=$1',[id]);delete removedStudents[id];}
        await sleep(cfg.apptGapMs);
      }
    }catch(e){
      stats.error=e.message;log('Sync cycle failed:',e.message);
    }finally{
      syncLock.active=false;
      stats.finishedAt=new Date(now()).toISOString();
      try{
        await setState('last_cycle',stats);
        if(!stats.error)await setState('last_ok',{at:stats.finishedAt,patients:stats.patients,fetched:stats.fetched});
      }catch(e){log('Could not record sync state:',e.message);}
    }
    return stats;
  }
  // A page load may start a cycle in the background, never waits for it.
  async function nudge(){
    if(cfg.nudgeEnabled===false||syncLock.active||!API_KEY)return;
    try{
      const s=await getState('last_started');
      if(!s||now()-new Date(s.at).getTime()>cfg.nudgeMinGapMs)runCycle('page load').catch(function(e){log('Background sync failed:',e.message);});
    }catch(e){}
  }
  async function health(){
    const ok=await getState('last_ok');const last=await getState('last_cycle');
    const c=await pool.query('SELECT COUNT(*) AS n, COUNT(appts_synced_at) AS f FROM patient_snapshots');
    return {syncing:syncLock.active,lastOkAt:ok?ok.at:null,lastError:last&&last.error?last.error:null,lastCycle:last||null,patients:Number(c.rows[0].n),withAppointments:Number(c.rows[0].f)};
  }
  async function syncedAt(){
    const ok=await getState('last_ok');
    return ok?ok.at:null;
  }

  // ------------------------------------------------------------- read routes
  app.use(express.static(path.join(__dirname,'public')));

  app.get('/api/clients',async function(req,res){
    try{
      if(req.query.full==='true'||req.query.refresh==='1')runCycle('manual').catch(function(e){log('Background sync failed:',e.message);});else nudge();
      const l=await lists();
      const h=await health();
      res.json({clients:l.clients,syncedAt:await syncedAt(),syncing:h.syncing,health:h});
    }catch(err){log('Error:',err.message);res.status(500).json({error:err.message});}
  });

  app.get('/api/students',async function(req,res){
    try{
      nudge();
      const l=await lists();
      const manual=(await getCache('students_manual'))||[];
      const removedStudents=new Set(Object.keys(await getStudentRemovedMap()));
      const statuses=await getStatuses();const tasks=await getTasks();const last=await getLastActions();const phones=await getStudentPhones();
      // Splose-derived students already honour removals (the rules handle
      // "removed unless a new appointment appeared"); hand-entered ones are
      // filtered here.
      const merged=l.students.concat(manual.filter(function(m){return !removedStudents.has(m.id)&&!l.students.some(function(c){return c.id===m.id||D.normName(c.name)===D.normName(m.name);});}));
      const out=merged.map(function(c){
        var s=statuses[c.id];
        var programs=(s&&s.indexOf('programs_')===0)?s.slice(9).split(',').filter(Boolean):[];
        return Object.assign({},c,{tasks:tasks[c.id]||c.tasks||[],programs:programs,lastAction:last[c.id]||null,mobile:phones[c.id]||c.mobile||null});
      });
      res.json({students:out,syncedAt:await syncedAt(),syncing:syncLock.active,health:await health()});
    }catch(err){log('Error:',err.message);res.status(500).json({error:err.message});}
  });

  app.get('/api/onboarding',async function(req,res){
    try{
      if(req.query.full==='true'||req.query.refresh==='1')runCycle('manual').catch(function(e){log('Background sync failed:',e.message);});else nudge();
      const l=await lists();
      res.json({clients:l.onboarding,syncedAt:await syncedAt(),syncing:syncLock.active,health:await health()});
    }catch(err){log('Error:',err.message);res.status(500).json({error:err.message});}
  });

  app.get('/api/health',async function(req,res){
    try{res.json(await health());}catch(err){res.status(500).json({error:err.message});}
  });

  // Read-only: why is (or isn't) this person in each list?
  app.get('/api/debug/why',async function(req,res){
    try{
      const q=D.normName(req.query.name||'');
      if(!q)return res.status(400).json({error:'?name= required'});
      const ctx=await loadContext();
      const hits=ctx.snapshots.filter(function(s){return D.normName(s.name).indexOf(q)>-1;});
      const manual=ctx.manual.onboarding.concat(ctx.manual.clients).filter(function(m){return D.normName(m.name).indexOf(q)>-1;});
      const lst=D.deriveAll(ctx);
      res.json({
        snapshots:hits.map(function(s){
          const c=D.classify(s,ctx);
          return {id:s.id,name:s.name,practitioner:s.practitioner,appointmentsFetched:!!s.apptsSyncedAt,appointments:(s.appointments||[]).map(function(a){return {date:D.dateOf(a.start),serviceId:a.serviceId};}),inClients:c.client,inStudents:c.student,inStudentOnboarding:c.studentOnboarding,inOnboarding:c.onboarding,reasons:c.reasons};
        }),
        manualEntries:manual.map(function(m){return {id:m.id,name:m.name,inOnboardingList:lst.onboarding.some(function(o){return o.id===m.id;}),inClientsList:lst.clients.some(function(o){return o.id===m.id;})};}),
        foundInSplosePatientList:hits.length>0
      });
    }catch(err){res.status(500).json({error:err.message});}
  });
  app.get('/api/debug/removed-ids',async function(req,res){
    try{
      const a=await pool.query('SELECT client_id,removed_at FROM removed ORDER BY removed_at DESC');
      const b=await pool.query('SELECT client_id,removed_at FROM removed_students ORDER BY removed_at DESC');
      res.json({removedClients:a.rows,removedStudents:b.rows});
    }catch(err){res.status(500).json({error:err.message});}
  });
  app.get('/api/debug/duplicate-names',async function(req,res){
    try{
      function findDupes(list){
        const byName={};
        (list||[]).forEach(function(c){
          const key=D.normName(c.name);if(!key)return;
          if(!byName[key])byName[key]={name:c.name,entries:[]};
          byName[key].entries.push({id:c.id,practitioner:c.practitioner||null,lastRealAppt:c.lastRealAppt||c.firstAppt||null});
        });
        return Object.keys(byName).map(function(k){return byName[k];}).filter(function(g){return g.entries.length>1;});
      }
      const l=await lists();
      const sm=(await getCache('students_manual'))||[];
      const so=(await getCache('student-onboarding'))||[];
      res.json({clients:findDupes(l.clients),students:findDupes(l.students.concat(sm)),onboarding:findDupes(l.onboarding),studentOnboarding:findDupes(so)});
    }catch(err){res.status(500).json({error:err.message});}
  });

  // Read-only: everyone currently permanently excluded as "not my client",
  // with names, so a mistaken click can be spotted.
  app.get('/api/debug/not-my-client',async function(req,res){
    try{
      const ex=await pool.query('SELECT client_id,added_at FROM not_my_client ORDER BY added_at DESC');
      const snaps=await loadSnapshots();
      const byId={};snaps.forEach(function(s){byId[s.id]=s;});
      res.json({count:ex.rows.length,excluded:ex.rows.map(function(r){
        const s=byId[r.client_id];
        const appts=s?s.appointments.map(function(a){return D.dateOf(a.start);}).sort():[];
        return {id:r.client_id,name:s?s.name:null,excludedAt:r.added_at,firstAppt:appts[0]||null,lastAppt:appts[appts.length-1]||null,
          restoreToOnboarding:'/api/not-my-client/restore/'+r.client_id,restoreToClients:'/api/not-my-client/restore/'+r.client_id+'?to=clients'};
      })});
    }catch(err){res.status(500).json({error:err.message});}
  });
  // Deliberate undo for ONE person wrongly marked "not my client".
  //   (default)   puts them back in Onboarding (deletes their exclusion and the
  //               onboarding-removal the same button created)
  //   ?to=clients puts them straight in Clients, for people whose onboarding was
  //               already finished (deletes ONLY their exclusion)
  // Never touches anyone else.
  app.get('/api/not-my-client/restore/:clientId',async function(req,res){
    try{
      const id=String(req.params.clientId);
      const toClients=req.query.to==='clients';
      const ex=await pool.query('SELECT 1 FROM not_my_client WHERE client_id=$1',[id]);
      if(!ex.rows.length)return res.status(404).json({ok:false,error:'That person is not on the excluded list. Nothing changed.'});
      await pool.query('DELETE FROM not_my_client WHERE client_id=$1',[id]);
      if(!toClients)await pool.query('DELETE FROM removed_onboarding WHERE client_id=$1',[id]);
      const snap=(await loadSnapshots()).find(function(s){return s.id===id;});
      log('Restored from not-my-client:',id,snap?snap.name:'',toClients?'(to Clients)':'(to Onboarding)');
      res.json({ok:true,restored:snap?snap.name:id,wentTo:toClients?'Clients (if they have a recent appointment)':'Onboarding',note:'Reload the tracker.'});
    }catch(err){res.status(500).json({error:err.message});}
  });

  // Who counts as a NEW student: anyone whose first mentoring session is on or
  // after this date waits in Student Onboarding until marked complete.
  // Changing it moves people between Students and Student Onboarding and
  // nothing else; changing it back moves them back. No data is deleted.
  const validDate=function(d){return /^\d{4}-\d{2}-\d{2}$/.test(String(d||''))&&!isNaN(Date.parse(d));};
  async function studentStartPreview(since){
    const ctx=await loadContext();
    ctx.studentOnboardingStart=since;
    const out=[];
    ctx.snapshots.forEach(function(s){
      const c=D.classify(s,ctx);
      if(c.student||c.studentOnboarding){
        const m=(s.appointments||[]).filter(function(a){return a.start&&D.MENTORING_IDS.has(Number(a.serviceId));}).map(function(a){return D.dateOf(a.start);}).sort();
        out.push({name:s.name,firstMentoringSession:m[0],wouldBe:c.studentOnboarding?'Student Onboarding':'Students'});
      }
    });
    out.sort(function(a,b){return String(b.firstMentoringSession).localeCompare(String(a.firstMentoringSession));});
    return out;
  }
  app.get('/api/debug/new-students',async function(req,res){
    try{
      const since=req.query.since;
      if(!validDate(since))return res.status(400).json({error:'Use ?since=YYYY-MM-DD, e.g. ?since=2026-09-15'});
      const all=await studentStartPreview(since);
      res.json({since:since,note:'Nothing is changed by this page. "wouldBe" is where each person would sit if this start date were used. Newest first; older people are omitted below.',
        wouldMoveToStudentOnboarding:all.filter(function(x){return x.wouldBe==='Student Onboarding';}),
        mostRecentStartsThatStayInStudents:all.filter(function(x){return x.wouldBe==='Students';}).slice(0,15)});
    }catch(err){res.status(500).json({error:err.message});}
  });
  app.get('/api/settings/student-onboarding-start',async function(req,res){
    try{
      const cur=await getState('student_onboarding_start');
      if(req.query.date===undefined)return res.json({current:cur&&cur.date?cur.date:D.STUDENT_ONBOARDING_START,isDefault:!(cur&&cur.date)});
      if(!validDate(req.query.date))return res.status(400).json({error:'Use ?date=YYYY-MM-DD, e.g. ?date=2026-09-15. Nothing changed.'});
      await setState('student_onboarding_start',{date:req.query.date});
      const l=await lists();
      res.json({ok:true,current:req.query.date,inStudentOnboardingNow:l.studentOnboarding.map(function(x){return x.name;}).sort()});
    }catch(err){res.status(500).json({error:err.message});}
  });

  // ------------------------------------------------------------ write routes
  // None of these touch the lists or any cache - they write only to their own
  // table, so using the app can never change what the sync does.
  app.post('/api/followup-override',async function(req,res){
    const{clientId,days}=req.body;
    if(!clientId)return res.status(400).json({error:'clientId required'});
    try{await setFollowupOverride(clientId,days===''||days===null||days===undefined?null:Number(days));res.json({ok:true});}
    catch(err){res.status(500).json({error:err.message});}
  });
  app.post('/api/student-phone',async function(req,res){
    const{clientId,phone}=req.body;
    if(!clientId)return res.status(400).json({error:'clientId required'});
    try{await setStudentPhone(clientId,phone);res.json({ok:true});}
    catch(err){res.status(500).json({error:err.message});}
  });
  app.post('/api/action',async function(req,res){
    try{
      const{clientId,tasks}=req.body;
      if(clientId&&tasks!==undefined){await setTasks(clientId,tasks);await touchLastAction(clientId);}
      res.json({ok:true});
    }catch(err){res.status(500).json({error:err.message});}
  });
  app.post('/api/status',async function(req,res){
    try{
      const{clientId}=req.body;const status=req.body.status||null;
      if(clientId){await setStatus(clientId,status);await touchLastAction(clientId);}
      res.json({ok:true});
    }catch(err){res.status(500).json({error:err.message});}
  });
  app.post('/api/onboarding-action',async function(req,res){
    try{
      const{clientId,tasks}=req.body;
      if(clientId&&tasks!==undefined){await setOnboardingTasks(clientId,tasks);await touchLastAction(clientId);}
      res.json({ok:true});
    }catch(err){res.status(500).json({error:err.message});}
  });

  app.get('/api/unremove/:clientId',async function(req,res){
    await pool.query('DELETE FROM removed WHERE client_id=$1',[req.params.clientId]);
    res.json({ok:true});
  });

  app.post('/api/remove',async function(req,res){
    try{
      const clientId=req.body.clientId;
      const list=req.body.list||'clients';
      if(!clientId)return res.json({ok:true});
      if(list==='students'){
        await addStudentRemoved(clientId,await knownApptIdsFor(clientId));
      }else if(list==='onboarding'){
        // Mark the person (and any hand-entered twin with the same name)
        // as done with onboarding, so neither can reappear.
        const l=await lists();
        const moved=l.onboarding.find(function(c){return c.id===clientId;})||null;
        await addOnboardingRemoved(clientId);
        if(moved){
          const twins=(await getManual('onboarding')).filter(function(m){return D.normName(m.name)===D.normName(moved.name)&&m.id!==clientId;});
          for(const tw of twins)await addOnboardingRemoved(tw.id);
        }
        if(req.body.notMyClient){
          await addNotMyClient(clientId);
        }else if(moved&&(moved.manual||/^ob_/.test(clientId))){
          // Hand-entered person marked complete: they go to Clients as a
          // hand-entered entry until Splose has them (then the real record takes over).
          await addManual('clients',{id:moved.id,name:moved.name,mobile:null,practitioner:moved.practitioner||'',lastRealAppt:moved.firstAppt||null,appointments:[],tasks:[],manualStatus:null,followupDays:null,lastAction:null});
        }
        nudge();
      }else{
        await addRemoved(clientId,await knownApptIdsFor(clientId));
      }
      res.json({ok:true});
    }catch(err){res.status(500).json({error:err.message});}
  });

  app.post('/api/onboarding/add',async function(req,res){
    const{name}=req.body;
    if(!name)return res.status(400).json({error:'Name required'});
    try{
      const id='ob_'+require('crypto').randomBytes(8).toString('hex');
      const newClient={id:id,name:name,firstAppt:new Date().toISOString().split('T')[0],tasks:D.defaultOnboardingTasks(id),manual:true};
      await addManual('onboarding',newClient);
      // Look for the real Splose record soon, without making her wait.
      nudge();
      res.json({ok:true,client:newClient});
    }catch(err){res.status(500).json({error:err.message});}
  });

  // ------------------------------------------- student onboarding (hand-entered)
  app.get('/api/student-onboarding',async function(req,res){
    try{
      nudge();
      const l=await lists();
      res.json({clients:l.studentOnboarding,syncedAt:await syncedAt()});
    }catch(err){res.status(500).json({error:err.message});}
  });
  app.get('/api/students-list',async function(req,res){
    try{
      const l=await lists();
      const manual=(await getCache('students_manual'))||[];
      const merged=l.students.concat(manual.filter(function(m){return !l.students.some(function(c){return c.id===m.id||D.normName(c.name)===D.normName(m.name);});}));
      res.json({students:merged.map(function(s){return {id:s.id,name:s.name};})});
    }catch(err){res.status(500).json({error:err.message});}
  });
  app.post('/api/student-onboarding/add',async function(req,res){
    const{name,program}=req.body;
    if(!name)return res.status(400).json({error:'Name required'});
    try{
      const id='so_'+require('crypto').randomBytes(8).toString('hex');
      const names=["T's & C's Sent","T's & C's Signed",'Deposit Invoice sent','Deposit Paid','Signed Mentor Agreement & Application Email sent','Application successful','Circle invite sent','Circle Released','Welcome Direct message sent on Circle','Emailed FH to confirm they are in','Added to 2122'];
      const tasks=names.map(function(n,i){return {id:'so'+(i+1)+'_'+id,a:'Annie',n:n,done:false};});
      const newStudent={id:id,name:name,program:program||null,firstAppt:new Date().toISOString().split('T')[0],tasks:tasks};
      const cached=(await getCache('student-onboarding'))||[];
      await setCache('student-onboarding',[...cached,newStudent]);
      res.json({ok:true,student:newStudent});
    }catch(err){res.status(500).json({error:err.message});}
  });
  const isSploseId=async function(id){return (await pool.query('SELECT 1 FROM patient_snapshots WHERE client_id=$1',[String(id)])).rows.length>0;};
  // Complete: the person leaves Student Onboarding and (being in Splose, or via
  // a hand-entered stand-in until Splose has them) appears in Students.
  app.post('/api/student-onboarding/complete',async function(req,res){
    const{clientId}=req.body;
    if(!clientId)return res.status(400).json({error:'clientId required'});
    try{
      const l=await lists();
      const entry=l.studentOnboarding.find(function(c){return c.id===clientId;});
      await addOnboardingRemoved(clientId);
      await pool.query('INSERT INTO student_onboarding_done(client_id) VALUES($1) ON CONFLICT DO NOTHING',[clientId]);
      // also retire any hand-entered twin with the same name
      const manual=(await getCache('student-onboarding'))||[];
      if(entry){
        for(const m of manual){if(D.normName(m.name)===D.normName(entry.name)&&m.id!==clientId)await addOnboardingRemoved(m.id);}
      }
      await setCache('student-onboarding',manual.filter(function(c){return c.id!==clientId;}));
      if(entry&&!(await isSploseId(clientId))){
        const manualCache=(await getCache('students_manual'))||[];
        const exists=manualCache.find(function(c){return D.normName(c.name)===D.normName(entry.name);})||l.students.find(function(c){return D.normName(c.name)===D.normName(entry.name);});
        if(!exists)await setCache('students_manual',[...manualCache,{id:clientId,name:entry.name,practitioner:'',appointments:[],tasks:[],program:entry.program}]);
      }
      res.json({ok:true});
    }catch(err){res.status(500).json({error:err.message});}
  });
  // Remove: for duplicates/mistakes. Does NOT push the person into Students.
  app.post('/api/student-onboarding/remove',async function(req,res){
    const{clientId}=req.body;
    if(!clientId)return res.status(400).json({error:'clientId required'});
    try{
      await addOnboardingRemoved(clientId);
      if(await isSploseId(clientId)){
        // Real Splose person: leave Student Onboarding AND stay out of Students
        // until a genuinely new mentoring appointment is booked.
        await pool.query('INSERT INTO student_onboarding_done(client_id) VALUES($1) ON CONFLICT DO NOTHING',[clientId]);
        await addStudentRemoved(clientId,await knownApptIdsFor(clientId));
      }
      const cached=(await getCache('student-onboarding'))||[];
      await setCache('student-onboarding',cached.filter(function(c){return c.id!==clientId;}));
      res.json({ok:true});
    }catch(err){res.status(500).json({error:err.message});}
  });
  app.post('/api/student-onboarding/program',async function(req,res){
    const{clientId,program}=req.body;
    if(!clientId)return res.status(400).json({error:'clientId required'});
    try{
      const cached=await getCache('student-onboarding');
      if(cached)await setCache('student-onboarding',cached.map(function(c){return c.id===clientId?Object.assign({},c,{program:program}):c;}));
      // Real Splose people keep their programs the same way students do, so
      // they carry straight over to the Students list on completion.
      if(await isSploseId(clientId)){
        const progs=String(program||'').split(',').filter(Boolean);
        await setStatus(clientId,progs.length?'programs_'+progs.join(','):null);
      }
      res.json({ok:true});
    }catch(err){res.status(500).json({error:err.message});}
  });

  // Starts the background loop (kept out of createApp so tests control timing).
  let timer=null;
  function startBackground(){
    setTimeout(function(){runCycle('startup').catch(function(e){log('Startup sync failed:',e.message);});},15000).unref();
    timer=setInterval(function(){runCycle('scheduled').catch(function(e){log('Scheduled sync failed:',e.message);});},cfg.cycleMs);
    timer.unref();
  }
  return {app:app,initDB:initDB,migrate:migrate,runCycle:runCycle,startBackground:startBackground,health:health,lists:lists,syncLock:syncLock,_pool:pool};
}

module.exports={createApp};
