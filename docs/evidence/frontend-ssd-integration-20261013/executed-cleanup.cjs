'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const evidenceDir=path.join(__dirname,'../evidence');
const file=path.join(evidenceDir,'fixture-private.json');
const state=JSON.parse(fs.readFileSync(file));
if(!/^hc-frontend-ssd-[a-f0-9]{10}$/.test(state.id))throw Error('Invalid owned fixture ID');
const allowedContainers=new Set(['db','on','off'].map(suffix=>state.id+'-'+suffix));
const allowedVolumes=new Set(['on','off'].map(suffix=>state.id+'-'+suffix+'-ssd'));
function validate(values,allowed,type){
 if(!Array.isArray(values)||new Set(values).size!==values.length||values.some(name=>!allowed.has(name)))throw Error('Foreign or duplicate '+type);
}
validate(state.containers,allowedContainers,'container');
validate(state.volumes,allowedVolumes,'volume');
if(state.network!==state.id+'-net')throw Error('Foreign network');
function docker(args){
 const result=spawnSync('docker',args,{encoding:'utf8'});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error((result.stderr||result.stdout||'Docker failed').trim());
 return result.stdout.trim();
}
function present(type,name){
 const result=spawnSync('docker',[type,'inspect',name,'--format','{{.Name}}'],{encoding:'utf8'});
 if(result.error)throw result.error;
 if(result.status!==0){if(/No such|not found|does not exist/.test(result.stderr))return false;throw Error(result.stderr.trim());}
 if(result.stdout.trim().replace(/^\//,'')!==name)throw Error('Unexpected inspected '+type+' name');
 return true;
}
const removed={containers:[],volumes:[],networks:[]},alreadyAbsent={containers:[],volumes:[],networks:[]};
for(const name of state.containers){if(present('container',name)){docker(['rm','-f','-v',name]);removed.containers.push(name);}else alreadyAbsent.containers.push(name);}
for(const name of state.volumes){if(present('volume',name)){docker(['volume','rm',name]);removed.volumes.push(name);}else alreadyAbsent.volumes.push(name);}
if(present('network',state.network)){docker(['network','rm',state.network]);removed.networks.push(state.network);}else alreadyAbsent.networks.push(state.network);
fs.writeFileSync(path.join(evidenceDir,'fixture-cleanup.json'),JSON.stringify({id:state.id,removed,alreadyAbsent},null,2));
fs.unlinkSync(file);
