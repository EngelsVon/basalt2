import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { SolanaService, InscriptionData } from '../services/solanaService';
import type { Direction } from '../services/recordService';

export function RecoveryReceipt({ record }: { record: InscriptionData }) {
  const code = record.recoveryCode || record.signature;
  const [qr, setQr] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { let active = true; QRCode.toDataURL(code, { width: 220, margin: 1 }).then(url => { if (active) setQr(url); }).catch(() => { if (active) setNotice('二维码生成失败，请复制寻回号'); }); return () => { active = false; }; }, [code]);
  const download = () => {
    const blob = new Blob([JSON.stringify({ schema: 'basalt-receipt-v1', network: 'devnet', ...record, recoveryCode: code }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `basalt-${(record.recordAddress || record.signature).slice(0,12)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="border rounded-lg p-4 my-3 space-y-3" data-testid="recovery-receipt">
    <p className="whitespace-pre-wrap break-words">{record.message}</p>
    <p className="text-xs break-all">发送：{record.sender}<br/>接收：{record.recipient || '自己'}</p>
    <p className="text-sm">{record.status === 'pending' ? '待确认：请先查询，勿重复提交' : '链上已确认'} · {new Date(record.timestamp).toLocaleString()}</p>
    <label className="block text-sm">{record.recoveryCode ? '链上寻回号' : '旧记录寻回号（交易签名）'}
      <textarea readOnly aria-label="寻回号" className="input-field text-xs break-all mt-2" value={code} rows={3}/>
    </label>
    <div className="flex flex-wrap gap-2">
      <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(code).then(() => setNotice('已复制')).catch(() => setNotice('请选中上方寻回号手动复制'))}>复制寻回号</button>
      <button className="btn-secondary" onClick={download}>下载凭证</button>
    </div>
    <details><summary className="cursor-pointer text-sm">显示寻回二维码</summary>{qr && <img src={qr} width={220} height={220} alt="寻回号二维码"/>}</details>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <a className="text-blue-600 text-sm" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/${record.recordAddress ? 'address/'+record.recordAddress : 'tx/'+record.signature}?cluster=devnet`}>查看链上凭证</a>
  </div>;
}

export function RecoveryPanel({ service, wallet, lastReceipt }: { service: SolanaService | null; wallet?: string; lastReceipt: InscriptionData | null }) {
  const [code,setCode] = useState('');
  const [address,setAddress] = useState('');
  const [direction,setDirection] = useState<Direction>('sent');
  const [records,setRecords] = useState<InscriptionData[]>([]);
  const [cursor,setCursor] = useState<string>();
  const [total,setTotal] = useState('0');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const request = useRef(0);
  // Cursor belongs to the queried wallet/direction; editing invalidates it immediately.
  const changeAddress = (value: string) => { request.current++; setBusy(false); setAddress(value); setCursor(undefined); setRecords([]); setTotal('0'); };
  const changeDirection = (value: Direction) => { request.current++; setBusy(false); setDirection(value); setCursor(undefined); setRecords([]); setTotal('0'); };
  async function recover(value = code) {
    if (!service || !value.trim()) return;
    const id=++request.current;setBusy(true);setError('');setCursor(undefined);setRecords([]);setTotal('0');
    try { const record=await service.recover(value); if (id===request.current) {setRecords(record ? [record] : []);setTotal(record?'1':'0');if(!record)setError('未找到记录；旧交易可能需要历史 RPC');} }
    catch(e) {if(id===request.current)setError(String(e));}
    finally {if(id===request.current)setBusy(false);}
  }
  async function list(more=false) {
    if (!service || !address.trim()) return;
    const id=++request.current;setBusy(true);setError('');
    if(!more){setRecords([]);setCursor(undefined);setTotal('0');}
    try {const page=await service.getWalletRecords(address.trim(),direction,more?cursor:undefined); if(id===request.current){setRecords(old=>more?[...old,...page.records]:page.records);setCursor(page.nextCursor);setTotal(page.total);} }
    catch(e){if(id===request.current)setError(String(e));}
    finally{if(id===request.current)setBusy(false);}
  }
  return <section className="card max-w-xl mx-auto mt-8 space-y-5" aria-label="信息寻回">
    <h2 className="text-xl font-semibold">信息寻回</h2>
    <p className="text-sm text-basalt-600">新寻回号直接读取链上账户，不扫描历史交易。钱包目录区分发出与收到，每次加载 10 条。无需连接钱包也能查询公开记录。</p>
    {lastReceipt && <details open><summary>刚刚铭刻的凭证</summary><RecoveryReceipt record={lastReceipt}/></details>}
    <div className="space-y-2">
      <label htmlFor="recovery-code">寻回号或旧交易签名</label>
      <input id="recovery-code" className="input-field" value={code} onChange={e=>setCode(e.target.value)} placeholder="BS1:程序地址:记录地址 或交易签名"/>
      <button className="btn-primary" disabled={busy || !code.trim()} onClick={()=>recover()}>按寻回号查询</button>
    </div>
    <div className="space-y-2">
      <label htmlFor="recovery-wallet">钱包地址</label>
      <input id="recovery-wallet" className="input-field" value={address} onChange={e=>changeAddress(e.target.value)} placeholder="输入钱包地址查找寻回号"/>
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" disabled={!wallet || busy} onClick={()=>changeAddress(wallet!)}>填入我的钱包</button>
        <select aria-label="钱包目录" value={direction} onChange={e=>changeDirection(e.target.value as Direction)}><option value="sent">我发出的</option><option value="inbox">我收到的</option></select>
        <button className="btn-primary" disabled={busy || !address.trim()} onClick={()=>list()}>查询钱包</button>
      </div>
    </div>
    {error && <p role="alert" className="text-red-600 break-words">{error}</p>}
    <p role="status" className="text-sm">{busy?'正在读取链上账户…':`已显示 ${records.length} 条 · 目录总数 ${total}`}</p>
    {records.map(record=><div key={record.recoveryCode || record.signature}><RecoveryReceipt record={record}/>
      {record.previousSent && <button className="btn-secondary text-sm" disabled={busy} onClick={()=>{setCode(record.previousSent!);recover(record.previousSent!);}}>沿链查看发送者上一条</button>}
    </div>)}
    {cursor && <button className="btn-secondary" disabled={busy} onClick={()=>list(true)}>加载更早记录</button>}
    <p className="text-xs text-basalt-500">链上目录仅覆盖升级后新写入的记录；旧 Memo 使用交易签名寻回。Devnet 是测试网络，可能重置；此版本不提供删除或修改记录的指令。</p>
  </section>;
}
