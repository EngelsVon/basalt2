const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { createMemoInstruction } = require('@solana/spl-memo');

const app = express();
const PORT = process.env.PORT || 3001;

// 可配置服务费参数
const SERVICE_FEE_WALLET = process.env.SERVICE_FEE_WALLET || '6TnyoYQzXqZV4Awu8kiUYX343MTAa7dTx7tLiBzcoT4Z';
const SERVICE_FEE_RATE = parseFloat(process.env.SERVICE_FEE_RATE || '20'); // 百分比
// 取消下限：按用户要求无下限
const MIN_SERVICE_FEE_LAMPORTS = 0;

// Solana连接配置 - 使用更稳定的RPC端点
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://devnet.helius-rpc.com/?api-key=demo';
const connection = new Connection(SOLANA_RPC_URL, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
  wsEndpoint: undefined // 禁用WebSocket连接以提高稳定性
});

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

// 中间件配置
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => callback(null, true), // 放宽CORS以便本地开发(5173/5174/5175等端口)
  credentials: true
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
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

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    network: NETWORK_NAME,
  });
});

// 新增：配置查询端点，供前端展示/对齐
app.get('/api/config', (req, res) => {
  const presets = {
    low: getPriorityPreset('low'),
    medium: getPriorityPreset('medium'),
    high: getPriorityPreset('high'),
  };
  res.json({
    success: true,
    data: {
      network: NETWORK_NAME,
      serviceFeeWallet: SERVICE_FEE_WALLET,
      serviceFeeRate: SERVICE_FEE_RATE,
      priorityPresets: presets,
      defaultPriority: 'medium',
      programMode: false,
      programId: process.env.PROGRAM_ID || null,
    }
  });
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
    const { cuLimit, cuPriceMicroLamports } = getPriorityPreset(priority);
    const priorityFeeLamports = Math.ceil((cuLimit * cuPriceMicroLamports) / 1_000_000);

    // 合计“网络费” = 基础费 + 优先费（不含服务费）
    const networkFee = baseNetworkFee + priorityFeeLamports;

    // 服务费 = 优先费的 SERVICE_FEE_RATE%
    const rate = isNaN(SERVICE_FEE_RATE) ? 0 : SERVICE_FEE_RATE;
    const rawServiceFee = Math.floor(priorityFeeLamports * (rate / 100));
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
        serviceFeeWallet: SERVICE_FEE_WALLET,
        type,
        // 诊断信息（不会在前端使用，但便于调试）
        debug: {
          baseNetworkFee,
          priorityFeeLamports,
          cuLimit,
          cuPriceMicroLamports,
          priorityPreset: priority,
          network: NETWORK_NAME,
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

app.listen(PORT, () => {
  console.log(`Basalt server listening on http://localhost:${PORT} - network=${NETWORK_NAME}`);
});