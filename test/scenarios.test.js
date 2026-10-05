const test=require('node:test');
const assert=require('node:assert/strict');
const {makeEnv,SVC,names}=require('./harness');

const appt=function(id,date,svc){return {id:id,start:date+'T09:00:00Z',serviceId:svc};};
const recent=function(id,svc){return appt(id,'2026-09-20',svc||SVC.followUp);};
const established=function(id){return [appt(id*10,'2026-02-01',SVC.initialConsult),appt(id*10+1,'2026-09-25',SVC.followUp)];};

async function setupBasic(){
  const env=await makeEnv();
  // Established client: first appt long before onboarding cutoff, recent follow-up.
  env.splose.add(1,'Old','Client',[appt(101,'2026-02-01',SVC.initialConsult),recent(102)]);
  return env;
}

test('1. Nalini: brand-new patient with a real 1 Oct appointment lands in Onboarding on the first cycle',async function(){
  const env=await setupBasic();
  await env.tracker.runCycle('t');
  env.splose.add(2,'Nalini','Test',[appt(201,'2026-10-01',SVC.initialConsult)]);
  await env.tracker.runCycle('t');
  const ob=await env.api('GET','/api/onboarding');
  assert.deepEqual(names(ob.clients),['Nalini Test']);
  assert.equal(ob.clients[0].firstAppt,'2026-10-01');
  assert.equal(ob.clients[0].tasks.length,8);
  const cl=await env.api('GET','/api/clients');
  assert.deepEqual(names(cl.clients),['Old Client']);
});

test('2. Nalini added by hand first, then picked up from Splose: one entry, ticked tasks follow her',async function(){
  const env=await setupBasic();
  await env.tracker.runCycle('t');
  const added=await env.api('POST','/api/onboarding/add',{name:'Nalini Test'});
  const manualId=added.client.id;
  let ob=await env.api('GET','/api/onboarding');
  assert.equal(ob.clients.length,1);
  // tick a task while she is only a manual entry
  const tasks=ob.clients[0].tasks.map(function(t,i){return i===0?Object.assign({},t,{done:true}):t;});
  await env.api('POST','/api/onboarding-action',{clientId:manualId,tasks:tasks});
  // Splose now has her
  env.splose.add(2,'Nalini','Test',[appt(201,'2026-10-01',SVC.initialConsult)]);
  await env.tracker.runCycle('t');
  ob=await env.api('GET','/api/onboarding');
  assert.equal(ob.clients.length,1,'must not be doubled');
  assert.equal(ob.clients[0].id,'2');
  assert.equal(ob.clients[0].tasks[0].done,true,'the task ticked on the manual entry must carry over');
});

test('3. A hand-added onboarding person survives any number of syncs',async function(){
  const env=await setupBasic();
  await env.api('POST','/api/onboarding/add',{name:'Hand Added'});
  for(let i=0;i<3;i++){env.advance(30*60*1000);await env.tracker.runCycle('t');}
  const ob=await env.api('GET','/api/onboarding');
  assert.deepEqual(names(ob.clients),['Hand Added']);
});

test('4. A sync cut off by rate limits keeps everything it already fetched and finishes next time',async function(){
  const env=await makeEnv();
  for(let i=1;i<=8;i++)env.splose.add(i,'P'+i,'X',established(i));
  env.splose.rateLimitAfter=3;
  const s=await env.tracker.runCycle('t');
  assert.equal(s.stoppedEarly,true);
  let h=await env.api('GET','/api/health');
  assert.equal(h.withAppointments,3,'the 3 fetched before the limit are saved');
  assert.ok(h.lastError,'the failure is reported');
  assert.equal(h.lastOkAt,null,'a failed cycle is never reported as a success');
  let cl=await env.api('GET','/api/clients');
  assert.equal(cl.clients.length,3);
  env.splose.rateLimitAfter=null;
  await env.tracker.runCycle('t');
  cl=await env.api('GET','/api/clients');
  assert.equal(cl.clients.length,8);
  h=await env.api('GET','/api/health');
  assert.ok(h.lastOkAt);assert.equal(h.lastError,null);
});

test('5. Using the app (ticking tasks, changing status) never stops a new client appearing',async function(){
  const env=await setupBasic();
  await env.tracker.runCycle('t');
  for(let i=0;i<5;i++){
    await env.api('POST','/api/action',{clientId:'1',tasks:[{id:'t'+i,assignee:'Priority',note:'x',done:false}]});
    await env.api('POST','/api/status',{clientId:'1',status:'checkin'});
    env.advance(60*60*1000);
  }
  env.splose.add(2,'Nalini','Test',[appt(201,'2026-10-01',SVC.initialConsult)]);
  await env.tracker.runCycle('t');
  const ob=await env.api('GET','/api/onboarding');
  assert.deepEqual(names(ob.clients),['Nalini Test']);
});

test('6. Onboarding complete moves a Splose client to Clients at once and they stay there after syncs',async function(){
  const env=await setupBasic();
  env.splose.add(2,'Nalini','Test',[appt(201,'2026-10-01',SVC.initialConsult)]);
  await env.tracker.runCycle('t');
  await env.api('POST','/api/remove',{clientId:'2',list:'onboarding'});
  let ob=await env.api('GET','/api/onboarding');assert.equal(ob.clients.length,0);
  let cl=await env.api('GET','/api/clients');assert.ok(names(cl.clients).includes('Nalini Test'));
  env.advance(3*3600*1000);await env.tracker.runCycle('t');
  ob=await env.api('GET','/api/onboarding');assert.equal(ob.clients.length,0);
  cl=await env.api('GET','/api/clients');assert.equal(cl.clients.filter(function(c){return c.name==='Nalini Test';}).length,1);
});

test('7. Hand-added person marked complete appears in Clients, then is replaced (not doubled) once Splose has them',async function(){
  const env=await setupBasic();
  const added=await env.api('POST','/api/onboarding/add',{name:'Hand Added'});
  await env.api('POST','/api/remove',{clientId:added.client.id,list:'onboarding'});
  let cl=await env.api('GET','/api/clients');
  assert.ok(names(cl.clients).includes('Hand Added'));
  env.splose.add(3,'Hand','Added',[appt(301,'2026-10-02',SVC.followUp)]);
  await env.tracker.runCycle('t');
  cl=await env.api('GET','/api/clients');
  assert.equal(cl.clients.filter(function(c){return c.name==='Hand Added';}).length,1);
  const ob=await env.api('GET','/api/onboarding');
  assert.equal(ob.clients.length,0,'must not re-enter onboarding after completion');
});

test('8. Removed client stays removed through syncs, and returns only on a genuinely new appointment',async function(){
  const env=await setupBasic();
  await env.tracker.runCycle('t');
  await env.api('POST','/api/remove',{clientId:'1',list:'clients'});
  for(let i=0;i<3;i++){env.advance(3*3600*1000);await env.tracker.runCycle('t');}
  let cl=await env.api('GET','/api/clients');assert.equal(cl.clients.length,0);
  env.splose.appts[1].push(appt(103,'2026-10-20',SVC.followUp)); // a new booking
  env.advance(3*3600*1000);await env.tracker.runCycle('t');
  cl=await env.api('GET','/api/clients');assert.equal(cl.clients.length,1);
});

test('9. A removed client with an already-booked future appointment does not bounce back',async function(){
  const env=await makeEnv();
  env.splose.add(1,'Future','Booked',[appt(1,'2026-02-01',SVC.initialConsult),appt(2,'2026-09-20',SVC.followUp),appt(3,'2026-11-30',SVC.followUp)]);
  await env.tracker.runCycle('t');
  await env.api('POST','/api/remove',{clientId:'1',list:'clients'});
  env.advance(3*3600*1000);await env.tracker.runCycle('t');
  const cl=await env.api('GET','/api/clients');assert.equal(cl.clients.length,0);
});

test('10. Students: classification, programs persist through syncs, never appear in Onboarding or Clients',async function(){
  const env=await makeEnv();
  env.splose.add(5,'Stu','Dent',[appt(501,'2026-08-10',SVC.mentoring),appt(502,'2026-09-10',SVC.checkin)]);
  await env.tracker.runCycle('t');
  await env.api('POST','/api/status',{clientId:'5',status:'programs_LEP,Pathway 3'});
  env.advance(3*3600*1000);await env.tracker.runCycle('t');
  const st=await env.api('GET','/api/students');
  assert.deepEqual(names(st.students),['Stu Dent']);
  assert.deepEqual(st.students[0].programs,['LEP','Pathway 3']);
  assert.equal((await env.api('GET','/api/onboarding')).clients.length,0);
  assert.equal((await env.api('GET','/api/clients')).clients.length,0);
});

test('11. Acceptance of Program / Oral Assessment Workshop alone do not make someone a client or client-onboarding',async function(){
  const env=await makeEnv();
  env.splose.add(6,'Acc','Epted',[appt(601,'2026-09-15',SVC.acceptance)]);
  env.splose.add(7,'Work','Shop',[appt(701,'2026-09-15',SVC.workshop)]);
  await env.tracker.runCycle('t');
  assert.equal((await env.api('GET','/api/clients')).clients.length,0);
  assert.deepEqual(names((await env.api('GET','/api/onboarding')).clients).includes('Acc Epted'),false);
});

test('12. Student Onboarding complete -> Students; no duplicate once Splose picks them up',async function(){
  const env=await makeEnv();
  const a=await env.api('POST','/api/student-onboarding/add',{name:'New Student',program:'LEP'});
  await env.api('POST','/api/student-onboarding/complete',{clientId:a.student.id});
  let st=await env.api('GET','/api/students');assert.deepEqual(names(st.students),['New Student']);
  env.splose.add(8,'New','Student',[appt(801,'2026-10-02',SVC.mentoring)]);
  await env.tracker.runCycle('t');
  st=await env.api('GET','/api/students');
  assert.equal(st.students.filter(function(s){return s.name==='New Student';}).length,1);
});

test('13. Not-my-client is permanent, even with new appointments',async function(){
  const env=await makeEnv();
  env.splose.add(9,'Other','Prac',[appt(901,'2026-10-01',SVC.initialConsult)]);
  await env.tracker.runCycle('t');
  await env.api('POST','/api/remove',{clientId:'9',list:'onboarding',notMyClient:true});
  env.splose.appts[9].push(appt(902,'2026-10-10',SVC.followUp));
  env.advance(3*3600*1000);await env.tracker.runCycle('t');
  assert.equal((await env.api('GET','/api/onboarding')).clients.length,0);
  assert.equal((await env.api('GET','/api/clients')).clients.length,0);
});

test('14. Only one sync runs at a time',async function(){
  const env=await setupBasic();
  const [a,b]=await Promise.all([env.tracker.runCycle('a'),env.tracker.runCycle('b')]);
  assert.ok(a.skipped||b.skipped);
});

test('15. A duplicate patient id in Splose paging does not double anyone',async function(){
  const env=await makeEnv();
  for(let i=1;i<=5;i++)env.splose.add(i,'P'+i,'X',established(i));
  env.splose.duplicatePatientPage=true;
  await env.tracker.runCycle('t');
  assert.equal((await env.api('GET','/api/clients')).clients.length,5);
});

test('16. One patient that errors is skipped; everyone else still syncs',async function(){
  const env=await makeEnv();
  for(let i=1;i<=4;i++)env.splose.add(i,'P'+i,'X',established(i));
  env.splose.failPatient=2;
  const s=await env.tracker.runCycle('t');
  assert.equal(s.failed,1);
  assert.equal((await env.api('GET','/api/clients')).clients.length,3);
});

test('17. Restarting the server loses nothing',async function(){
  let env=await setupBasic();
  await env.api('POST','/api/onboarding/add',{name:'Hand Added'});
  await env.tracker.runCycle('t');
  await env.api('POST','/api/action',{clientId:'1',tasks:[{id:'t1',assignee:'Priority',note:'call',done:false}]});
  env=await env.restart();
  assert.deepEqual(names((await env.api('GET','/api/onboarding')).clients),['Hand Added']);
  const cl=await env.api('GET','/api/clients');
  assert.equal(cl.clients[0].tasks[0].note,'call');
});

test('18. Upgrading: old cache still shows people until their appointments are fetched, hand-entered people are kept, nothing is deleted',async function(){
  const env=await makeEnv();
  await env.pool.query('INSERT INTO cache(key,value) VALUES($1,$2)',['clients',JSON.stringify([{id:'1',name:'Old Client',mobile:null,practitioner:'F',lastRealAppt:'2026-09-20',appointments:[],tasks:[],manualStatus:null,followupDays:null,lastAction:null},{id:'ob_abc',name:'Stub Person',appointments:[],tasks:[]}])]);
  await env.pool.query('INSERT INTO cache(key,value) VALUES($1,$2)',['onboarding',JSON.stringify([{id:'ob_zzz',name:'Manual Ob',manual:true,firstAppt:'2026-10-01',tasks:[]}])]);
  await env.pool.query('INSERT INTO cache(key,value) VALUES($1,$2)',['students',JSON.stringify([{id:'5',name:'Stu Dent',appointments:[],tasks:[],programs:[]}])]);
  const env2=await env.restart(); // runs the migration on startup
  let cl=await env2.api('GET','/api/clients');
  assert.deepEqual(names(cl.clients),['Old Client','Stub Person']);
  assert.deepEqual(names((await env2.api('GET','/api/onboarding')).clients),['Manual Ob']);
  assert.deepEqual(names((await env2.api('GET','/api/students')).students),['Stu Dent']);
  // Now Splose answers: derived data takes over, hand-entered stay
  env2.splose.add(1,'Old','Client',[appt(101,'2026-02-01',SVC.initialConsult),recent(102)]);
  env2.splose.add(5,'Stu','Dent',[appt(501,'2026-08-10',SVC.mentoring)]);
  await env2.tracker.runCycle('t');
  cl=await env2.api('GET','/api/clients');
  assert.deepEqual(names(cl.clients),['Old Client','Stub Person']);
  assert.deepEqual(names((await env2.api('GET','/api/onboarding')).clients),['Manual Ob']);
  const legacy=await env2.pool.query("SELECT value FROM cache WHERE key='clients'");
  assert.ok(legacy.rows.length,'old cache is left untouched');
});

test('19. Health is honest: reports the real last success, not "now"',async function(){
  const env=await makeEnv(); // page-load syncs are off by default in tests, so timing is deterministic
  env.splose.add(1,'Old','Client',[appt(101,'2026-02-01',SVC.initialConsult),recent(102)]);
  let cl=await env.api('GET','/api/clients');
  assert.equal(cl.syncedAt,null,'never synced yet -> no fake timestamp');
  await env.tracker.runCycle('t');
  const at=new Date(env.now()).toISOString();
  cl=await env.api('GET','/api/clients');
  assert.equal(cl.syncedAt,at);
  env.advance(5*3600*1000);
  cl=await env.api('GET','/api/clients');
  assert.equal(cl.syncedAt,at,'five hours on it still says when the last sync really was');
  assert.notEqual(cl.syncedAt,new Date(env.now()).toISOString());
});

test('20. Active clients are refreshed every cycle window, quiet ones on a rolling basis; new bookings appear',async function(){
  const env=await setupBasic();
  await env.tracker.runCycle('t');
  env.splose.appts[1].push(appt(103,'2026-10-04',SVC.followUp));
  env.advance(30*60*1000);
  await env.tracker.runCycle('t');
  const cl=await env.api('GET','/api/clients');
  assert.equal(cl.clients[0].lastRealAppt,'2026-10-04');
});

test('21. Practitioner list failing does not blank out practitioner names',async function(){
  const env=await setupBasic();
  await env.tracker.runCycle('t');
  assert.equal((await env.api('GET','/api/clients')).clients[0].practitioner,'Felicity Hughes');
  env.splose.practitionersDown=true;
  env.advance(30*60*1000);await env.tracker.runCycle('t');
  assert.equal((await env.api('GET','/api/clients')).clients[0].practitioner,'Felicity Hughes');
});

test('22. "Why isn\'t she showing?" - the diagnostic explains a missing person',async function(){
  const env=await makeEnv();
  env.splose.add(2,'Nalini','Test',[appt(201,'2026-03-01',SVC.initialConsult)]);
  await env.tracker.runCycle('t');
  const why=await env.api('GET','/api/debug/why?name=nalini');
  assert.equal(why.snapshots.length,1);
  assert.equal(why.snapshots[0].inOnboarding,false);
  assert.ok(why.snapshots[0].reasons.join(' ').length>0);
});

test('23. A person wrongly marked "not my client" can be restored on purpose, and only that person',async function(){
  const env=await makeEnv();
  env.splose.add(2,'Nalini','Test',[appt(201,'2026-10-01',SVC.initialConsult),appt(202,'2026-10-07',SVC.followUp)]);
  env.splose.add(9,'Truly','Other',[appt(901,'2026-10-01',SVC.initialConsult)]);
  await env.tracker.runCycle('t');
  await env.api('POST','/api/remove',{clientId:'2',list:'onboarding',notMyClient:true});
  await env.api('POST','/api/remove',{clientId:'9',list:'onboarding',notMyClient:true});
  assert.equal((await env.api('GET','/api/onboarding')).clients.length,0);
  const list=await env.api('GET','/api/debug/not-my-client');
  assert.equal(list.count,2);
  assert.ok(list.excluded.some(function(e){return e.name==='Nalini Test';}));
  const r=await env.api('GET','/api/not-my-client/restore/2');
  assert.equal(r.ok,true);assert.equal(r.restored,'Nalini Test');
  assert.deepEqual(names((await env.api('GET','/api/onboarding')).clients),['Nalini Test']);
  assert.equal((await env.api('GET','/api/debug/not-my-client')).count,1,'the other exclusion is untouched');
  env.advance(3*3600*1000);await env.tracker.runCycle('t');
  assert.deepEqual(names((await env.api('GET','/api/onboarding')).clients),['Nalini Test'],'stays after a sync');
  const bad=await env.api('GET','/api/not-my-client/restore/999');
  assert.equal(bad.ok,false);
});

// ---- Student Onboarding is automatic for new students ----
test('24. Sophie: first mentoring session booked 14 Oct -> Student Onboarding, NOT Students, and stays so after the date passes',async function(){
  const env=await makeEnv();
  env.splose.add(30,'Sophie','Robertson',[appt(3001,'2026-10-14',SVC.mentoring)]);
  env.splose.add(31,'Casey','Dykes',[appt(3101,'2026-10-20',SVC.mentoring2)]);
  await env.tracker.runCycle('t');
  assert.deepEqual(names((await env.api('GET','/api/students')).students),[]);
  let so=await env.api('GET','/api/student-onboarding');
  assert.deepEqual(names(so.clients),['Casey Dykes','Sophie Robertson']);
  assert.equal(so.clients[0].tasks.length,11);
  assert.equal((await env.api('GET','/api/clients')).clients.length,0);
  assert.equal((await env.api('GET','/api/onboarding')).clients.length,0);
  // the booking date comes and goes without her ever being completed
  env.advance(30*86400000);await env.tracker.runCycle('t');
  assert.deepEqual(names((await env.api('GET','/api/students')).students),[]);
  assert.equal((await env.api('GET','/api/student-onboarding')).clients.length,2);
});

test('25. Existing students (started before the cut-off) are untouched',async function(){
  const env=await makeEnv();
  env.splose.add(5,'Stu','Dent',[appt(501,'2026-08-10',SVC.mentoring),appt(502,'2026-10-14',SVC.mentoring)]);
  await env.tracker.runCycle('t');
  assert.deepEqual(names((await env.api('GET','/api/students')).students),['Stu Dent']);
  assert.equal((await env.api('GET','/api/student-onboarding')).clients.length,0);
});

test('26. Completing Student Onboarding moves her to Students (once), with her ticks and programs, and she stays after syncs',async function(){
  const env=await makeEnv();
  env.splose.add(30,'Sophie','Robertson',[appt(3001,'2026-10-14',SVC.mentoring)]);
  await env.tracker.runCycle('t');
  let so=await env.api('GET','/api/student-onboarding');
  const tasks=so.clients[0].tasks.map(function(t,i){return i===0?Object.assign({},t,{done:true}):t;});
  await env.api('POST','/api/onboarding-action',{clientId:'30',tasks:tasks});
  await env.api('POST','/api/student-onboarding/program',{clientId:'30',program:'LEP,Pathway 3'});
  so=await env.api('GET','/api/student-onboarding');
  assert.equal(so.clients[0].tasks[0].done,true);
  assert.deepEqual(so.clients[0].programs,['LEP','Pathway 3']);
  await env.api('POST','/api/student-onboarding/complete',{clientId:'30'});
  assert.equal((await env.api('GET','/api/student-onboarding')).clients.length,0);
  let st=await env.api('GET','/api/students');
  assert.deepEqual(names(st.students),['Sophie Robertson']);
  assert.deepEqual(st.students[0].programs,['LEP','Pathway 3']);
  for(let i=0;i<3;i++){env.advance(3*3600*1000);await env.tracker.runCycle('t');}
  st=await env.api('GET','/api/students');
  assert.equal(st.students.filter(function(s){return s.name==='Sophie Robertson';}).length,1);
  assert.equal((await env.api('GET','/api/student-onboarding')).clients.length,0);
});

test('27. Removing a new student from Student Onboarding (mistake) puts her in neither list, until a new mentoring booking',async function(){
  const env=await makeEnv();
  env.splose.add(30,'Sophie','Robertson',[appt(3001,'2026-10-14',SVC.mentoring)]);
  await env.tracker.runCycle('t');
  await env.api('POST','/api/student-onboarding/remove',{clientId:'30'});
  assert.equal((await env.api('GET','/api/student-onboarding')).clients.length,0);
  assert.equal((await env.api('GET','/api/students')).students.length,0);
  env.advance(3*3600*1000);await env.tracker.runCycle('t');
  assert.equal((await env.api('GET','/api/students')).students.length,0);
  env.splose.appts[30].push(appt(3002,'2026-10-28',SVC.mentoring));
  env.advance(3*3600*1000);await env.tracker.runCycle('t');
  assert.equal((await env.api('GET','/api/students')).students.length,1);
});

test('28. A hand-entered Student Onboarding entry and the real Splose record are ONE entry; ticks follow; no duplicate after completing',async function(){
  const env=await makeEnv();
  const a=await env.api('POST','/api/student-onboarding/add',{name:'Casey Dykes',program:'LEP'});
  const t=a.student.tasks.map(function(x,i){return i<2?Object.assign({},x,{done:true}):x;});
  await env.api('POST','/api/onboarding-action',{clientId:a.student.id,tasks:t});
  env.splose.add(31,'Casey','Dykes',[appt(3101,'2026-10-20',SVC.mentoring)]);
  await env.tracker.runCycle('t');
  let so=await env.api('GET','/api/student-onboarding');
  assert.equal(so.clients.length,1);
  assert.equal(so.clients[0].id,'31');
  assert.equal(so.clients[0].tasks.filter(function(x){return x.done;}).length,2,'ticks carried over');
  assert.deepEqual(so.clients[0].programs,['LEP']);
  await env.api('POST','/api/student-onboarding/complete',{clientId:'31'});
  const st=await env.api('GET','/api/students');
  assert.equal(st.students.filter(function(s){return s.name==='Casey Dykes';}).length,1);
  assert.equal((await env.api('GET','/api/student-onboarding')).clients.length,0);
});

test('29. Hand-entered student completed before Splose has them: no bounce back into Student Onboarding once Splose does',async function(){
  const env=await makeEnv();
  const a=await env.api('POST','/api/student-onboarding/add',{name:'Casey Dykes'});
  await env.api('POST','/api/student-onboarding/complete',{clientId:a.student.id});
  assert.deepEqual(names((await env.api('GET','/api/students')).students),['Casey Dykes']);
  env.splose.add(31,'Casey','Dykes',[appt(3101,'2026-10-20',SVC.mentoring)]);
  await env.tracker.runCycle('t');
  assert.equal((await env.api('GET','/api/student-onboarding')).clients.length,0);
  assert.equal((await env.api('GET','/api/students')).students.filter(function(s){return s.name==='Casey Dykes';}).length,1);
});

test('30. "Why" says why a student is where they are',async function(){
  const env=await makeEnv();
  env.splose.add(30,'Sophie','Robertson',[appt(3001,'2026-10-14',SVC.mentoring)]);
  await env.tracker.runCycle('t');
  const why=await env.api('GET','/api/debug/why?name=sophie');
  assert.equal(why.snapshots[0].inStudentOnboarding,true);
  assert.equal(why.snapshots[0].inStudents,false);
  assert.ok(why.snapshots[0].reasons.join(' ').includes('new student'));
});

test('31. Opening the app starts a background sync by itself when none has run, and never blocks the page',async function(){
  const env=await makeEnv({config:{nudgeEnabled:true}});
  env.splose.add(1,'Old','Client',[appt(101,'2026-02-01',SVC.initialConsult),recent(102)]);
  const first=await env.api('GET','/api/clients');
  assert.ok(Array.isArray(first.clients),'page answers immediately');
  for(let i=0;i<200&&(env.tracker.syncLock.active||!(await env.api('GET','/api/health')).lastOkAt);i++)await new Promise(function(r){setTimeout(r,25);});
  assert.equal((await env.api('GET','/api/clients')).clients.length,1);
});
