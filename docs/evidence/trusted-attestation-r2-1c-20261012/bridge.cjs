'use strict';
// Research protocol model. No storage acquisition, enrollment, or production use.
const crypto = require('crypto');
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
class Verifier {
  constructor(pub, context, now=()=>Number(process.hrtime.bigint()/1000000n)) {
    this.pub=pub; this.ctx=context; this.now=now; this.pending=null; this.lease=null;
    this.epoch=crypto.randomBytes(32).toString('hex'); this.seq=0; this.fenced=false;
  }
  challenge(observed) {
    if(this.fenced) throw Error('FENCED');
    this.lease=null;
    this.pending={nonce:crypto.randomBytes(32).toString('hex'),epoch:this.epoch,
      deployment:this.ctx.deployment,observation:observed};
    this.deadline=this.now()+this.ctx.ttlMs; return this.pending;
  }
  decode(envelope) {
    if(!envelope || typeof envelope.body!=='string' || typeof envelope.signature!=='string' ||
       envelope.body.length>16384 || envelope.signature.length>256) throw Error('MALFORMED');
    const body=Buffer.from(envelope.body,'base64');
    if(!crypto.verify(null,body,this.pub,Buffer.from(envelope.signature,'base64'))) throw Error('SIGNATURE');
    const t=JSON.parse(body.toString('utf8'));
    if(t.v!==1 || !Number.isSafeInteger(t.seq) || t.seq<=this.seq) throw Error('SEQUENCE');
    if(t.boot!==this.ctx.boot || t.observer!==this.ctx.observer ||
       t.revision!==this.ctx.revision || t.enrollment!==this.ctx.enrollment ||
       t.deployment!==this.ctx.deployment || t.epoch!==this.epoch) throw Error('CONTEXT');
    return t;
  }
  accept(envelope) {
    // Any invalid response fences this acquisition attempt; no fallback.
    try {
      const t=this.decode(envelope);
      if(this.fenced || !this.pending || this.now()>=this.deadline) throw Error('STALE_OR_ABSENT');
      if(t.kind!=='lease' || t.nonce!==this.pending.nonce ||
         !eq(t.observation,this.pending.observation) || !eq(t.expected,this.ctx.expected) ||
         t.ttlMs!==this.ctx.ttlMs || t.state!=='active') throw Error('BINDING');
      this.seq=t.seq; this.pending=null; this.lease={deadline:this.deadline,seq:t.seq};
      return true;
    } catch(e) {this.pending=null;this.lease=null;throw e;}
  }
  revoke(envelope) {
    // Channel failure/malformed revocation also fences locally.
    try { const t=this.decode(envelope); if(t.kind!=='revoke') throw Error('KIND');this.seq=t.seq; }
    finally {this.fenced=true;this.pending=null;this.lease=null;}
  }
  admit() {
    if(this.fenced || !this.lease || this.now()>=this.lease.deadline) throw Error('OFFLINE');
    return this.lease.seq; // Does NOT cancel an already admitted/in-kernel operation.
  }
}
function sign(key,t) {const b=Buffer.from(JSON.stringify(t));return {body:b.toString('base64'),signature:crypto.sign(null,b,key).toString('base64')};}
function lease(ctx,q,workload) {
  // Never spread consumer input into trusted authority context.
  if(!q || typeof q.nonce!=='string' || typeof q.epoch!=='string' ||
     !eq(Object.keys(q).sort(),['deployment','epoch','nonce','observation']) ||
     !/^[a-f0-9]{64}$/.test(q.nonce) || !/^[a-f0-9]{64}$/.test(q.epoch) ||
     q.deployment!==ctx.deployment) throw Error('CHALLENGE_SCHEMA');
  return {v:1,...ctx,epoch:q.epoch,nonce:q.nonce,observation:q.observation,
    kind:'lease',state:'active',seq:1,workload};
}
module.exports={Verifier,sign,eq,lease};
