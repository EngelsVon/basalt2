#!/usr/bin/env node
/*
 Initialize on-chain Config PDA for basalt_inscription program.
 Reads env from server/.env:
 - PROGRAM_ID: program public key (required)
 - SERVICE_FEE_WALLET: pubkey for receiving service fee (required)
 - SERVICE_FEE_BPS: optional (u16 bps, e.g. 2000 for 20%); if absent, derived from SERVICE_FEE_RATE*100
 - MIN_CU_PRICE_MICROLAMPORTS: optional (u64, default 10000)
 - MIN_CU_LIMIT: optional (u32, default 100000)
 - SOLANA_RPC_URL: RPC endpoint
 - DEPLOYER_KEYPAIR: path to keypair json (defaults to ~/.config/solana/id.json)
*/
require('dotenv').config({ path: __dirname + '/../.env' });
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function loadKeypair(filePath) {
  const full = expandHome(filePath);
  const raw = fs.readFileSync(full, 'utf8');
  const arr = JSON.parse(raw);
  const secret = Uint8Array.from(arr);
  return Keypair.fromSecretKey(secret);
}

function u16LE(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64LE(n) {
  const b = Buffer.alloc(8);
  const bn = BigInt(n);
  b.writeBigUInt64LE(bn);
  return b;
}

function ixDiscriminator(name) {
  const h = crypto.createHash('sha256').update(`global:${name}`).digest();
  return h.subarray(0, 8);
}

(async () => {
  try {
    const PROGRAM_ID = process.env.PROGRAM_ID;
    if (!PROGRAM_ID) throw new Error('Missing PROGRAM_ID in server/.env');
    const programId = new PublicKey(PROGRAM_ID);

    const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    const keypairPath = process.env.DEPLOYER_KEYPAIR || '~/.config/solana/id.json';
    const payer = loadKeypair(keypairPath);

    const SERVICE_FEE_WALLET = process.env.SERVICE_FEE_WALLET;
    if (!SERVICE_FEE_WALLET) throw new Error('Missing SERVICE_FEE_WALLET in server/.env');
    const serviceFeeWallet = new PublicKey(SERVICE_FEE_WALLET);

    let serviceFeeBps = parseInt(process.env.SERVICE_FEE_BPS || '', 10);
    if (Number.isNaN(serviceFeeBps)) {
      const rate = parseFloat(process.env.SERVICE_FEE_RATE || '20');
      serviceFeeBps = Math.round((Number.isNaN(rate) ? 20 : rate) * 100);
    }

    const minCuPrice = parseInt(process.env.MIN_CU_PRICE_MICROLAMPORTS || '10000', 10);
    const minCuLimit = parseInt(process.env.MIN_CU_LIMIT || '100000', 10);

    const [configPda, bump] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);

    // Build initialize_config instruction
    const data = Buffer.concat([
      ixDiscriminator('initialize_config'),
      serviceFeeWallet.toBuffer(),
      u16LE(serviceFeeBps),
      u64LE(minCuPrice),
      u32LE(minCuLimit),
    ]);

    const keys = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({ programId, keys, data });
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey }).add(ix);

    console.log('Sending initialize_config...');
    const sig = await connection.sendTransaction(tx, [payer], { skipPreflight: false });
    console.log('Tx sent:', sig);

    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) {
      console.error('Transaction error:', conf.value.err);
      process.exit(1);
    }

    console.log('Config initialized at PDA:', configPda.toBase58());
    console.log('Parameters:', { serviceFeeBps, minCuPrice, minCuLimit, serviceFeeWallet: serviceFeeWallet.toBase58() });
  } catch (e) {
    console.error('init_config failed:', e);
    process.exit(1);
  }
})();