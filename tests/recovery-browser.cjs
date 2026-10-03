const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
 const out=path.resolve('review_artifacts/recovery'),receipts=JSON.parse(fs.readFileSync(path.join(out,'receipts.json'))),record=receipts[1];
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://localhost:5173');
  await page.getByRole('button',{name:'Select Wallet'}).waitFor();
  const panel=page.getByRole('region',{name:'信息寻回'});
  await panel.locator('#recovery-code').fill(record.recoveryCode);await panel.getByRole('button',{name:'按寻回号查询'}).click();
  const receipt=panel.getByTestId('recovery-receipt');await receipt.getByText(record.message,{exact:true}).waitFor({timeout:60000});
  assert.equal(await receipt.getByLabel('寻回号',{exact:true}).inputValue(),record.recoveryCode);
  await receipt.getByText('显示寻回二维码',{exact:true}).click();await receipt.getByAltText('寻回号二维码').waitFor();
  assert((await receipt.getByAltText('寻回号二维码').getAttribute('src')).startsWith('data:image/png'));
  const download=page.waitForEvent('download');await receipt.getByRole('button',{name:'下载凭证'}).click();const d=await download;await d.saveAs(path.join(out,'downloaded-receipt.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'downloaded-receipt.json'))).recoveryCode,record.recoveryCode);
  await panel.getByRole('button',{name:'沿链查看发送者上一条'}).click();await receipt.getByText(receipts[0].message,{exact:true}).waitFor({timeout:60000});
  await panel.locator('#recovery-wallet').fill(record.recipient);await panel.getByLabel('钱包目录').selectOption('inbox');await panel.getByRole('button',{name:'查询钱包',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-testid="recovery-receipt"]').length===2,{},{timeout:60000});
  await page.screenshot({path:path.join(out,'recovery-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(out,'recovery-mobile.png'),fullPage:true});
  assert.equal(errors.length,0,errors.join('\n'));console.log('PASS: disconnected recovery; QR; JSON download; previous link; wallet inbox; desktop/mobile; no page errors');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
