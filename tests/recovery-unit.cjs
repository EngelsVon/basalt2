const assert = require('node:assert/strict');
const path = require('node:path');
const { PublicKey, Keypair } = require('@solana/web3.js');
const out = path.resolve('review_artifacts/recovery/record.cjs');
require('esbuild').buildSync({entryPoints:['src/services/recordService.ts'],outfile:out,bundle:true,platform:'node',format:'cjs',external:['@solana/web3.js']});
const r = require(out);
(async () => {
 const program=Keypair.generate().publicKey, wallet=Keypair.generate().publicKey;
 const accounts=new Map(); let calls=0;
 const c={getAccountInfo:async key=>{calls++;return accounts.get(key.toBase58())||null;},getMultipleAccountsInfo:async keys=>{calls++;return keys.map(k=>accounts.get(k.toBase58())||null);}};
 async function account(name,size) {const data=Buffer.alloc(size);(await r.digest('account:'+name)).copy(data,0,0,8);return {owner:program,data};}
 const h=await account('WalletHead',80);wallet.toBuffer().copy(h.data,8);h.data.writeBigUInt64LE(23n,40);accounts.set(r.pda(program,'sent',wallet.toBytes()).toBase58(),h);
 let previous=PublicKey.default;
 for(let i=0;i<23;i++) {
  const nonce=Buffer.alloc(16);nonce.writeUInt32LE(i);
  const address=r.pda(program,'record',wallet.toBytes(),nonce);
  const a=await account('Record',726);a.data[8]=1;wallet.toBuffer().copy(a.data,9);wallet.toBuffer().copy(a.data,41);a.data.writeBigInt64LE(1700000000n,73);nonce.copy(a.data,82);previous.toBuffer().copy(a.data,98);
  const msg=Buffer.from(`记录 ${i} 💎`);a.data.writeUInt32LE(msg.length,162);msg.copy(a.data,166);accounts.set(address.toBase58(),a);
  const e=await account('WalletEntry',40);address.toBuffer().copy(e.data,8);accounts.set(r.pda(program,'sent-entry',wallet.toBytes(),r.u64(BigInt(i))).toBase58(),e);previous=address;
 }
 const code=r.recoveryCode(program,previous);
 calls=0;assert.equal((await r.readRecord(c,code,program)).message,'记录 22 💎');assert.equal(calls,1);
 calls=0;let page=await r.walletRecords(c,program,wallet,'sent');assert.equal(calls,3);assert.equal(page.records.length,10);assert.equal(page.nextCursor,'13');assert.equal(page.total,'23');
 assert.equal(page.records[0].previousSent,page.records[1].recoveryCode);
 page=await r.walletRecords(c,program,wallet,'sent',page.nextCursor);assert.equal(page.records.length,10);assert.equal(page.nextCursor,'3');
 page=await r.walletRecords(c,program,wallet,'sent',page.nextCursor);assert.equal(page.records.length,3);assert.equal(page.nextCursor,undefined);
 await assert.rejects(r.walletRecords(c,program,wallet,'sent','24'));
 await assert.rejects(r.walletRecords(c,program,wallet,'sent','-1'));
 assert.equal((await r.walletRecords(c,program,Keypair.generate().publicKey,'inbox')).records.length,0);
 await assert.rejects(r.readRecord(c,code,Keypair.generate().publicKey));assert.throws(()=>r.parseRecoveryCode('bad'));
 const latest=accounts.get(previous.toBase58());latest.owner=wallet;await assert.rejects(r.readRecord(c,code,program));latest.owner=program;
 latest.data[8]=2;await assert.rejects(r.readRecord(c,code,program));latest.data[8]=1;
 latest.data.writeUInt32LE(561,162);await assert.rejects(r.readRecord(c,code,program));latest.data.writeUInt32LE(1,162);latest.data[166]=255;await assert.rejects(r.readRecord(c,code,program));
 console.log('PASS: direct lookup 1 RPC; 23 records paginated 10/10/3, 3 RPC/page; links; empty inbox; invalid cursor/code/program/owner/version/length/UTF-8 rejected; no historical RPC available');
})().catch(e=>{console.error(e);process.exitCode=1;});
