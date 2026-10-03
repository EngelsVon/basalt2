import { Connection, PublicKey, TransactionInstruction, SystemProgram, ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';
import { Buffer } from 'buffer';
import type { InscriptionData } from './solanaService';

export const RECORD_BYTES = 726;
export const HEAD_BYTES = 80;
export const ENTRY_BYTES = 40;
export const MAX_MESSAGE_BYTES = 560;
export type Direction = 'sent' | 'inbox';
export interface RecordPage { records: InscriptionData[]; nextCursor?: string; total: string }
export async function digest(value: string) { return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
export function u64(n: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; }
export function pda(program: PublicKey, prefix: string, ...seeds: Uint8Array[]) { return PublicKey.findProgramAddressSync([Buffer.from(prefix), ...seeds], program)[0]; }
export function recoveryCode(program: PublicKey, record: PublicKey) { return `BS1:${program.toBase58()}:${record.toBase58()}`; }
export function parseRecoveryCode(code: string) {
  const parts = code.trim().split(':');
  if (parts.length !== 3 || parts[0] !== 'BS1') throw new Error('寻回号格式应为 BS1:程序地址:记录地址');
  return { program: new PublicKey(parts[1]), record: new PublicKey(parts[2]) };
}
async function checked(info: AccountInfo<Buffer> | null, program: PublicKey, name: string, size: number): Promise<Buffer> {
  if (!info || !info.owner.equals(program) || info.data.length < size || !info.data.subarray(0, 8).equals((await digest(`account:${name}`)).subarray(0, 8))) throw new Error(`链上 ${name} 账户校验失败`);
  return info.data;
}
async function head(info: AccountInfo<Buffer> | null, program: PublicKey, wallet: PublicKey) {
  if (!info) return 0n;
  const data = await checked(info, program, 'WalletHead', HEAD_BYTES);
  if (!new PublicKey(data.subarray(8, 40)).equals(wallet)) throw new Error('钱包目录不匹配');
  return data.readBigUInt64LE(40);
}
async function decode(info: AccountInfo<Buffer> | null, program: PublicKey, address: PublicKey): Promise<InscriptionData> {
  const data = await checked(info, program, 'Record', RECORD_BYTES);
  if (data[8] !== 1 || data[81] > 2) throw new Error('不支持的记录版本');
  const sender = new PublicKey(data.subarray(9,41));
  const recipient = new PublicKey(data.subarray(41,73));
  if (!pda(program, 'record', sender.toBytes(), data.subarray(82,98)).equals(address)) throw new Error('记录地址校验失败');
  const length = data.readUInt32LE(162);
  if (length > MAX_MESSAGE_BYTES) throw new Error('记录长度异常');
  const previous = (offset: number) => { const key = new PublicKey(data.subarray(offset,offset+32)); return key.equals(PublicKey.default) ? undefined : recoveryCode(program,key); };
  return { message: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(166,166+length)), sender: sender.toBase58(), recipient: recipient.toBase58(), timestamp: Number(data.readBigInt64LE(73))*1000,
    type: (['general','love','agreement'] as const)[data[81]], signature: '', status: 'confirmed', recoveryCode: recoveryCode(program,address), recordAddress: address.toBase58(), previousSent: previous(98), previousReceived: previous(130) };
}
export async function readRecord(connection: Connection, code: string, expectedProgram: PublicKey) {
  const {program,record} = parseRecoveryCode(code);
  if (!program.equals(expectedProgram)) throw new Error('寻回号属于其他程序，请使用对应部署的应用');
  return decode(await connection.getAccountInfo(record, 'confirmed'),program,record);
}
export async function walletRecords(connection: Connection, program: PublicKey, wallet: PublicKey, direction: Direction, before?: string): Promise<RecordPage> {
  const count = await head(await connection.getAccountInfo(pda(program,direction,wallet.toBytes())), program, wallet);
  const end = before === undefined ? count : BigInt(before);
  if (end < 0n || end > count) throw new Error('无效分页游标');
  const start = end > 10n ? end - 10n : 0n;
  const keys: PublicKey[] = [];
  for (let i=end; i>start; i--) keys.push(pda(program,`${direction}-entry`,wallet.toBytes(),u64(i-1n)));
  if (!keys.length) return { records: [], total: count.toString() };
  const entries = await connection.getMultipleAccountsInfo(keys);
  const addresses = await Promise.all(entries.map(async info => new PublicKey((await checked(info,program,'WalletEntry',ENTRY_BYTES)).subarray(8,40))));
  const accounts = await connection.getMultipleAccountsInfo(addresses);
  const records = await Promise.all(accounts.map((info,i)=>decode(info,program,addresses[i])));
  if (records.some(r => (direction === 'sent' ? r.sender : r.recipient) !== wallet.toBase58())) throw new Error('目录记录与钱包不匹配');
  return { records, nextCursor: start > 0n ? start.toString() : undefined, total: count.toString() };
}
export async function recordRent(connection: Connection, program: PublicKey, sender: PublicKey, recipient: PublicKey) {
  const heads = await connection.getMultipleAccountsInfo([pda(program,'sent',sender.toBytes()),pda(program,'inbox',recipient.toBytes())]);
  const [record,entry,h] = await Promise.all([connection.getMinimumBalanceForRentExemption(RECORD_BYTES),connection.getMinimumBalanceForRentExemption(ENTRY_BYTES),connection.getMinimumBalanceForRentExemption(HEAD_BYTES)]);
  return { lamports: record + 2*entry + heads.filter(a=>!a).length*h, sent: await head(heads[0],program,sender), inbox: await head(heads[1],program,recipient) };
}
export async function buildRecord(connection: Connection, program: PublicKey, sender: PublicKey, recipient: PublicKey, feeWallet: PublicKey, message: string, kind: number, cuLimit: number, cuPrice: number) {
  const bytes = Buffer.from(message, 'utf8');
  if (!Number.isInteger(kind) || kind < 0 || kind > 2 || recipient.equals(PublicKey.default)) throw new Error('无效的记录类型或接收钱包');
  if (!message.trim() || bytes.length > MAX_MESSAGE_BYTES) throw new Error(`链上存储上限 ${MAX_MESSAGE_BYTES} UTF-8 字节（中文、表情占多个字节）`);
  const rent = await recordRent(connection,program,sender,recipient);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const address = pda(program,'record',sender.toBytes(),nonce);
  const length = Buffer.alloc(4);length.writeUInt32LE(bytes.length);
  const limit=Buffer.alloc(4);limit.writeUInt32LE(cuLimit);
  const ix = new TransactionInstruction({ programId:program, keys:[
    {pubkey:sender,isSigner:true,isWritable:true}, {pubkey:pda(program,'config'),isSigner:false,isWritable:false},
    {pubkey:feeWallet,isSigner:false,isWritable:true}, {pubkey:address,isSigner:false,isWritable:true},
    {pubkey:pda(program,'sent',sender.toBytes()),isSigner:false,isWritable:true}, {pubkey:pda(program,'inbox',recipient.toBytes()),isSigner:false,isWritable:true},
    {pubkey:pda(program,'sent-entry',sender.toBytes(),u64(rent.sent)),isSigner:false,isWritable:true}, {pubkey:pda(program,'inbox-entry',recipient.toBytes(),u64(rent.inbox)),isSigner:false,isWritable:true},
    {pubkey:new PublicKey('Sysvar1nstructions1111111111111111111111111'),isSigner:false,isWritable:false}, {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
  ], data:Buffer.concat([(await digest('global:inscribe_record')).subarray(0,8),Buffer.from(nonce),recipient.toBuffer(),Buffer.from([kind]),length,bytes,u64(rent.sent),u64(rent.inbox),limit,u64(BigInt(cuPrice))]) });
  const latest=await connection.getLatestBlockhash();
  const tx=new Transaction({feePayer:sender,recentBlockhash:latest.blockhash}).add(ComputeBudgetProgram.setComputeUnitLimit({units:cuLimit}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:cuPrice}),ix);
  tx.serialize({requireAllSignatures:false,verifySignatures:false});
  return {tx,latest,rent:rent.lamports,code:recoveryCode(program,address),address:address.toBase58()};
}
