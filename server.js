require('dotenv').config();
const express=require('express'),multer=require('multer'),nodemailer=require('nodemailer'),webpush=require('web-push'),
 fs=require('fs'),path=require('path'),crypto=require('crypto'),{Pool}=require('pg');
const E=process.env,app=express();
app.use('/api/assistant',express.json({limit:'8mb'}));app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:6}});

/* shared Postgres store (replaces data.json so every machine sees the same data) */
if(!E.DATABASE_URL){console.error('DATABASE_URL is not set. Add it as a secret (fly postgres attach / fly secrets set).');process.exit(1)}
const pool=new Pool({connectionString:E.DATABASE_URL,ssl:E.PGSSL==='true'?{rejectUnauthorized:false}:false});
const REMINDER_LOCK=911001,SUMMARY_LOCK=911002;

/* push keys */
if(!E.VAPID_PUBLIC||!E.VAPID_PRIVATE){const k=webpush.generateVAPIDKeys();console.log('Add these to .env:\nVAPID_PUBLIC='+k.publicKey+'\nVAPID_PRIVATE='+k.privateKey);process.exit(1)}
webpush.setVapidDetails('mailto:'+E.OWNER_EMAIL,E.VAPID_PUBLIC,E.VAPID_PRIVATE);

/* email */
const mail=nodemailer.createTransport({service:'gmail',auth:{user:E.OWNER_EMAIL,pass:E.GMAIL_APP_PASSWORD}});

/* WhatsApp Cloud API (Meta) */
const WA=`https://graph.facebook.com/v20.0/${E.WA_PHONE_ID}`,H={Authorization:'Bearer '+E.WA_TOKEN};
const waSend=o=>fetch(WA+'/messages',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:E.OWNER_WHATSAPP,...o})}).then(async r=>{if(!r.ok)throw new Error('WhatsApp '+await r.text())});
const clean=t=>String(t||'').replace(/[\n\t]+/g,' | ').replace(/ {2,}/g,' ').slice(0,300);
const waTemplate=p=>waSend({type:'template',template:{name:E.WA_TEMPLATE,language:{code:E.WA_LANG||'en'},components:[{type:'body',parameters:p.map(t=>({type:'text',text:clean(t)||'-'}))}]}});
async function waMedia(f,ref,name){
 const t=f.mimetype.startsWith('video')?'video':f.mimetype.startsWith('image')?'image':null;if(!t)throw new Error('unsupported file type '+f.mimetype);
 const lim=t==='video'?16:5;if(f.size>lim*1048576)throw new Error(f.originalname+' is over the WhatsApp '+lim+'MB limit (it is in your email)');
 const fd=new FormData();fd.append('messaging_product','whatsapp');fd.append('type',f.mimetype);
 fd.append('file',new Blob([f.buffer],{type:f.mimetype}),f.originalname);
 const m=await(await fetch(WA+'/media',{method:'POST',headers:H,body:fd})).json();if(!m.id)throw new Error('Media upload failed: '+JSON.stringify(m));
 const tpl=t==='video'?E.WA_TEMPLATE_VIDEO:E.WA_TEMPLATE_IMAGE;
 if(!tpl)return waSend({type:t,[t]:{id:m.id}});
 return waSend({type:'template',template:{name:tpl,language:{code:E.WA_LANG||'en'},components:[{type:'header',parameters:[{type:t,[t]:{id:m.id}}]},
  {type:'body',parameters:[{type:'text',text:clean(ref)},{type:'text',text:clean(name)||'-'}]}]}})}

/* push helper: takes an array of raw webpush subscription objects (each has .endpoint) */
async function push(subs,payload){for(const sub of subs){try{await webpush.sendNotification(sub,JSON.stringify(payload))}
 catch(e){if(e.statusCode===404||e.statusCode===410)await pool.query('DELETE FROM subs WHERE endpoint=$1',[sub.endpoint]).catch(console.error)}}}

/* rate limits: kept in-memory per machine. With N machines the effective ceiling is roughly N times
   these numbers, since Fly's load balancer can spread one IP's requests across machines. Fine for
   abuse protection on a small business app; move to a shared store later if that ever matters. */
const rateLimiter=max=>{const h={};return(req,res,next)=>{const now=Date.now();h[req.ip]=(h[req.ip]||[]).filter(t=>now-t<36e5);
 if(h[req.ip].length>=max)return res.status(429).json({error:'Too many requests. Please try again later.'});h[req.ip].push(now);next()}};

app.set('trust proxy',1);
app.use('/api/request',rateLimiter(10));
/* customer submits a booking or problem (+ photos/videos) */
app.post('/api/request',upload.array('files'),async(req,res)=>{
 const b=req.body,files=req.files||[];
 if(!b.name||!b.phone||!(b.details||b.address))return res.status(400).json({error:'Missing details'});
 const id='EC-'+crypto.randomBytes(3).toString('hex').toUpperCase(),type=b.type==='book'?'Booking':'Problem';
 const urgent=b.urgent==='1',email=String(b.email||'').trim().toLowerCase();
 const rq=String(b.ref||'').trim().toUpperCase();
 let rb='';
 if(rq){const ur=await pool.query('SELECT email FROM users WHERE ref=$1',[rq]);
  if(ur.rows[0]&&ur.rows[0].email!==email&&type==='Booking')rb=ur.rows[0].email}
 if(type==='Booking'){const cap=+E.SLOT_CAPACITY||1;
  const cnt=await pool.query("SELECT COUNT(*) FROM tickets WHERE type='Booking' AND date=$1 AND time=$2 AND status<>'Cancelled'",[b.date,b.time]);
  if(+cnt.rows[0].count>=cap)return res.status(409).json({error:'That time slot is already booked. Please choose another.'})}
 await pool.query(`INSERT INTO tickets(id,type,status,answer,email,name,phone,service,date,time,details,urgent,refby,created)
  VALUES($1,$2,'Received','',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [id,type,email,b.name,b.phone,b.service||'',b.date||'',b.time||'',String(b.details||b.address||'').slice(0,300),urgent,rb,Date.now()]);
 const text=`*${urgent?'URGENT ':''}${type} ${id}*\nName: ${b.name}\nPhone: ${b.phone}\nService: ${b.service}\n`+
  (b.date?`When: ${b.date} ${b.time}\nAddress: ${b.address}\n`:'')+`Details: ${b.details||''}${rb?'\nReferred by: '+rb:''}\nFiles: ${files.length}`;
 const owner=[mail.sendMail({from:E.OWNER_EMAIL,to:E.OWNER_EMAIL,replyTo:b.email||undefined,subject:`${urgent?'🚨 URGENT ':''}${type} ${id} - ${b.service}`,text,
  attachments:files.map(f=>({filename:f.originalname,content:f.buffer}))})];
 if(E.WA_TOKEN)owner.push((E.WA_TEMPLATE?waTemplate([`${urgent?'URGENT ':''}${type} ${id}`,b.name,b.phone,`${b.service}${b.date?' on '+b.date+' '+b.time:''}: ${b.details||b.address}`,files.length?files.length+' (also in your email)':'none'])
  :waSend({type:'text',text:{body:text}})).then(()=>Promise.allSettled(files.map(f=>waMedia(f,id,b.name))))
  .then(rs=>rs.forEach(x=>x.status==='rejected'&&console.error('WhatsApp media skipped (outside 24h window?):',x.reason.message))));
 const r=await Promise.allSettled(owner);r.forEach(x=>x.status==='rejected'&&console.error(x.reason));
 if(r.every(x=>x.status==='rejected'))return res.status(502).json({error:'Could not deliver. Please call us.'});
 if(b.email)mail.sendMail({from:E.OWNER_EMAIL,to:b.email,subject:`Electro Clinic - we received your ${type.toLowerCase()} (${id})`,
  text:`Hi ${b.name},\n\nThanks for contacting Electro Clinic. Your reference is ${id}. We will reply shortly.`}).catch(console.error);
 res.json({id})});

/* customer checks answers */
app.get('/api/tickets',async(req,res)=>{
 const ids=String(req.query.ids||'').split(',').filter(Boolean);
 if(!ids.length)return res.json([]);
 const r=await pool.query('SELECT id,type,status,answer,stars,date,time FROM tickets WHERE id=ANY($1)',[ids]);
 res.json(r.rows)});

/* push subscriptions */
app.get('/api/vapid-key',(q,r)=>r.json({key:E.VAPID_PUBLIC}));
app.post('/api/subscribe',async(req,res)=>{const{sub,ids=[]}=req.body;if(!sub||!sub.endpoint)return res.sendStatus(400);
 const ex=await pool.query('SELECT ids FROM subs WHERE endpoint=$1',[sub.endpoint]);
 const merged=[...new Set([...(ex.rows[0]?ex.rows[0].ids:[]),...ids])];
 await pool.query('INSERT INTO subs(endpoint,sub,ids) VALUES($1,$2,$3) ON CONFLICT(endpoint) DO UPDATE SET sub=$2,ids=$3',[sub.endpoint,sub,merged]);
 res.sendStatus(204)});

/* daily news (cached 1h, per machine - harmless duplication) */
let nc={t:0,d:[]};
app.get('/api/news',async(q,res)=>{if(!E.GNEWS_KEY)return res.json([]);
 if(Date.now()-nc.t>36e5){try{const j=await(await fetch(`https://gnews.io/api/v4/top-headlines?category=general&country=za&lang=en&max=6&apikey=${E.GNEWS_KEY}`)).json();
  nc={t:Date.now(),d:(j.articles||[]).map(a=>({title:a.title,description:a.description,url:a.url}))}}catch(e){console.error(e)}}
 res.json(nc.d)});

/* owner-only: reply to a customer / notify everyone */
const admin=(req,res,next)=>req.get('x-admin-key')&&req.get('x-admin-key')===E.ADMIN_KEY?next():res.sendStatus(401);
app.post('/api/admin/reply',admin,async(req,res)=>{const{id,answer,status}=req.body;
 const tr=await pool.query('SELECT * FROM tickets WHERE id=$1',[id]);const t=tr.rows[0];if(!t)return res.sendStatus(404);
 const newStatus=status||'Answered',newAnswer=answer||t.answer;
 await pool.query('UPDATE tickets SET answer=$1,status=$2 WHERE id=$3',[newAnswer,newStatus,id]);
 if(newStatus==='Completed'&&t.refby&&!t.refpaid){
  const ur=await pool.query('SELECT email FROM users WHERE email=$1',[t.refby]);
  if(ur.rows[0]){await pool.query('UPDATE tickets SET refpaid=true WHERE id=$1',[id]);
   await pool.query('UPDATE users SET credits=credits+1 WHERE email=$1',[t.refby]);
   const cfg=await pool.query('SELECT reward FROM config WHERE id=1');
   mail.sendMail({from:E.OWNER_EMAIL,to:t.refby,subject:'You earned a referral reward!',text:`A friend you referred has completed a job with Electro Clinic. Reward: ${cfg.rows[0]?.reward||'ask us'}. Mention it on your next booking.`}).catch(console.error)}}
 const subsR=await pool.query('SELECT sub FROM subs WHERE $1=ANY(ids)',[id]);
 await push(subsR.rows.map(r=>r.sub),{title:'Electro Clinic replied',body:newAnswer,url:'/'});
 if(t.email)mail.sendMail({from:E.OWNER_EMAIL,to:t.email,subject:`Electro Clinic reply (${id})`,text:newAnswer}).catch(console.error);
 res.sendStatus(204)});
app.post('/api/admin/notify',admin,async(req,res)=>{const{title,body,url}=req.body;
 const all=await pool.query('SELECT sub FROM subs');
 await push(all.rows.map(r=>r.sub),{title:title||'Electro Clinic',body,url:url||'/'});res.sendStatus(204)});

/* booked time slots for a date */
app.get('/api/slots',async(req,res)=>{const cap=+E.SLOT_CAPACITY||1;
 const r=await pool.query("SELECT time,COUNT(*) c FROM tickets WHERE type='Booking' AND date=$1 AND status<>'Cancelled' GROUP BY time",[req.query.date]);
 res.json(r.rows.filter(x=>+x.c>=cap).map(x=>x.time))});
/* owner: recent requests */
app.get('/api/admin/tickets',admin,async(q,res)=>{const r=await pool.query('SELECT * FROM tickets ORDER BY created DESC LIMIT 25');res.json(r.rows)});

/* 24h appointment reminders (South African time, UTC+2) - advisory lock so only one machine sends them */
setInterval(async()=>{
 const client=await pool.connect();
 try{const{rows}=await client.query('SELECT pg_try_advisory_lock($1) got',[REMINDER_LOCK]);if(!rows[0].got)return;
  const now=Date.now();
  const r=await client.query("SELECT id,date,time FROM tickets WHERE type='Booking' AND reminded=false AND status<>'Cancelled' AND date<>''");
  for(const t of r.rows){const ms=new Date(`${t.date}T${t.time}:00+02:00`)-now;
   if(ms>0&&ms<=864e5){await client.query('UPDATE tickets SET reminded=true WHERE id=$1',[t.id]);
    const subsR=await client.query('SELECT sub FROM subs WHERE $1=ANY(ids)',[t.id]);
    await push(subsR.rows.map(x=>x.sub),{title:'Appointment reminder',body:`Electro Clinic visit ${t.date} at ${t.time}. Contact us if you need to change it.`,url:'/'})}}
  await client.query('SELECT pg_advisory_unlock($1)',[REMINDER_LOCK])}
 catch(e){console.error(e)}finally{client.release()}
},36e5);

/* AI helper (Claude API): safe first-line troubleshooting */
const bizInfo=async()=>{const r=await pool.query('SELECT hours,areas,fee FROM config WHERE id=1');const c=r.rows[0]||{};
 return (c.hours?" Opening hours: "+c.hours+".":"")+(c.areas&&c.areas.length?" Areas served: "+c.areas.join(", ")+".":"")+(c.fee?" Call-out fee: "+c.fee+".":"")};
const SYS="You are the Electro Clinic assistant for a South African appliance repair, refrigeration and electrical company. Give simple, SAFE troubleshooting only: check plugs, breakers, settings, filters, cleaning, airflow. Never tell anyone to open live electrical panels, appliance casings, gas or refrigerant parts, or to do wiring. If there is a burning smell, sparks, water near electricity or any shock risk, tell them to switch off at the DB board and call us or tick Urgent in the app. Reply in plain friendly language in under 120 words. If simple checks may not fix it, suggest they tap Send problem or Book in the app. Never make up prices or promise arrival times; only share opening hours, areas served or a call-out fee if they are given at the end of these instructions.";
const ah={};app.use('/api/assistant',(req,res,next)=>{const now=Date.now();ah[req.ip]=(ah[req.ip]||[]).filter(t=>now-t<36e5);
 if(ah[req.ip].length>=30)return res.status(429).json({error:'Too many questions. Please use Send problem.'});ah[req.ip].push(now);next()});
app.post('/api/assistant',async(req,res)=>{
 if(!E.ANTHROPIC_API_KEY)return res.status(503).json({error:'Assistant not set up'});
 const msgs=(req.body.messages||[]).slice(-10).map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content).slice(0,1000)}));
 while(msgs.length&&msgs[0].role!=='user')msgs.shift();if(!msgs.length)return res.sendStatus(400);
 const im=req.body.image;if(im&&/^image\/(jpeg|png|webp)$/.test(im.media_type)&&typeof im.data==='string'&&im.data.length<7e6){
  const l=msgs[msgs.length-1];if(l.role==='user')l.content=[{type:'image',source:{type:'base64',media_type:im.media_type,data:im.data}},{type:'text',text:l.content}]}
 try{const info=await bizInfo();
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':E.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
  body:JSON.stringify({model:E.ANTHROPIC_MODEL||'claude-sonnet-5',max_tokens:500,system:SYS+info+' Reply in the same language the customer writes in (English, Afrikaans, isiZulu and so on). If a photo is attached, describe what you can actually see (error codes, model labels, visible damage) and do not guess at faults you cannot see.',messages:msgs})});
  const j=await r.json();if(!r.ok)throw new Error(JSON.stringify(j));res.json({reply:(j.content||[]).map(c=>c.text||'').join('')})}
 catch(e){console.error(e);res.status(502).json({error:'Assistant unavailable'})}});

/* customer rates a completed job */
app.post('/api/rate',async(req,res)=>{const n=+req.body.stars;
 const tr=await pool.query('SELECT * FROM tickets WHERE id=$1',[req.body.id]);const t=tr.rows[0];
 if(!t||t.status!=='Completed'||t.stars||!(n>=1&&n<=5))return res.sendStatus(400);
 const review=String(req.body.comment||'').slice(0,300);
 await pool.query('UPDATE tickets SET stars=$1,review=$2 WHERE id=$3',[n,review,t.id]);
 mail.sendMail({from:E.OWNER_EMAIL,to:E.OWNER_EMAIL,subject:`${'⭐'.repeat(n)} rating for ${t.id}`,text:`${t.name} rated ${n}/5\n${review}`}).catch(console.error);res.sendStatus(204)});

/* 07:00 (SAST) email: today's jobs - advisory lock + a stored "already sent today" flag so it only fires once */
setInterval(async()=>{
 const n=new Date(Date.now()+72e5),day=n.toISOString().slice(0,10);
 if(n.getUTCHours()!==7)return;
 const client=await pool.connect();
 try{const{rows}=await client.query('SELECT pg_try_advisory_lock($1) got',[SUMMARY_LOCK]);if(!rows[0].got)return;
  const st=await client.query("SELECT value FROM state WHERE key='sumday'");
  if(st.rows[0]&&st.rows[0].value===day){await client.query('SELECT pg_advisory_unlock($1)',[SUMMARY_LOCK]);return}
  await client.query("INSERT INTO state(key,value) VALUES('sumday',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[day]);
  const r=await client.query("SELECT * FROM tickets WHERE type='Booking' AND date=$1 AND status<>'Cancelled' ORDER BY time",[day]);
  const l=r.rows;
  mail.sendMail({from:E.OWNER_EMAIL,to:E.OWNER_EMAIL,subject:`Today's jobs (${l.length}) - ${day}`,
   text:l.length?l.map(t=>`${t.time}  ${t.name} ${t.phone}\n   ${t.service}: ${t.details}`).join('\n\n'):'No bookings today.'}).catch(console.error);
  await client.query('SELECT pg_advisory_unlock($1)',[SUMMARY_LOCK])}
 catch(e){console.error(e)}finally{client.release()}
},6e5);

/* public business info + owner-editable banner */
app.get('/api/config',async(q,res)=>{const r=await pool.query('SELECT hours,areas,fee,notice,reward FROM config WHERE id=1');const c=r.rows[0]||{};
 res.json({assistant:!!E.ANTHROPIC_API_KEY,hours:c.hours||'',areas:c.areas||[],fee:c.fee||'',notice:c.notice||'',reward:c.reward||''})});
app.post('/api/admin/config',admin,async(req,res)=>{const b=req.body;
 await pool.query('UPDATE config SET hours=$1,areas=$2,fee=$3,notice=$4,reward=$5 WHERE id=1',
  [String(b.hours||'').slice(0,200),String(b.areas||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,30),String(b.fee||'').slice(0,100),String(b.notice||'').slice(0,200),String(b.reward||'').slice(0,100)]);
 res.sendStatus(204)});
app.get('/api/admin/stats',admin,async(q,res)=>{const m=new Date().toISOString().slice(0,7);
 const total=await pool.query('SELECT COUNT(*) c FROM tickets');
 const thisMonth=await pool.query("SELECT COUNT(*) c FROM tickets WHERE to_char(to_timestamp(created/1000.0),'YYYY-MM')=$1",[m]);
 const open=await pool.query("SELECT COUNT(*) c FROM tickets WHERE status='Received'");
 const ratings=await pool.query('SELECT stars FROM tickets WHERE stars IS NOT NULL');
 const rr=ratings.rows;
 res.json({total:+total.rows[0].c,thisMonth:+thisMonth.rows[0].c,open:+open.rows[0].c,
  ratings:rr.length,avg:rr.length?+(rr.reduce((a,x)=>a+x.stars,0)/rr.length).toFixed(1):null})});

/* ---------- customer accounts: email-code sign-in ---------- */
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),em=x=>String(x||'').trim().toLowerCase();
async function getOrCreateUser(email){
 const ref='R'+crypto.randomBytes(3).toString('hex').toUpperCase();
 const r=await pool.query('INSERT INTO users(email,ref,credits) VALUES($1,$2,0) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING *',[email,ref]);
 return r.rows[0]}
const tok=req=>(req.get('authorization')||'').replace('Bearer ','');
const authed=async(req,res,next)=>{const r=await pool.query('SELECT * FROM sessions WHERE token=$1',[tok(req)]);const s=r.rows[0];
 if(!s||+s.exp<Date.now())return res.sendStatus(401);req.email=s.email;next()};
app.post('/api/auth/start',rateLimiter(6),async(req,res)=>{const e=em(req.body.email);if(!/^\S+@\S+\.\S+$/.test(e))return res.status(400).json({error:'Enter a valid email'});
 const code=String(crypto.randomInt(100000,1000000));
 await pool.query('INSERT INTO codes(email,hash,exp,tries) VALUES($1,$2,$3,0) ON CONFLICT(email) DO UPDATE SET hash=$2,exp=$3,tries=0',[e,sha(code),Date.now()+6e5]);
 try{await mail.sendMail({from:E.OWNER_EMAIL,to:e,subject:'Your Electro Clinic sign-in code',text:`Your code is ${code}. It expires in 10 minutes.`});res.sendStatus(204)}
 catch(x){console.error(x);res.status(502).json({error:'Could not send the code'})}});
app.post('/api/auth/verify',rateLimiter(12),async(req,res)=>{const e=em(req.body.email);
 const cr=await pool.query('SELECT * FROM codes WHERE email=$1',[e]);const c=cr.rows[0];
 if(!c||+c.exp<Date.now()||c.tries>=5||sha(String(req.body.code).trim())!==c.hash){
  if(c)await pool.query('UPDATE codes SET tries=tries+1 WHERE email=$1',[e]);
  return res.status(400).json({error:'Wrong or expired code'})}
 await pool.query('DELETE FROM codes WHERE email=$1',[e]);
 const t=crypto.randomBytes(24).toString('hex');
 await pool.query('INSERT INTO sessions(token,email,exp) VALUES($1,$2,$3)',[t,e,Date.now()+90*864e5]);
 await getOrCreateUser(e);res.json({token:t})});
const pub=({id,type,status,answer,stars,date,time})=>({id,type,status,answer,stars,date,time});
app.get('/api/me',authed,async(req,res)=>{const u=await getOrCreateUser(req.email);
 const tr=await pool.query('SELECT name,phone FROM tickets WHERE email=$1 ORDER BY created DESC LIMIT 1',[req.email]);const t=tr.rows[0]||{};
 res.json({email:req.email,name:t.name||'',phone:t.phone||'',ref:u.ref,credits:u.credits})});
app.get('/api/me/tickets',authed,async(req,res)=>{
 const r=await pool.query('SELECT id,type,status,answer,stars,date,time FROM tickets WHERE email=$1 ORDER BY created DESC LIMIT 30',[req.email]);
 res.json(r.rows)});
app.post('/api/me/claim',authed,async(req,res)=>{const ids=(req.body.ids||[]).slice(0,20);
 if(ids.length)await pool.query("UPDATE tickets SET email=$1 WHERE id=ANY($2) AND (email IS NULL OR email='')",[req.email,ids]);
 res.sendStatus(204)});
app.post('/api/signout',authed,async(req,res)=>{await pool.query('DELETE FROM sessions WHERE token=$1',[tok(req)]);res.sendStatus(204)});

/* customer cancels a booking */
app.post('/api/cancel',rateLimiter(20),async(req,res)=>{const tr=await pool.query('SELECT * FROM tickets WHERE id=$1',[req.body.id]);const t=tr.rows[0];
 if(!t||t.type!=='Booking'||['Completed','Cancelled'].includes(t.status))return res.sendStatus(400);
 await pool.query("UPDATE tickets SET status='Cancelled' WHERE id=$1",[t.id]);
 mail.sendMail({from:E.OWNER_EMAIL,to:E.OWNER_EMAIL,subject:`Booking ${t.id} cancelled by customer`,text:`${t.name} (${t.phone}) cancelled ${t.service} on ${t.date} ${t.time}.`}).catch(console.error);res.sendStatus(204)});
/* owner redeems a referral credit */
app.post('/api/admin/redeem',admin,async(req,res)=>{const e=em(req.body.email);
 const ur=await pool.query('SELECT credits FROM users WHERE email=$1',[e]);const u=ur.rows[0];
 if(!u||u.credits<1)return res.sendStatus(400);
 await pool.query('UPDATE users SET credits=credits-1 WHERE email=$1',[e]);res.sendStatus(204)});

/* run schema.sql (idempotent - CREATE TABLE IF NOT EXISTS) then start listening */
(async()=>{
 try{await pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'))}
 catch(e){console.error('Schema setup failed:',e);process.exit(1)}
 app.listen(E.PORT||3000,()=>console.log('Electro Clinic running on port '+(E.PORT||3000)+' | Ask Electro: '+(E.ANTHROPIC_API_KEY?'ON':'OFF (add ANTHROPIC_API_KEY to switch on)')+' | WhatsApp: '+(E.WA_TOKEN?'ON':'OFF')))
})();
