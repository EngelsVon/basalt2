const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createMemoInstruction } = require('@solana/spl-memo');

const app = express();
const PORT = process.env.PORT || 3001;

// 可配置服务费参数
const SERVICE_FEE_WALLET = process.env.SERVICE_FEE_WALLET || '6TnyoYQzXqZV4Awu8kiUYX343MTAa7dTx7tLiBzcoT4Z';
const SERVICE_FEE_RATE = process.env.SERVICE_FEE_BPS !== undefined ? Number(process.env.SERVICE_FEE_BPS) / 100 : Number(process.env.SERVICE_FEE_RATE || '20');
if (!Number.isFinite(SERVICE_FEE_RATE) || SERVICE_FEE_RATE < 0 || SERVICE_FEE_RATE > 100) throw new Error('Invalid service fee rate'); // 百分比
// 取消下限：按用户要求无下限
const MIN_SERVICE_FEE_LAMPORTS = 0;

// Program 模式相关环境变量
const PROGRAM_ID = process.env.PROGRAM_ID || null;

// Solana连接配置 - 使用更稳定的RPC端点
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const { createConnection, rpcFetch } = require('./rpc');
const connection = createConnection();

// 动态识别网络名称，便于前端诊断
const NETWORK_NAME = /testnet/i.test(SOLANA_RPC_URL)
  ? 'testnet'
  : /devnet/i.test(SOLANA_RPC_URL)
    ? 'devnet'
    : /mainnet|mainnet-beta/i.test(SOLANA_RPC_URL)
      ? 'mainnet-beta'
      : 'unknown';

// 优先费档位与 CU 限额（与前端统一）
function getPriorityPreset(preset = 'medium') {
  switch (preset) {
    case 'low':
      return { cuLimit: 120_000, cuPriceMicroLamports: 20_000 };
    case 'high':
      return { cuLimit: 300_000, cuPriceMicroLamports: 100_000 };
    case 'medium':
    default:
      return { cuLimit: 200_000, cuPriceMicroLamports: 50_000 };
  }
}

// 计算 Anchor 账户鉴别符（前8字节）
function anchorAccountDiscriminator(name) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(`account:${name}`).digest();
  return hash.subarray(0, 8);
}

// 解析链上 Config 账户
async function fetchOnchainConfig() {
  if (!PROGRAM_ID) return null;
  try {
    const programKey = new PublicKey(PROGRAM_ID);
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programKey);
    const info = await connection.getAccountInfo(configPda, 'confirmed');
    if (!info || !info.data) return null;

    // Anchor 账户布局: 8字节鉴别符 + fields
    const disc = anchorAccountDiscriminator('Config');
    if (info.data.length < 8 + 32 + 32 + 2 + 8 + 4) return null;
    const data = Buffer.from(info.data);
    // 可选鉴别符校验（不强制）
    if (!info.owner.equals(programKey) || !data.subarray(0, 8).equals(disc)) throw new Error('Invalid config account');

    let offset = 8; // 跳过鉴别符
    const authority = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    const serviceFeeWallet = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    const serviceFeeBps = data.readUInt16LE(offset); // u16
    offset += 2;
    const minCuPrice = Number(BigInt.asUintN(64, data.readBigUInt64LE(offset))); // u64
    offset += 8;
    const minCuLimit = data.readUInt32LE(offset); // u32

    return {
      pda: configPda.toBase58(),
      authority: authority.toBase58(),
      serviceFeeWallet: serviceFeeWallet.toBase58(),
      serviceFeeBps,
      minCuPrice,
      minCuLimit,
    };
  } catch (e) {
    console.warn('读取链上 Config 失败:', e?.message || e);
    throw e;
  }
}

// 中间件配置
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').includes(origin)), // 放宽CORS以便本地开发(5173/5174/5175等端口)
  credentials: true
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: true }));

// 速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 100, // 限制每个IP 15分钟内最多100个请求
  message: {
    error: '请求过于频繁，请稍后再试'
  }
});
app.use('/api/', limiter);

// Fixed-upstream RPC relay: browsers use the same Devnet connection as the API.
const rpcMethods = new Set(['getAccountInfo', 'getBalance', 'getLatestBlockhash', 'getBlockHeight', 'getFeeForMessage', 'getSignatureStatuses', 'getTransaction', 'getSignaturesForAddress', 'sendTransaction', 'simulateTransaction', 'getGenesisHash', 'getVersion']);
app.post('/api/rpc', async (req, res) => {
  if (!req.body || req.body.jsonrpc !== '2.0' || !rpcMethods.has(req.body.method)) return res.status(400).json({ error: 'Unsupported RPC method' });
  try {
    const response = await rpcFetch(SOLANA_RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
    res.status(response.status).json(await response.json());
  } catch (error) { res.status(502).json({ error: 'RPC upstream unavailable' }); }
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    network: NETWORK_NAME,
  });
});

// 新增：配置查询端点，供前端展示/对齐
app.get('/api/config', async (req, res) => {
  const presets = {
    low: getPriorityPreset('low'),
    medium: getPriorityPreset('medium'),
    high: getPriorityPreset('high'),
  };
  try {
    const onchain = await fetchOnchainConfig();
    if (PROGRAM_ID && !onchain) return res.status(503).json({ success: false, error: 'Program config unavailable' });
    const programMode = Boolean(PROGRAM_ID);

    res.json({
      success: true,
      data: {
        network: NETWORK_NAME,
        serviceFeeWallet: onchain?.serviceFeeWallet || SERVICE_FEE_WALLET,
        serviceFeeRate: onchain ? (onchain.serviceFeeBps / 100) : SERVICE_FEE_RATE,
        priorityPresets: presets,
        defaultPriority: 'medium',
        programMode,
        programId: PROGRAM_ID,
        programConfig: onchain, // 便于前端取用 serviceFeeWallet/bps 等
      }
    });
  } catch (e) {
    res.status(503).json({ success: false, error: 'Program configuration unavailable' });
  }
});

// 网络状态端点，便于前端展示当前网络
app.get('/api/network/status', async (req, res) => {
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    res.json({ success: true, network: NETWORK_NAME, blockhash });
  } catch (error) {
    res.status(500).json({ success: false, error: '无法获取网络状态', details: error.message });
  }
});

// 计算铭刻费用（包含服务费）
app.post('/api/inscription/calculate-fee', async (req, res) => {
  try {
    const { message = '', type = 'general', priority = 'medium' } = req.body || {};
    if (typeof message !== 'string' || !message.trim() || message.length > 280 || !['general','love','agreement'].includes(type) || !['low','medium','high'].includes(priority)) return res.status(400).json({ success: false, error: 'Invalid inscription input' });
    const onchain = await fetchOnchainConfig();
    if (PROGRAM_ID && !onchain) return res.status(503).json({ success: false, error: 'Program config unavailable' });

    // 构建模拟交易以估算基础网络费（不含优先费）
    const dummyPayer = new PublicKey('11111111111111111111111111111111');
    const { blockhash } = await connection.getLatestBlockhash();
    const mockTransaction = new Transaction({
      recentBlockhash: blockhash,
      feePayer: dummyPayer,
    });

    // 统一 v1 文本格式，便于与前端保持一致
    let inscriptionContent = `💎 Basalt Inscription v1 💎\n`;
    inscriptionContent += `Type: ${type}\n`;
    inscriptionContent += `Message: ${message}\n`;
    inscriptionContent += `Timestamp: ${Date.now()}\n`;
    inscriptionContent += `Platform: Basalt (玄武岩)`;

    // 添加memo指令（仅用于估算基础费）
    const memoInstruction = createMemoInstruction(inscriptionContent);
    mockTransaction.add(memoInstruction);

    // 获取基础费用（可能不含优先费）
    const fee = await connection.getFeeForMessage(
      mockTransaction.compileMessage(),
      'confirmed'
    );

    if (fee.value === null) {
      throw new Error('无法计算交易费用');
    }

    // 基础网络费用（lamports）
    const baseNetworkFee = fee.value;

    // 计算优先费（按固定档位，确保 Devnet 也为非 0）
    const preset = getPriorityPreset(priority);
    const cuLimit = Math.max(preset.cuLimit, onchain?.minCuLimit || 0);
    const cuPriceMicroLamports = Math.max(preset.cuPriceMicroLamports, onchain?.minCuPrice || 0);
    const priorityFeeLamports = Math.ceil((cuLimit * cuPriceMicroLamports) / 1_000_000);

    // 合计“网络费” = 基础费 + 优先费（不含服务费）
    const networkFee = baseNetworkFee + priorityFeeLamports;

    // 如果有链上配置，使用链上 service_fee_bps，否则使用本地 SERVICE_FEE_RATE
    const bps = onchain ? onchain.serviceFeeBps : Math.round((isNaN(SERVICE_FEE_RATE) ? 0 : SERVICE_FEE_RATE) * 100);

    // 服务费 = 优先费的 bps/10000（向下取整以避免前端高估；合约内部使用向上取整，前端仅做展示与预估）
    const rawServiceFee = Math.ceil(priorityFeeLamports * (bps / 10000));
    const serviceFee = Math.max(rawServiceFee, MIN_SERVICE_FEE_LAMPORTS);

    const totalFee = networkFee + serviceFee;
    const totalFeeSOL = totalFee / LAMPORTS_PER_SOL;

    res.json({
      success: true,
      data: {
        networkFee,
        serviceFee,
        totalFee,
        totalFeeSOL,
        serviceFeeSOL: serviceFee / LAMPORTS_PER_SOL,
        serviceFeeWallet: onchain?.serviceFeeWallet || SERVICE_FEE_WALLET,
        type,
        // 诊断信息
        debug: {
          baseNetworkFee,
          priorityFeeLamports,
          cuLimit,
          cuPriceMicroLamports,
          priorityPreset: priority,
          network: NETWORK_NAME,
          programMode: Boolean(PROGRAM_ID),
        }
      }
    });
  } catch (error) {
    console.error('计算费用失败:', error);
    res.status(500).json({
      success: false,
      error: '计算费用失败',
      details: error.message
    });
  }
});

// 获取账户余额
app.get('/api/account/balance/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const pubkey = new PublicKey(address);
    const balanceLamports = await connection.getBalance(pubkey, 'confirmed');
    res.json({ success: true, data: { balanceLamports, balanceSOL: balanceLamports / LAMPORTS_PER_SOL } });
  } catch (error) {
    res.status(500).json({ success: false, error: '获取余额失败', details: error.message });
  }
});

if (require.main === module) app.listen(PORT, () => {
  console.log(`Basalt server listening on http://localhost:${PORT} - network=${NETWORK_NAME}`);
});
module.exports = { app, getPriorityPreset };
