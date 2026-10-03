// Browser UI integration using an injected wallet adapter; private key stays in Node.
const { chromium } = require('@playwright/test');
const { Keypair, Transaction, Connection } = require('@solana/web3.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = path.resolve('review_artifacts/new-devnet');
(async () => {
  const connection = new Connection('http://localhost:3001/api/rpc', 'confirmed');
  assert.equal(await connection.getGenesisHash(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json')))));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('basaltTestSign', bytes => {
      const tx = Transaction.from(Buffer.from(bytes));
      assert(tx.feePayer.equals(wallet.publicKey));
      assert(tx.instructions.some(ix => ix.programId.toBase58() === 'GRJr1pdTLEqpWRiSvvWCLZViKqxD7tiMYpPUEjUUgZin'));
      tx.partialSign(wallet);
      return Array.from(tx.serialize());
    });
    await page.addInitScript(({ bytes, address }) => {
      const handlers = new Map();
      const publicKey = { toBytes: () => Uint8Array.from(bytes), toBase58: () => address, toString: () => address };
      const adapter = {
        isPhantom: true, isConnected: false, publicKey,
        on(event, fn) { handlers.set(event, fn); return this; },
        off(event) { handlers.delete(event); return this; },
        async connect() { this.isConnected = true; return { publicKey }; },
        async disconnect() { this.isConnected = false; handlers.get('disconnect')?.(); },
        async signTransaction(tx) {
          const signed = await window.basaltTestSign(Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
          return tx.constructor.from(Uint8Array.from(signed));
        },
      };
      window.phantom = { solana: adapter };
    }, { bytes: Array.from(wallet.publicKey.toBytes()), address: wallet.publicKey.toBase58() });
    await page.goto('http://localhost:5173');
    await page.getByRole('button', { name: 'Select Wallet' }).click();
    await page.getByRole('button', { name: /Phantom/ }).click();
    await page.locator('textarea').waitFor({ timeout: 30000 });
    // Wait for initial history load to finish so it cannot overwrite the new result.
    await page.waitForTimeout(2000);
    await page.getByText('加载中...', { exact: true }).first().waitFor({ state: 'hidden', timeout: 120000 }).catch(() => {});
    const message = 'Browser Devnet test ' + new Date().toISOString();
    await page.locator('textarea').fill(message);
    const button = page.getByRole('button', { name: '铭刻到测试链' });
    await button.waitFor();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('铭刻到测试链') && !b.disabled), { timeout: 30000 });
    const dialogPromise = page.waitForEvent('dialog', { timeout: 120000 });
    await button.click();
    const dialog = await dialogPromise;
    const result = dialog.message();
    await dialog.accept();
    assert(result.includes('铭刻成功'), result);
    await page.locator('article').filter({ hasText: message }).waitFor({ timeout: 10000 });
    const signature = result.split('交易签名: ')[1].trim();
    await page.getByPlaceholder('输入关键词或地址进行搜索').fill(signature);
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('article').length === 1, { timeout: 60000 });
    assert((await page.locator('article').innerText()).includes(message));
    await page.screenshot({ path: path.join(out, 'browser-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'browser-mobile.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile viewport overflow');
    assert.equal(errors.length, 0, errors.join('\n'));
    const report = { status: 'PASS', signature, wallet: 'injected adapter, node-local signer', checks: ['connect', 'estimate', 'submit', 'confirm', 'record rendering', 'signature search', 'desktop/mobile render'], pageErrors: errors };
    fs.writeFileSync(path.join(out, 'browser-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

