# Basalt (玄武岩) - 区块链爱情见证平台

一个基于 Solana 区块链的去中心化应用，让用户可以将珍贵的爱情见证、承诺和回忆永久保存在区块链上。

## 功能特性

- 🔗 **钱包连接**: 支持 Phantom、Solflare 等主流 Solana 钱包
- 💝 **消息铭刻**: 将爱情见证永久存储在 Solana 区块链上
- 🔍 **记录查询**: 搜索和查看已铭刻的消息记录
- 🌐 **测试网支持**: 当前支持 Solana Devnet 进行测试
- 💰 **透明费用**: 收取网络费用的 120%（包含 20% 服务费）

## 技术栈

- **前端**: React + TypeScript + Vite
- **样式**: Tailwind CSS
- **区块链**: Solana Web3.js + SPL Memo 程序
- **钱包集成**: Solana Wallet Adapter

## 快速开始

1. 安装依赖:
```bash
npm install
```

2. 启动开发服务器:
```bash
npm run dev
```

3. 在浏览器中打开 http://localhost:5173

4. 连接你的 Solana 钱包（确保切换到 Devnet）

5. 开始铭刻你的爱情见证！

## 使用说明

1. **连接钱包**: 点击右上角的钱包按钮连接你的 Solana 钱包
2. **铭刻消息**: 在文本框中输入你想要永久保存的消息
3. **设置接收者**: （可选）输入接收者的钱包地址
4. **确认交易**: 点击铭刻按钮并在钱包中确认交易
5. **查看记录**: 交易确认后可以在页面下方查看铭刻记录

## 注意事项

- 当前仅支持 Solana Devnet，请确保钱包切换到测试网络
- 需要少量 SOL 作为交易费用（约 0.0012 SOL）
- 铭刻的消息将永久存储在区块链上，无法删除或修改
- 可以在 Solana Explorer 中查看交易详情

## 开发计划

- [ ] 支持主网 (Mainnet)
- [ ] 支持 Polygon 等其他区块链
- [ ] NFT 铸造功能
- [ ] 跨链桥接
- [ ] 高级套餐（全链放送）
- [ ] 更丰富的查询功能

## 许可证

MIT License


## Devnet deployment (2026-10-03)

Program: `GRJr1pdTLEqpWRiSvvWCLZViKqxD7tiMYpPUEjUUgZin`.
Old program is left unchanged. The program address is public; deployment keys stay outside the repository.

### Local startup

1. `npm ci` and `npm --prefix server ci`.
2. Copy `server/.env.example` to `server/.env` when setting up a new checkout. Set `SERVICE_FEE_WALLET` to the fee recipient. For this machine, enable `HTTPS_PROXY=http://127.0.0.1:7897`.
3. Start API: `npm --prefix server start` (port 3001).
4. Start UI: `npm run dev` (http://localhost:5173). Use a Devnet wallet with test SOL.
5. Browser RPC requests pass through the API's allowlisted `/api/rpc` route; private keys never enter the API.

### Verification

- `npm run build` and `npm run lint`
- `npm run test:devnet`: live Devnet transactions, readback, fees, and simulated rejection cases.
- `npm run test:browser`: Chrome headless UI test with an injected wallet adapter signing via the local Node process. Requires Chrome, both servers, and `~/.config/solana/id.json`; it spends test SOL. This tests the adapter flow, not the actual Phantom extension UI.
- Reports/screenshots are saved under `review_artifacts/new-devnet` (ignored by Git).

### Deployment and upgrades

Build artifacts in GitHub Actions embed the declared program ID. Deploy the matching `.so` with the program keypair and the existing upgrade authority; do not generate a new ID during an upgrade. The local program key is `~/.config/solana/basalt-devnet-20261003-keypair.json`, while the upgrade/fee payer wallet is `~/.config/solana/id.json`. Keep backups outside Git.

`node server/scripts/init_config.js` initializes the config once and skips an existing config. Existing config changes require an authorized on-chain update, not just an `.env` edit.
