const assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const {Connection,Keypair,PublicKey,VersionedTransaction}=require('@solana/web3.js');
const out=path.resolve('review_artifacts/recovery');
require('esbuild').buildSync({entryPoints:['src/services/solanaService.ts'],outfile:path.join(out,'service.cjs'),bundle:true,platform:'node',format:'cjs',external:['@solana/web3.js'],define:{'import.meta.env':'{}'}});
require('esbuild').buildSync({entryPoints:['src/services/recordService.ts'],outfile:path.join(out,'record.cjs'),bundle:true,platform:'node',format:'cjs',external:['@solana/web3.js']});
const {SolanaService}=require(path.join(out,'service.cjs')),r=require(path.join(out,'record.cjs'));
(async()=>{
 const c=new Connection('http://localhost:3001/api/rpc','confirmed');
 assert.equal(await c.getGenesisHash(),'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
 const cfg=(await (await fetch('http://localhost:3001/api/config')).json()).data;assert(cfg.persistentRecords);
 const program=new PublicKey(cfg.programId),feeWallet=new PublicKey(cfg.programConfig.serviceFeeWallet);
 const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(),'.config/solana/id.json')))));
 const recipient=Keypair.generate().publicKey,s=new SolanaService(c),receipts=[];
 for(let i=0;i<2;i++) {
  const msg=`Recovery linked test ${i} ${new Date().toISOString()} 中文💎`;
  const receipt=await s.inscribeMessage(msg,payer.publicKey,async()=>{throw Error('fallback');},recipient.toBase58(),async tx=>{tx.partialSign(payer);return tx;},'general','low');assert.equal(receipt.status,'confirmed');receipts.push(receipt);
  const read=await s.recover(receipt.recoveryCode);assert.equal(read.message,msg);assert.equal(read.recipient,recipient.toBase58());
 }
 const inbox=await s.getWalletRecords(recipient.toBase58(),'inbox');assert.equal(inbox.total,'2');assert.equal(inbox.records[0].previousReceived,receipts[0].recoveryCode);assert.equal(inbox.records[0].previousSent,receipts[0].recoveryCode);
 const sent=await s.getWalletRecords(payer.publicKey.toBase58(),'sent');assert.equal(sent.records[0].recoveryCode,receipts[1].recoveryCode);
 // Disable every history method and prove account-only recovery still works.
 c.getParsedTransaction=c.getTransaction=c.getSignaturesForAddress=async()=>{throw Error('History deliberately unavailable');};
 assert.equal((await s.recover(receipts[0].recoveryCode)).message,receipts[0].message);assert.equal((await s.getWalletRecords(recipient.toBase58(),'inbox')).records.length,2);
 const built=await r.buildRecord(c,program,payer.publicKey,recipient,feeWallet,'negative',0,600000,20000);
 const ix=built.tx.instructions[2];ix.data[56]=9;
 const bad=await c.simulateTransaction(new VersionedTransaction(built.tx.compileMessage()),{sigVerify:false});assert(bad.value.err);assert(bad.value.logs.some(l=>l.includes('InvalidRecord')));assert.equal(await c.getAccountInfo(new PublicKey(built.address)),null);
 ix.data[56]=0;
 const seqOffset=61+Buffer.byteLength('negative');const oldSeq=ix.data.readBigUInt64LE(seqOffset);
 ix.data.writeBigUInt64LE(oldSeq+1n,seqOffset);ix.keys[6].pubkey=r.pda(program,'sent-entry',payer.publicKey.toBytes(),r.u64(oldSeq+1n));
 const stale=await c.simulateTransaction(new VersionedTransaction(built.tx.compileMessage()),{sigVerify:false});assert(stale.value.err);assert(stale.value.logs.some(l=>l.includes('StaleIndex')));
 ix.data.writeBigUInt64LE(oldSeq,seqOffset);ix.keys[6].pubkey=r.pda(program,'sent-entry',payer.publicKey.toBytes(),r.u64(oldSeq));
 // Fee payer is inherently a signer, so use a distinct nonsigning payer account.
 ix.keys[0].isSigner=false;ix.keys[0].pubkey=recipient;
 const badSigner=await c.simulateTransaction(new VersionedTransaction(built.tx.compileMessage()),{sigVerify:false});assert(badSigner.value.err);
 await assert.rejects(r.buildRecord(c,program,payer.publicKey,recipient,feeWallet,'中'.repeat(187),0,600000,20000));
 fs.writeFileSync(path.join(out,'receipts.json'),JSON.stringify(receipts,null,2));
 console.log('PASS: two live writes; separate recipient inbox; previous sent/received links; wallet lookup; recovery without transaction history; invalid kind/unsigned payer/oversize rejected; failed simulation creates no record');
 console.log('RECOVERY_CODE='+receipts[1].recoveryCode);
})().catch(e=>{console.error(e);process.exitCode=1;});
