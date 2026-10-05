// Test harness: runs the real app against an in-memory Postgres and a fake
// Splose that can be told to rate-limit, fail, or return duplicates.
const {newDb}=require('pg-mem');
const {createApp}=require('../app');

const SVC={initialConsult:399700,homeVisit:399701,followUp:399702,checkin:399669,mentoring:399651,mentoring2:399621,acceptance:444486,workshop:399652};

function fakeSplose(){
  const s={
    patients:[],          // {id,firstname,lastname,practitionerId,phoneNumbers}
    appts:{},             // patientId -> [{id,start,serviceId}]
    pageSize:3,
    rateLimitAfter:null,  // after this many appointment calls, every call 429s
    apptCalls:0,
    failPatient:null,     // patientId whose appointment call returns 500
    duplicatePatientPage:false,
    practitionersDown:false,
    calls:[]
  };
  s.add=function(id,first,last,appts,extra){
    s.patients.push(Object.assign({id:id,firstname:first,lastname:last,practitionerId:66624,phoneNumbers:[{type:'Mobile',code:'+61',phoneNumber:'400000'+id}]},extra||{}));
    s.appts[id]=appts||[];
  };
  function page(list,url){
    const u=new URL(url);const pg=Number(u.searchParams.get('page')||1);
    const start=(pg-1)*s.pageSize;
    let data=list.slice(start,start+s.pageSize);
    if(s.duplicatePatientPage&&pg===2)data=data.concat(list.slice(0,1));
    const more=start+s.pageSize<list.length;
    return {data:data,links:{nextPage:more?u.pathname+'?page='+(pg+1)+(u.searchParams.get('patientId')?'&patientId='+u.searchParams.get('patientId'):''):null}};
  }
  s.fetch=async function(url){
    const u=new URL(url);
    s.calls.push(u.pathname+u.search);
    const ok=function(body){return {status:200,json:async function(){return body;}};};
    if(u.pathname==='/v1/practitioners'){
      if(s.practitionersDown)return {status:500,json:async function(){return {};}};
      return ok({data:[{id:66624,firstname:'Felicity',lastname:'Hughes'}],links:{}});
    }
    if(u.pathname==='/v1/patients')return ok(page(s.patients,url));
    if(u.pathname==='/v1/appointments'){
      s.apptCalls++;
      if(s.rateLimitAfter!==null&&s.apptCalls>s.rateLimitAfter)return {status:429,json:async function(){return {};}};
      const pid=u.searchParams.get('patientId');
      if(s.failPatient!==null&&String(pid)===String(s.failPatient))return {status:500,json:async function(){return {};}};
      return ok(page(s.appts[pid]||[],url));
    }
    return {status:404,json:async function(){return {};}};
  };
  return s;
}

async function makeEnv(opts){
  opts=opts||{};
  // TEST_PG=host:port runs against a real Postgres (one fresh database per
  // environment); otherwise an in-memory Postgres is used.
  let db=opts.db,pool;
  if(process.env.TEST_PG){
    const pg=require('pg');
    const [host,port]=process.env.TEST_PG.split(':');
    if(!db){
      const dbname='t_'+Date.now()+'_'+Math.floor(Math.random()*1e6);
      const admin=new pg.Pool({host:host,port:Number(port),database:'postgres',user:process.env.TEST_PG_USER||'claude'});
      await admin.query('CREATE DATABASE '+dbname);await admin.end();
      db={real:dbname};
    }
    pool=new pg.Pool({host:host,port:Number(port),database:db.real,user:process.env.TEST_PG_USER||'claude',max:3});
  }else{
    db=db||newDb();
    const {Pool}=db.adapters.createPg();
    pool=new Pool();
  }
  const splose=opts.splose||fakeSplose();
  let clock=opts.startTime||Date.parse('2026-10-05T04:00:00Z');
  const tracker=createApp({pool:pool,fetch:splose.fetch,apiKey:'test',base:'https://api.splose.com/v1',sleep:async function(){},now:function(){return clock;},log:function(){},config:Object.assign({apptGapMs:0,pageGapMs:0,backoffMs:0},opts.config||{})});
  if(opts.db)await tracker.migrate();else await tracker.initDB();
  const server=await new Promise(function(r){const sv=tracker.app.listen(0,function(){r(sv);});});
  const port=server.address().port;
  async function api(method,path,body){
    const res=await fetch('http://127.0.0.1:'+port+path,{method:method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return res.json();
  }
  return {db:db,pool:pool,splose:splose,tracker:tracker,api:api,advance:function(ms){clock+=ms;},now:function(){return clock;},close:function(){return new Promise(function(r){server.close(r);});},
    // a "restart": new app instance on the SAME database
    restart:async function(){await new Promise(function(r){server.close(r);});return makeEnv({db:db,splose:splose,startTime:clock,config:opts.config});}};
}

const names=function(list){return list.map(function(c){return c.name;}).sort();};
module.exports={makeEnv,fakeSplose,SVC,names};
