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
- 需要测试 SOL 支付网络费、服务费和新账户的租金储备；以页面实时估算为准
- 当前程序没有记录修改或删除指令；Devnet 可能重置，且程序仍可由升级权限持有人升级
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

## 信息寻回与长期索引

升级合约后设置服务端 `PERSISTENT_RECORDS=true` 并重启 API。新消息正文（最多 560 UTF-8 字节）直接存在 rent-exempt Record PDA 中，不再依赖历史 Memo 交易的 RPC 保留期。

- 每条记录得到 `BS1:程序地址:记录地址` 寻回号，可复制、显示二维码、下载 JSON 凭证；寻回一次读取账户，即 O(1)，实际延迟取决于 RPC。
- 钱包有独立的发出/收到目录。用户输入钱包地址或连接钱包自动填入地址，即可查出对应寻回号；公开信息查询不需要签名。
- Record 含 `previous_sent` 与 `previous_received`，分别串联发送者与接收者的历史。目录同时保存按钱包+序号派生的 Entry PDA，避免为了读第 N 页遍历前 N 页。
- 每页最多 10 条：一次读 Head、一次批量读 Entry、一次批量读 Record，共 3 次账户 RPC；总记录数增加不增加单页 RPC 次数。游标使用十进制 u64，新增记录不改变已有页的序号。
- 每次写入原子地更新正文、双向索引、两个目录头。并发写入相同目录导致序号过期时交易失败，用户确认失败后重新发起；不要对未知广播结果自动重复提交。
- 新记录需要 726 字节正文账户、两个 40 字节目录项；首次涉及的收发目录各需 80 字节账户。发送者支付所有租金储备，接收者无需余额或签名。租金单列，不是服务费；当前无关闭账户退租接口。
- 旧 Memo 不自动迁移，只能通过交易签名和支持对应历史的 RPC 寻回。全局关键词搜索仍是有限历史查询，不是链上全文索引。
- 数据和钱包关联公开可读；这是账户持久化而不是加密存储。长期正式使用应部署主网、备份凭证、配置可靠 RPC 并明确升级权限治理；Devnet 不承诺永久保存。

验证：`npm run test:recovery`（离线编解码、23 条记录分页、固定 RPC 次数与异常账户），`npm run test:recovery:devnet`（真实测试链写入与关联），`node tests/recovery-browser.cjs`（寻回、二维码、凭证下载、移动端）。后两项要求服务运行，前者的 live 测试会花费测试 SOL。
