// Pure rules: given what Splose last told us (patient snapshots) plus what
// Felicity has entered herself, work out who belongs in Clients, Students and
// Onboarding. No database, no network - so every rule can be tested directly.
//
// The key idea: Splose data and hand-entered data are stored separately and
// only combined here, at read time. A sync can never overwrite a manual entry
// because a sync never writes the lists - it only refreshes snapshots.

const CHECKIN_ID=399669;
// 399652 = Oral Assessment Workshop, 444486 = Acceptance of Program - both
// mentoring/onboarding-related, not real client services.
const STUDENT_IDS=new Set([399651,399621,415863,416098,416099,416100,416101,416173,425885,437283,425993,425994,399652,444486]);
const MENTORING_IDS=new Set([399651,399621,415863,416098,416099,416100,416101,416173,425885,437283]);
const INTERACTION_IDS=new Set([399651,399621,399669]);
const ONBOARDING_STUDENT_IDS=new Set([399651,399621,415863,416098,416099,416100,416101,416173,425885,437283,444486]);
const ONBOARDING_START='2026-06-04';
const RECENT_START='2026-04-01';
// A person whose FIRST mentoring session is on/after this date is a new
// student: they go to Student Onboarding and stay there until marked complete.
// People who started before this date are existing students and are untouched.
const STUDENT_ONBOARDING_START='2026-10-01'; // default; Felicity can change it with /api/settings/student-onboarding-start

const ONBOARDING_DEFAULT_TASKS=[
  {id:'ob1',assignee:'Annie',n:'Contact card sent to Felicity',done:false},
  {id:'ob2',assignee:'Annie',n:'Registration',done:false},
  {id:'ob3',assignee:'Annie',n:'Consent',done:false},
  {id:'ob4',assignee:'Annie',n:'Safety Checklist if Home',done:false},
  {id:'ob5',assignee:'Annie',n:'Address to consult if home',done:false},
  {id:'ob6',assignee:'Annie',n:'DOB and Medicare (if applicable) added',done:false},
  {id:'ob7',assignee:'Annie',n:'Joined Circle',done:false},
  {id:'ob8',assignee:'Annie',n:'Circle chat opened and welcome message sent',done:false}
];

function normName(n){return String(n||'').trim().toLowerCase();}
function dateOf(start){return String(start||'').split('T')[0];}
function byStartAsc(a,b){return new Date(a.start)-new Date(b.start);}
function byStartDesc(a,b){return new Date(b.start)-new Date(a.start);}

// A removed person comes back only if an appointment id appears that was not
// on the books when they were removed (never by comparing dates).
function hasNewAppt(appts,knownIds){
  const known=new Set((knownIds||[]).map(String));
  return appts.some(function(a){return !known.has(String(a.id));});
}

// Decide which lists one patient belongs to, and why. `ctx` carries the
// removal state. Returns reasons too, so "why isn't X showing?" has an answer.
function classify(snap,ctx){
  const out={student:false,studentOnboarding:false,onboarding:false,client:false,reasons:[]};
  const id=String(snap.id);
  const appts=(snap.appointments||[]).filter(function(a){return !!a.start;});
  if(snap.apptsSyncedAt===null||snap.apptsSyncedAt===undefined){out.reasons.push('appointments not fetched from Splose yet');return out;}
  if(!appts.length){out.reasons.push('no appointments in Splose');return out;}
  if(ctx.notMyClient.has(id)){out.reasons.push('marked not-my-client (permanently excluded)');return out;}

  // Students
  const mentoring=appts.filter(function(a){return MENTORING_IDS.has(Number(a.serviceId));});
  if(mentoring.length){
    const firstMentor=dateOf(mentoring.slice().sort(byStartAsc)[0].start);
    const done=(ctx.studentOnboardingDone&&ctx.studentOnboardingDone.has(id))||(ctx.studentManualNames&&ctx.studentManualNames.has(normName(snap.name)));
    const soStart=ctx.studentOnboardingStart||STUDENT_ONBOARDING_START;
    if(firstMentor>=soStart&&!done){
      out.studentOnboarding=true;
      out.reasons.push('new student: first mentoring session '+firstMentor+' is on/after '+soStart+', so they stay in Student Onboarding until marked complete');
    }else{
      const rem=ctx.removedStudents[id];
      if(!rem||hasNewAppt(mentoring,rem.ids)){out.student=true;out.reasons.push('student: has a mentoring appointment'+(firstMentor>=soStart?' and onboarding is complete':' (started '+firstMentor+', before the new-student start date '+soStart+')'));}
      else out.reasons.push('removed from Students and no new mentoring appointment since');
    }
  }

  // Onboarding
  const asc=appts.slice().sort(byStartAsc);
  const first=asc[0];
  if(dateOf(first.start)>=ONBOARDING_START){
    if(ctx.onboardingRemoved.has(id)||(ctx.onboardingRemovedNames&&ctx.onboardingRemovedNames.has(normName(snap.name)))){out.reasons.push('onboarding already completed/removed (including a hand-entered entry with the same name)');}
    else if(asc.some(function(a){return ONBOARDING_STUDENT_IDS.has(Number(a.serviceId));})){out.reasons.push('has a student/mentoring service so not client onboarding');}
    else{out.onboarding=true;}
  }else{
    out.reasons.push('first appointment '+dateOf(first.start)+' is before onboarding start '+ONBOARDING_START);
  }

  // Clients
  const real=appts.filter(function(a){return Number(a.serviceId)!==CHECKIN_ID;});
  const hasRecent=real.some(function(a){return dateOf(a.start)>=RECENT_START;});
  const hasNonStudent=appts.some(function(a){return !STUDENT_IDS.has(Number(a.serviceId))&&Number(a.serviceId)!==CHECKIN_ID;});
  if(hasRecent&&hasNonStudent&&!out.onboarding){
    const rem=ctx.removedClients[id];
    if(!rem||hasNewAppt(real,rem.ids))out.client=true;
    else out.reasons.push('removed from Clients and no new appointment since');
  }else if(!out.onboarding){
    if(!hasRecent)out.reasons.push('no non-check-in appointment since '+RECENT_START);
    else if(!hasNonStudent)out.reasons.push('only student/check-in services');
  }
  return out;
}

function pickMobile(m){return m||null;}

function clientEntry(snap,ctx){
  const sorted=(snap.appointments||[]).filter(function(a){return !!a.start;}).sort(byStartDesc);
  const lastReal=sorted.find(function(a){return Number(a.serviceId)!==CHECKIN_ID;});
  const id=String(snap.id);
  return {id:id,name:snap.name,mobile:pickMobile(snap.mobile),practitioner:snap.practitioner||'',
    lastRealAppt:lastReal?dateOf(lastReal.start):null,
    appointments:sorted.map(function(a){return {id:String(a.id),date:dateOf(a.start),serviceId:a.serviceId,isCheckin:Number(a.serviceId)===CHECKIN_ID};}),
    tasks:ctx.tasks[id]||[],manualStatus:ctx.statuses[id]||null,followupDays:ctx.overrides[id]||null,lastAction:ctx.lastActions[id]||null};
}

function studentEntry(snap,ctx){
  const id=String(snap.id);
  const mentoring=(snap.appointments||[]).filter(function(a){return a.start&&MENTORING_IDS.has(Number(a.serviceId));});
  const interactions=mentoring.filter(function(a){return INTERACTION_IDS.has(Number(a.serviceId));}).sort(byStartDesc);
  const sv=ctx.statuses[id];
  const programs=(sv&&sv.indexOf('programs_')===0)?sv.slice(9).split(',').filter(Boolean):[];
  return {id:id,name:snap.name,practitioner:snap.practitioner||'',mobile:ctx.phones[id]||pickMobile(snap.mobile),
    appointments:interactions.map(function(a){return {id:String(a.id),date:dateOf(a.start),serviceId:a.serviceId,isCheckin:Number(a.serviceId)===CHECKIN_ID};}),
    tasks:ctx.tasks[id]||[],programs:programs,lastAction:ctx.lastActions[id]||null};
}

const STUDENT_TASK_NAMES=["T's & C's Sent","T's & C's Signed",'Deposit Invoice sent','Deposit Paid','Signed Mentor Agreement & Application Email sent','Application successful','Circle invite sent','Circle Released','Welcome Direct message sent on Circle','Emailed FH to confirm they are in','Added to 2122'];
function defaultStudentTasks(id){
  return STUDENT_TASK_NAMES.map(function(n,i){return {id:'so'+(i+1)+'_'+id,a:'Annie',n:n,done:false};});
}
function defaultOnboardingTasks(id){
  return ONBOARDING_DEFAULT_TASKS.map(function(t){return Object.assign({},t,{id:t.id+'_'+id});});
}

function studentOnboardingEntry(snap,ctx,twin){
  const id=String(snap.id);
  const mentoring=(snap.appointments||[]).filter(function(a){return a.start&&MENTORING_IDS.has(Number(a.serviceId));}).sort(byStartAsc);
  var tasks=ctx.onboardingTasks[id];
  if(!tasks&&twin)tasks=ctx.onboardingTasks[String(twin.id)]||twin.tasks;
  const sv=ctx.statuses[id];
  var programs=(sv&&sv.indexOf('programs_')===0)?sv.slice(9).split(',').filter(Boolean):[];
  if(!programs.length&&twin&&twin.program)programs=String(twin.program).split(',').filter(Boolean);
  return {id:id,name:snap.name,program:programs[0]||null,programs:programs,firstAppt:dateOf(mentoring[0].start),
    tasks:tasks||defaultStudentTasks(id),lastAction:ctx.lastActions[id]||null};
}

function onboardingEntry(snap,ctx,twinIds){
  const id=String(snap.id);
  const asc=(snap.appointments||[]).filter(function(a){return !!a.start;}).sort(byStartAsc);
  var tasks=ctx.onboardingTasks[id];
  if(!tasks){for(var i=0;i<(twinIds||[]).length&&!tasks;i++)tasks=ctx.onboardingTasks[twinIds[i]];}
  return {id:id,name:snap.name,practitioner:snap.practitioner||'',firstAppt:dateOf(asc[0].start),
    tasks:tasks||defaultOnboardingTasks(id),lastAction:ctx.lastActions[id]||null};
}

// ctx fields (all plain data):
//   snapshots[]            from Splose, one per patient
//   removedClients/removedStudents   {id:{ids:[...]}}
//   onboardingRemoved, notMyClient   Sets of ids
//   tasks, statuses, overrides, lastActions, phones, onboardingTasks   {id:...}
//   manual {clients:[], onboarding:[]}   hand-entered entries (separate table)
//   legacy {clients:[], students:[], onboarding:[]}   old cache, read-only,
//        used only for people whose appointments haven't been fetched yet
function deriveAll(ctx){
  const clients=[],students=[],onboarding=[],studentOnboarding=[];
  // If a hand-entered onboarding person was completed/removed, the real Splose
  // record for the same name must not bring them back into Onboarding.
  ctx=Object.assign({},ctx,{onboardingRemovedNames:new Set((ctx.manual.onboarding||[]).filter(function(m){return ctx.onboardingRemoved.has(String(m.id));}).map(function(m){return normName(m.name);}))});
  const snapById={};
  ctx.snapshots.forEach(function(s){snapById[String(s.id)]=s;});

  // Manual entries that share a name with a real person: their ids, so a
  // manual entry's ticked tasks follow the person onto their real record.
  const manualByName={};
  (ctx.manual.onboarding||[]).concat(ctx.manual.clients||[]).forEach(function(m){
    const k=normName(m.name);if(!k)return;
    (manualByName[k]=manualByName[k]||[]).push(String(m.id));
  });

  ctx.snapshots.forEach(function(snap){
    const c=classify(snap,ctx);
    if(c.student)students.push(studentEntry(snap,ctx));
    if(c.studentOnboarding)studentOnboarding.push({snap:snap});
    if(c.onboarding)onboarding.push(onboardingEntry(snap,ctx,manualByName[normName(snap.name)]));
    if(c.client)clients.push(clientEntry(snap,ctx));
  });

  // Student Onboarding: automatic entries (above) plus hand-entered ones. A
  // hand-entered entry is hidden once the real record for the same name is
  // here, and its ticked tasks/program follow the person.
  const soManual=(ctx.studentOnboardingManual||[]).filter(function(m){return !ctx.onboardingRemoved.has(String(m.id));});
  const soManualByName={};soManual.forEach(function(m){soManualByName[normName(m.name)]=m;});
  const soAuto=studentOnboarding.map(function(x){return studentOnboardingEntry(x.snap,ctx,soManualByName[normName(x.snap.name)]);});
  const soAutoNames=new Set(soAuto.map(function(a){return normName(a.name);}));
  const soOut=soAuto.concat(soManual.filter(function(m){return !soAutoNames.has(normName(m.name));}).map(function(m){return Object.assign({},m,{id:String(m.id),tasks:ctx.onboardingTasks[String(m.id)]||m.tasks||defaultStudentTasks(String(m.id))});}));

  // Hand-entered onboarding people. Hidden (never deleted) once the real
  // Splose record for the same person is in Onboarding, or once removed.
  const realOnboardNames=new Set(onboarding.map(function(o){return normName(o.name);}));
  (ctx.manual.onboarding||[]).forEach(function(m){
    const id=String(m.id);
    if(ctx.onboardingRemoved.has(id))return;
    if(realOnboardNames.has(normName(m.name)))return;
    if(onboarding.some(function(o){return o.id===id;}))return;
    onboarding.push(Object.assign({},m,{id:id,tasks:ctx.onboardingTasks[id]||m.tasks||defaultOnboardingTasks(id),lastAction:ctx.lastActions[id]||null,manual:true}));
  });

  // Hand-entered clients (people marked onboarding-complete before Splose had
  // them). Hidden once a real client with the same name exists, or removed.
  const realClientNames=new Set(clients.map(function(c){return normName(c.name);}));
  (ctx.manual.clients||[]).forEach(function(m){
    const id=String(m.id);
    if(ctx.removedClients[id])return;
    if(realClientNames.has(normName(m.name)))return;
    if(clients.some(function(c){return c.id===id;}))return;
    clients.push(Object.assign({mobile:null,practitioner:'',lastRealAppt:null,appointments:[],manualStatus:null,followupDays:null},m,{id:id,tasks:ctx.tasks[id]||m.tasks||[],manualStatus:ctx.statuses[id]||null,followupDays:ctx.overrides[id]||null,lastAction:ctx.lastActions[id]||null}));
  });

  // Old cache: only for people whose appointments haven't been fetched yet
  // (first run after upgrading). Read-only, and ignored once they have been.
  const fetched=function(id){var s=snapById[id];return !!(s&&s.apptsSyncedAt);};
  const legacy=ctx.legacy||{};
  const isManualId=function(id){return /^(ob|so)_/.test(id);};
  (legacy.clients||[]).forEach(function(c){
    const id=String(c.id);
    if(fetched(id)||isManualId(id)||ctx.removedClients[id]||ctx.notMyClient.has(id))return;
    if(clients.some(function(x){return x.id===id;}))return;
    clients.push(Object.assign({},c,{id:id,tasks:ctx.tasks[id]||c.tasks||[],manualStatus:ctx.statuses[id]||null,followupDays:ctx.overrides[id]||null,lastAction:ctx.lastActions[id]||null,mobile:c.mobile||null}));
  });
  (legacy.students||[]).forEach(function(s){
    const id=String(s.id);
    if(fetched(id)||isManualId(id)||ctx.removedStudents[id]||ctx.notMyClient.has(id))return;
    if(students.some(function(x){return x.id===id;}))return;
    const sv=ctx.statuses[id];
    const programs=(sv&&sv.indexOf('programs_')===0)?sv.slice(9).split(',').filter(Boolean):[];
    students.push(Object.assign({},s,{id:id,tasks:ctx.tasks[id]||s.tasks||[],programs:programs,lastAction:ctx.lastActions[id]||null,mobile:ctx.phones[id]||s.mobile||null}));
  });
  (legacy.onboarding||[]).forEach(function(o){
    const id=String(o.id);
    if(o.manual||fetched(id)||isManualId(id)||ctx.onboardingRemoved.has(id)||ctx.notMyClient.has(id))return;
    if(onboarding.some(function(x){return x.id===id;}))return;
    onboarding.push(Object.assign({},o,{id:id,tasks:ctx.onboardingTasks[id]||o.tasks||defaultOnboardingTasks(id),lastAction:ctx.lastActions[id]||null}));
  });

  return {clients:clients,students:students,onboarding:onboarding,studentOnboarding:soOut};
}

module.exports={STUDENT_ONBOARDING_START,defaultStudentTasks,CHECKIN_ID,STUDENT_IDS,MENTORING_IDS,INTERACTION_IDS,ONBOARDING_STUDENT_IDS,ONBOARDING_START,RECENT_START,ONBOARDING_DEFAULT_TASKS,normName,dateOf,hasNewAppt,classify,deriveAll,defaultOnboardingTasks};
