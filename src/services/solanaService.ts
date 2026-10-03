import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { createMemoInstruction } from '@solana/spl-memo';
import bs58 from 'bs58';
import { Buffer } from 'buffer';

// 导出接口定义
export interface InscriptionData {
  message: string;
  sender: string;
  recipient?: string;
  timestamp: number;
  signature: string;
  blockTime?: number;
  status?: string; // 交易状态：'confirmed', 'pending', 'failed'
  type?: 'love' | 'general' | 'agreement';
}

// 后端费用响应类型
export interface FeeResponseData {
  networkFee: number; // lamports
  serviceFee: number; // lamports
  totalFee: number; // lamports
  totalFeeSOL: number; // sol
  serviceFeeSOL: number; // sol
  serviceFeeWallet: string;
  type: 'love' | 'general' | 'agreement';
}

// 后端配置类型
interface ApiConfig {
  network: string;
  serviceFeeWallet: string;
  serviceFeeRate: number; // percent
  priorityPresets: Record<string, { cuLimit: number; cuPriceMicroLamports: number }>;
  defaultPriority: 'low' | 'medium' | 'high';
  programMode: boolean;
  programId?: string | null;
  programConfig?: {
    pda: string;
    authority: string;
    serviceFeeWallet: string;
    serviceFeeBps: number;
    minCuPrice: number;
    minCuLimit: number;
  } | null;
}


export class SolanaService {
  private connection: Connection;
  constructor(connection: Connection) { this.connection = connection; }

  private async getApiConfig(): Promise<ApiConfig> {
    return api<ApiConfig>('/api/config');
  }

  async calculateInscriptionFee(message: string, type: InscriptionType = 'general', priority: Priority = 'medium'): Promise<FeeResponseData> {
    return api<FeeResponseData>('/api/inscription/calculate-fee', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, type, priority }),
    });
  }

  async inscribeMessage(message: string, senderPublicKey: PublicKey,
    sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>,
    recipient?: string, signTransaction?: (tx: Transaction) => Promise<Transaction>,
    type: InscriptionType = 'general', priority: Priority = 'medium'): Promise<InscriptionData> {
    if (!message.trim() || message.length > 280) throw new Error('请输入 1–280 字符的消息');
    if (recipient) recipient = new PublicKey(recipient).toBase58();
    const config = await this.getApiConfig();
    if (config.network !== 'devnet') throw new Error('当前应用仅连接 Devnet，请检查后端网络');
    if (config.programMode && (!config.programId || !config.programConfig)) throw new Error('链上配置未就绪');
    const fee = await this.calculateInscriptionFee(message, type, priority);
    const preset = config.priorityPresets[priority];
    if (!preset) throw new Error('无效优先费档位');
    const cuLimit = Math.max(preset.cuLimit, config.programConfig?.minCuLimit ?? 0);
    const cuPrice = Math.max(preset.cuPriceMicroLamports, config.programConfig?.minCuPrice ?? 0);
    const timestamp = Date.now();
    // JSON prevents multiline messages from injecting metadata fields.
    const memo = JSON.stringify({ platform: 'Basalt', version: 2, message, type, recipient, timestamp });
    const latest = await this.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: senderPublicKey, recentBlockhash: latest.blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }));
    if (config.programMode) {
      const programId = new PublicKey(config.programId!);
      const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
      const numbers = Buffer.alloc(12);
      numbers.writeUInt32LE(cuLimit); numbers.writeBigUInt64LE(BigInt(cuPrice), 4);
      tx.add(new TransactionInstruction({ programId, keys: [
        { pubkey: senderPublicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(config.programConfig!.serviceFeeWallet), isSigner: false, isWritable: true },
        { pubkey: new PublicKey('Sysvar1nstructions1111111111111111111111111'), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.concat([(await hash('global:inscribe')).subarray(0, 8), await hash(memo), numbers]) }));
    } else if (fee.serviceFee > 0) {
      tx.add(SystemProgram.transfer({ fromPubkey: senderPublicKey, toPubkey: new PublicKey(fee.serviceFeeWallet), lamports: fee.serviceFee }));
    }
    tx.add(createMemoInstruction(memo));
    // Check the actual wire size before opening a wallet prompt (UTF-8 != character count).
    tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const networkFee = (await this.connection.getFeeForMessage(tx.compileMessage(), 'confirmed')).value;
    if (networkFee === null) throw new Error('区块哈希已过期，请重试');
    const serviceFee = config.programMode
      ? Math.ceil(Math.ceil(cuLimit * cuPrice / 1_000_000) * config.programConfig!.serviceFeeBps / 10_000)
      : fee.serviceFee;
    if (await this.connection.getBalance(senderPublicKey) < networkFee + serviceFee) throw new Error('余额不足（包含网络费和服务费）');
    let signature: string;
    if (signTransaction) {
      const signed = await signTransaction(tx);
      // A send error must never trigger a differently signed replacement transaction.
      signature = bs58.encode(signed.signature!);
      try {
        await this.connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
      } catch (error) {
        throw new Error(`广播结果待核实，请先查询签名 ${signature}，不要重复提交：${String(error)}`);
      }
    } else {
      signature = await sendTransaction(tx, this.connection);
    }
    const result: InscriptionData = { message, sender: senderPublicKey.toBase58(), recipient, timestamp, signature, type, status: 'pending' };
    let confirmation;
    try {
      confirmation = await this.connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    } catch {
      const status = await this.connection.getSignatureStatus(signature, { searchTransactionHistory: true }).catch(() => null);
      if (status?.value?.err) throw new Error(`交易失败 ${signature}: ${JSON.stringify(status.value.err)}`);
      if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') result.status = 'confirmed';
      return result;
    }
    if (confirmation.value.err) throw new Error(`交易失败 ${signature}: ${JSON.stringify(confirmation.value.err)}`);
    return { ...result, status: 'confirmed' };
  }

  async getInscriptionBySignature(signature: string): Promise<InscriptionData | null> {
    const tx = await this.connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.meta || tx.meta.err) return null;
    const sender = tx.transaction.message.accountKeys.find(key => key.signer)?.pubkey.toBase58();
    if (!sender) return null;
    for (const ix of tx.transaction.message.instructions) {
      if (ix.programId.toBase58() !== 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr') continue;
      const memo = 'parsed' in ix && typeof ix.parsed === 'string' ? ix.parsed
        : 'data' in ix ? Buffer.from(bs58.decode(ix.data)).toString('utf8') : '';
      const data = parseMemo(memo);
      if (data) return { ...data, sender, signature, blockTime: tx.blockTime ?? undefined,
        timestamp: tx.blockTime ? tx.blockTime * 1000 : data.timestamp, status: 'confirmed' };
    }
    return null;
  }

  async getInscriptionsByAddress(address: string, limit = 100): Promise<InscriptionData[]> {
    const signatures = await this.connection.getSignaturesForAddress(new PublicKey(address), { limit: Math.min(1000, Math.max(1, limit)) });
    const results: InscriptionData[] = [];
    // Small batches avoid both serial N+1 latency and unbounded RPC concurrency.
    for (let i = 0; i < signatures.length; i += 4) {
      const batch = await Promise.all(signatures.slice(i, i + 4).filter(s => !s.err).map(s => this.getInscriptionBySignature(s.signature)));
      for (const item of batch) if (item) results.push(item);
    }
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  async searchInscriptions(query: string, addresses: string[] = [], limit = 100): Promise<InscriptionData[]> {
    if (/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(query)) {
      const hit = await this.getInscriptionBySignature(query);
      if (hit) return [hit];
    }
    const config = await this.getApiConfig();
    const targets = new Set([...addresses, config.programId, config.serviceFeeWallet].filter((s): s is string => Boolean(s)));
    const records = new Map<string, InscriptionData>();
    for (const address of targets) for (const item of await this.getInscriptionsByAddress(address, limit)) records.set(item.signature, item);
    return [...records.values()].filter(item => item.message.toLowerCase().includes(query.toLowerCase()) || item.sender === query || item.recipient === query)
      .sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
  async getBalance(publicKey: PublicKey): Promise<number> { return await this.connection.getBalance(publicKey) / LAMPORTS_PER_SOL; }
  async checkConnection(): Promise<boolean> { try { await this.connection.getLatestBlockhash(); return true; } catch { return false; } }
}

type InscriptionType = 'love' | 'general' | 'agreement';
type Priority = 'low' | 'medium' | 'high';
function validType(value: unknown): InscriptionType { return value === 'love' || value === 'agreement' ? value : 'general'; }
export function parseMemo(memo: string): Pick<InscriptionData, 'message' | 'recipient' | 'timestamp' | 'type'> | null {
  try {
    const value = JSON.parse(memo);
    if (value.platform === 'Basalt' && value.version === 2 && typeof value.message === 'string' && Number.isFinite(value.timestamp)) {
      return { message: value.message, recipient: typeof value.recipient === 'string' ? value.recipient : undefined, timestamp: value.timestamp, type: validType(value.type) };
    }
  } catch { /* Legacy text format follows. */ }
  if (!memo.startsWith('💎 Basalt Inscription v1') && !memo.includes('Basalt Love Inscription')) return null;
  const message = memo.match(/Message: ([\s\S]*?)\n(?:From:|To:|Timestamp:)/)?.[1];
  const timestamp = Number(memo.match(/Timestamp: (\d+)/)?.[1]);
  if (!message || !Number.isFinite(timestamp)) return null;
  return { message, timestamp, recipient: memo.match(/\nTo: ([^\n]+)/)?.[1], type: validType(memo.match(/\nType: ([^\n]+)/)?.[1]) };
}
async function hash(text: string): Promise<Buffer> { return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const base = import.meta.env?.VITE_API_BASE || 'http://localhost:3001';
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
  const json = await response.json();
  if (!response.ok || !json.success) throw new Error(json.error || `HTTP ${response.status}`);
  return json.data as T;
}
export default SolanaService;
