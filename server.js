const express=require('express'),path=require('path'),fsm=require('fs'),app=express();
app.use(express.json());
const API_KEY=process.env.SPLOSE_API_KEY||'';
const BASE='https://api.splose.com/v1';
const HEADERS={'Authorization':'Bearer '+API_KEY,'User-Agent':'splose-tracker/1.0','Content-Type':'application/json'};
const CHECKIN_ID=399669;
const CACHE=path.join(__dirname,'clients-cache.json');
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
    // Use cache if available and not a full sync
    if(!fullSync&&fsm.existsSync(CACHE)){
      const cache=JSON.parse(fsm.readFileSync(CACHE,'utf8'));
      if(cache&&cache.clients&&cache.clients.length>0){
        console.log('Serving '+cache.clients.length+' clients from cache');
        return res.json({clients:cache.clients,syncedAt:cache.savedAt,fromCache:true});
      }
    }
    // Full sync
    console.log('Full sync starting...');
    const pracs=await allPages('/practitioners').catch(function(){return [];});
    const pnames={};
    pracs.forEach(function(p){pnames[p.id]=((p.firstname||'')+' '+(p.lastname||'')).trim();});
    const patients=await allPages('/patients');
    console.log(patients.length+' patients found');
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
      const sorted=appts.filter(function(a){return !!a.start;}).sort(function(a,b){return new Date(b.start)-new Date(a.start);});
      const lastReal=sorted.find(function(a){return Number(a.serviceId)!==CHECKIN_ID;});
      clients.push({id:String(p.id),name:name,practitioner:pnames[p.practitionerId]||'',lastRealAppt:lastReal?lastReal.start.split('T')[0]:null,appointments:sorted.map(function(a){return {id:String(a.id),date:a.start.split('T')[0],serviceId:a.serviceId,isCheckin:Number(a.serviceId)===CHECKIN_ID};}),tasks:[]});
    }
    fsm.writeFileSync(CACHE,JSON.stringify({clients:clients,savedAt:new Date().toISOString()}));
    console.log('DONE! '+clients.length+' clients');
    res.json({clients:clients,syncedAt:new Date().toISOString()});
  }catch(err){console.error('Error:',err.message);res.status(500).json({error:err.message});}
});
app.post('/api/action',function(req,res){
  const clientId=req.body.clientId;
  const tasks=req.body.tasks;
  if(clientId&&tasks!==undefined){
    try{
      if(fsm.existsSync(CACHE)){
        const cache=JSON.parse(fsm.readFileSync(CACHE,'utf8'));
        cache.clients=cache.clients.map(function(c){
          if(c.id!==clientId)return c;
          return Object.assign({},c,{tasks:tasks});
        });
        fsm.writeFileSync(CACHE,JSON.stringify(cache));
      }
    }catch(e){}
  }
  res.json({ok:true});
});
app.listen(process.env.PORT||3000,function(){console.log('Splose Tracker running at http://localhost:'+(process.env.PORT||3000));});
