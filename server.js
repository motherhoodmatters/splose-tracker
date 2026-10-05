const {Pool}=require('pg');
const {createApp}=require('./app');

const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,idleTimeoutMillis:30000,max:3});
const tracker=createApp({pool:pool});

tracker.app.listen(process.env.PORT||3000,async function(){
  await tracker.initDB();
  tracker.startBackground();
  console.log('Splose Tracker running at http://localhost:'+(process.env.PORT||3000));
});
