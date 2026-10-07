import { writeFileSync } from 'node:fs';
import { workbenchContracts } from './workbench-contract.js';
const c=workbenchContracts();
for(const [name,key] of [['agent-response','response'],['skill-node','skillNode'],['task','task'],['plan','plan']])writeFileSync(name+'.schema.json',JSON.stringify(c[key],null,2));
