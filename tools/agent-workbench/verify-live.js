import { mkdir,writeFile } from 'node:fs/promises';
const base='http://127.0.0.1:3188';
const status=await (await fetch(base+'/api/status')).json();
console.log(JSON.stringify({event:'connected',liveConfigured:status.liveConfigured,model:status.model}));
await mkdir(new URL('./evidence/',import.meta.url),{recursive:true});
const cases=[
  {name:'fixture-skills',input:status.exampleInput},
  {name:'live-skills-english',input:{...status.exampleInput,mode:'live'}},
  {name:'live-current-english',input:{...status.exampleInput,mode:'live',engine:'current'}},
  {name:'live-skills-writing',input:{goal:{title:'写清楚一篇产品需求说明',base:'能列功能点，但经常遗漏使用情境和验收条件',criterion:'独立写出一份包含目标用户、使用情境、功能边界和可检查验收条件的需求说明',minutes:25},preferences:'只用文字，不依赖付费课程',evidenceMode:'text',engine:'skills',mode:'live'}}
];
let failures=0;
for(const {name,input} of cases){
  const response=await fetch(base+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Token':status.token},body:JSON.stringify(input)});
  const job=await response.json();if(!response.ok)throw Error(JSON.stringify(job));
  console.log(JSON.stringify({event:'started',name,id:job.id}));const start=Date.now();let finished=false;
  while(Date.now()-start<160000){const current=await (await fetch(base+'/api/jobs/'+job.id)).json();if(current.status!=='running'){
    await writeFile(new URL('./evidence/'+name+'.json',import.meta.url),JSON.stringify(current,null,2));
    console.log(JSON.stringify({event:'finished',name,status:current.status,error:current.error,nodes:current.result?.projection.nodes.length,tasks:current.result?.projection.tasks.length,elapsedMs:current.result?.elapsedMs}));
    if(current.status!=='completed')failures++;finished=true;break;
  }await new Promise(r=>setTimeout(r,1500));}
  if(!finished)throw Error('poll_timeout');
}
process.exitCode=failures?1:0;
