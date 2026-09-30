const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const gate=path.resolve(__dirname,'../release-gate.cjs');
function run(mode,env={}) {return new Promise(resolve=>{let out='';const p=spawn(process.execPath,[gate,mode],{env:{PATH:process.env.PATH,...env}});p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>out+=b);p.on('exit',code=>resolve({code,out}));});}
test('config fails closed without production settings and suppresses values',async()=>{const r=await run('config',{NODE_ENV:'production',JWT_SECRET:'sensitive-marker'});assert.equal(r.code,1);assert.ok(!r.out.includes('sensitive-marker'));});
test('unknown mode fails',async()=>assert.equal((await run('unknown')).code,1));
for(const [ready,metrics,expected] of [[200,401,0],[200,404,0],[503,401,1],[200,200,1]]) {
 test(`runtime ready=${ready} metrics=${metrics}`,async()=>{const server=http.createServer((req,res)=>{res.statusCode=req.url.endsWith('/metrics')?metrics:req.url.endsWith('/ready')?ready:200;res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));try {assert.equal((await run('runtime',{RELEASE_BASE_URL:`http://127.0.0.1:${server.address().port}`})).code,expected);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}});
}
