// Live Devnet test. Requires API server + initialized program. Spends test SOL only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Connection, Keypair, Transaction, TransactionInstruction, VersionedTransaction, ComputeBudgetProgram, PublicKey, SystemProgram } = require('@solana/web3.js');
const { createMemoInstruction } = require('@solana/spl-memo');
const crypto = require('node:crypto');
const out = path.resolve('review_artifacts/new-devnet');
fs.mkdirSync(out, { recursive: true });
require('esbuild').buildSync({ entryPoints: ['src/services/solanaService.ts'], outfile: path.join(out, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['@solana/web3.js'], define: { 'import.meta.env': '{}' } });
const { SolanaService, parseMemo } = require(path.join(out, 'service.cjs'));
const base = process.env.TEST_API_BASE || 'http://localhost:3001';
const connection = new Connection(base + '/api/rpc', 'confirmed');
const results = [];
function pass(name, detail) { results.push({ name, status: 'PASS', detail }); console.log('PASS', name, detail || ''); }
async function json(route, body) {
  const r = await fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, body: await r.json() };
}
(async () => {
  assert.equal(await connection.getGenesisHash(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  pass('Devnet genesis');
  const config = (await json('/api/config')).body.data;
  assert.equal(config.programMode, true);
  assert.equal(config.programId, 'GRJr1pdTLEqpWRiSvvWCLZViKqxD7tiMYpPUEjUUgZin');
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER_KEYPAIR || path.join(os.homedir(), '.config/solana/id.json')))));
  assert.equal(config.programConfig.authority, wallet.publicKey.toBase58());
  pass('New program and config authority', config.programId);
  for (const body of [{ message: '' }, { message: 123 }, { message: 'x'.repeat(281) }, { message: 'test', type: 'fake' }, { message: 'test', priority: 'fake' }]) {
    assert.equal((await json('/api/inscription/calculate-fee', body)).status, 400);
  }
  pass('API rejects five invalid input cases');
  assert.equal((await json('/api/rpc', { jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [] })).status, 400);
  pass('RPC relay rejects unlisted method');
  const denied = await fetch(base + '/health', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  pass('CORS excludes unknown origin');
  const service = new SolanaService(connection);
  const memo = 'first line\nFrom: forged\n中文 💎';
  assert.equal(parseMemo(JSON.stringify({ platform: 'Basalt', version: 2, message: memo, timestamp: Date.now() })).message, memo);
  pass('Multiline memo metadata isolation');
  let prompts = 0;
  await assert.rejects(service.inscribeMessage('', wallet.publicKey, async () => { prompts++; }));
  await assert.rejects(service.inscribeMessage('x', wallet.publicKey, async () => { prompts++; }, 'invalid-address'));
  assert.equal(prompts, 0);
  pass('Local validation before wallet prompt');
  const cases = [['general','low'], ['love','medium'], ['agreement','high']];
  for (const [type, priority] of cases) {
    const message = `Basalt full test ${type}/${priority} ${new Date().toISOString()}\n第二行 💎`;
    const fee = await service.calculateInscriptionFee(message, type, priority, wallet.publicKey.toBase58(), wallet.publicKey.toBase58());
    const receipt = await service.inscribeMessage(message, wallet.publicKey, async () => { throw new Error('Unexpected fallback'); }, wallet.publicKey.toBase58(), async tx => { tx.partialSign(wallet); return tx; }, type, priority);
    assert.equal(receipt.status, 'confirmed');
    let tx, read;
    for (let n = 0; n < 10; n++) {
      tx = await connection.getParsedTransaction(receipt.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      read = await service.getInscriptionBySignature(receipt.signature);
      if (tx && read) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    assert.equal(tx.meta.err, null);
    assert.equal(read.message, message); assert.equal(read.type, type);
    assert.equal(read.sender, wallet.publicKey.toBase58()); assert.equal(read.recipient, wallet.publicKey.toBase58());
    const payerIndex = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.equals(wallet.publicKey));
    const feeIndex = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.toBase58() === config.programConfig.serviceFeeWallet);
    const charged = tx.meta.preBalances[payerIndex] - tx.meta.postBalances[payerIndex];
    assert.equal(charged, fee.totalFee);
    assert.equal(tx.meta.fee, fee.networkFee);
    assert.equal(tx.meta.postBalances[feeIndex] - tx.meta.preBalances[feeIndex], fee.serviceFee);
    const bySig = await service.searchInscriptions(receipt.signature);
    assert.equal(bySig[0].signature, receipt.signature);
    pass(`Send, confirm, read, signature search and exact fees ${type}/${priority}`, { signature: receipt.signature, charged, fee: fee.serviceFee });
  }
  const history = await service.getInscriptionsByAddress(config.programId, 10);
  assert(history.length >= 3);
  pass('New program address history', history.length);
  // Reject wallet cancellation without sending another transaction.
  let fallback = 0;
  await assert.rejects(service.inscribeMessage('cancel test', wallet.publicKey, async () => { fallback++; }, undefined, async () => { throw new Error('User rejected'); }));
  assert.equal(fallback, 0); pass('Wallet rejection has no send fallback');
  // Simulate corrupted hash: must reject before memo completion and transfer rollback.
  const programId = new PublicKey(config.programId);
  const latest = await connection.getLatestBlockhash();
  const data = Buffer.alloc(52);
  crypto.createHash('sha256').update('global:inscribe').digest().copy(data, 0, 0, 8);
  data.writeUInt32LE(200000, 40); data.writeBigUInt64LE(50000n, 44);
  const instruction = new TransactionInstruction({ programId, data, keys: [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: new PublicKey(config.programConfig.pda), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(config.programConfig.serviceFeeWallet), isSigner: false, isWritable: true },
    { pubkey: new PublicKey('Sysvar1nstructions1111111111111111111111111'), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ] });
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: latest.blockhash }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }), instruction, createMemoInstruction('hash mismatch test'));
  const simulation = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false });
  assert(simulation.value.err);
  assert(simulation.value.logs.some(log => log.includes('InvalidMemo')));
  pass('Contract rejects corrupted memo hash (simulation only)');
  // update_config: None(wallet), Some(bps > 10000), None(price), None(limit)
  const badConfig = Buffer.concat([crypto.createHash('sha256').update('global:update_config').digest().subarray(0, 8), Buffer.from([0, 1, 0x11, 0x27, 0, 0])]);
  const update = new TransactionInstruction({ programId, data: badConfig, keys: [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    { pubkey: new PublicKey(config.programConfig.pda), isSigner: false, isWritable: true },
  ] });
  const invalidTx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash }).add(update);
  const bad = await connection.simulateTransaction(new VersionedTransaction(invalidTx.compileMessage()), { sigVerify: false });
  assert(bad.value.err); assert(bad.value.logs.some(line => line.includes('InvalidConfig')));
  pass('Contract rejects invalid service fee config (simulation only)');
  update.keys[0].pubkey = new PublicKey(config.programConfig.serviceFeeWallet);
  const unauthorizedTx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash }).add(update);
  const unauthorized = await connection.simulateTransaction(new VersionedTransaction(unauthorizedTx.compileMessage()), { sigVerify: false });
  assert(unauthorized.value.err); assert(unauthorized.value.logs.some(line => line.includes('Unauthorized')));
  pass('Contract rejects unauthorized config update (simulation only)');

  fs.writeFileSync(path.join(out, 'e2e-result.json'), JSON.stringify({ status: 'PASS', programId: config.programId, tests: results }, null, 2));
  console.log(`ALL ${results.length} CHECKS PASSED`);
})().catch(e => { fs.writeFileSync(path.join(out, 'e2e-result.json'), JSON.stringify({ status: 'FAIL', tests: results, error: String(e) }, null, 2)); console.error(e); process.exitCode = 1; });
