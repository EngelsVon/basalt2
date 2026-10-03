import { RecoveryPanel } from './RecoveryPanel';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { SolanaService, type FeeResponseData, type InscriptionData } from '../services/solanaService';
import { Heart, Search, Wallet } from 'lucide-react';

export const BasaltApp: React.FC = () => {
  const { publicKey, sendTransaction, connected, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [message, setMessage] = useState('');
  const [lastReceipt, setLastReceipt] = useState<InscriptionData | null>(null);
  const [recipient, setRecipient] = useState('');
  const [inscriptionType, setInscriptionType] = useState<'love' | 'general' | 'agreement'>('general');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [isInscribing, setIsInscribing] = useState(false);
  const [inscriptions, setInscriptions] = useState<InscriptionData[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(inscriptions.length / 5));
  const itemsPerPage = 5;
  const [balance, setBalance] = useState<number | null>(null);
  const [estimatedFee, setEstimatedFee] = useState<FeeResponseData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [solanaService, setSolanaService] = useState<SolanaService | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  // 初始化Solana服务
  useEffect(() => {
    if (connection) {
      const service = new SolanaService(connection);
      setSolanaService(service);
    }
  }, [connection]);

  const accountRef = useRef(publicKey?.toBase58());
  accountRef.current = publicKey?.toBase58();
  const fetchBalance = useCallback(async () => {
    if (!publicKey || !solanaService) return;
    const address = publicKey.toBase58();
    try {
      const value = await solanaService.getBalance(publicKey);
      if (accountRef.current === address) setBalance(value);
    } catch (error) { console.error(error); }
  }, [publicKey, solanaService]);

  // 铭刻消息
  const handleInscribe = async () => {
    if (!publicKey || !sendTransaction || !message.trim() || !solanaService) {
      alert('请连接钱包并输入消息');
      return;
    }

    // 检查余额是否足够
    if (balance !== null && estimatedFee !== null) {
      const feeAmount = typeof estimatedFee === 'object' ? estimatedFee.totalFeeSOL : estimatedFee;
      if (balance < feeAmount) {
        alert(`余额不足！需要至少 ${feeAmount.toFixed(4)} SOL，当前余额: ${balance.toFixed(4)} SOL`);
        return;
      }
    }

    setIsInscribing(true);
    try {
      const inscriptionData = await solanaService.inscribeMessage(
        message,
        publicKey,
        sendTransaction,
        recipient.trim() || undefined,
        signTransaction ?? undefined,
        inscriptionType,
        priority
      );
      
      setLastReceipt(inscriptionData);
      // 添加到本地记录
      setInscriptions(prev => [inscriptionData, ...prev]);
      setMessage('');
      setRecipient('');
      setInscriptionType('general');
      setPriority('medium');
      
      if (inscriptionData.status === 'pending') {
        alert(`⏰ 交易已提交但确认中\n\n交易签名: ${inscriptionData.signature}\n\n由于网络拥堵，交易确认可能需要更长时间。\n您可以在 Solana Explorer 中查看交易状态。\n\n注意：链上执行失败仍可能扣除网络费，请先查询签名再重试。`);
      } else {
        alert(`✅ 铭刻成功！\n交易签名: ${inscriptionData.signature}`);
      }
      
      fetchBalance();
    } catch (error) {
      console.error('铭刻失败:', error);
      alert(`❌ 铭刻失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsInscribing(false);
    }
  };

  // 清空搜索结果
  const clearSearch = () => {
    setSearchQuery('');
    setInscriptions([]);
    setCurrentPage(1);

    if (connected && publicKey) {
      loadUserInscriptions();
    }
  };

  // 搜索铭刻记录（按地址或关键字）
  const handleSearch = async (query?: string) => {
    const searchTerm = (query ?? searchQuery).trim();
    if (!searchTerm || !solanaService) return;

    setIsSearching(true);
    setCurrentPage(1);

    try {
      // 记录搜索历史
      if (!searchHistory.includes(searchTerm)) {
        const newHistory = [searchTerm, ...searchHistory.slice(0, 9)];
        setSearchHistory(newHistory);
        localStorage.setItem('basalt_search_history', JSON.stringify(newHistory));
      }

      let results: InscriptionData[] = [];

      // 优先尝试按地址查询
      if (searchTerm.length >= 32) {
        try {
          results = await solanaService.getInscriptionsByAddress(searchTerm);
        } catch {
          console.warn('按地址查询失败，尝试关键字搜索');
        }
      }

      // 关键字搜索（在当前用户相关地址中，若无则全局可扩展）
      if (results.length === 0) {
        const scopes: string[] = [];
        if (publicKey) scopes.push(publicKey.toString());
        results = await solanaService.searchInscriptions(searchTerm, scopes);
      }

      if (results.length === 0) {
        alert('未找到相关记录');
        setInscriptions([]);

      } else {
        results.sort((a, b) => b.timestamp - a.timestamp);
        setInscriptions(results);

      }
    } catch (error) {
      console.error('搜索失败:', error);
      alert(`搜索失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsSearching(false);
    }
  };

  // 加载用户的铭刻记录
  const loadUserInscriptions = useCallback(async () => {
    if (!publicKey || !solanaService) return;
    
    setIsLoading(true);
    try {
      const config = await solanaService.getApiConfig();
      const userInscriptions = config.persistentRecords
        ? (await solanaService.getWalletRecords(publicKey.toString(), 'sent')).records
        : await solanaService.getInscriptionsByAddress(publicKey.toString());
      userInscriptions.sort((a, b) => b.timestamp - a.timestamp);
      if (accountRef.current === publicKey.toBase58()) { setInscriptions(userInscriptions); setCurrentPage(1); }

    } catch (error) {
      console.error('加载铭刻记录失败:', error);
    } finally {
      setIsLoading(false);
    }
  }, [publicKey, solanaService]);

  // 获取当前页的数据
  const getCurrentPageData = () => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return inscriptions.slice(startIndex, endIndex);
  };

  useEffect(() => {
    setBalance(null);
    setInscriptions([]);
    setCurrentPage(1);
    if (connected && publicKey && solanaService) {
      fetchBalance();
      loadUserInscriptions();
    }
  }, [connected, publicKey, solanaService, fetchBalance, loadUserInscriptions]);
  
  // 加载搜索历史
  useEffect(() => {
    const savedHistory = localStorage.getItem('basalt_search_history');
    if (savedHistory) {
      try {
        const parsed: unknown = JSON.parse(savedHistory);
        if (Array.isArray(parsed)) setSearchHistory(parsed.filter((x): x is string => typeof x === 'string').slice(0, 10));
      } catch (error) {
        console.error('加载搜索历史失败:', error);
      }
    }
  }, []);

  // 实时费用估算（随消息/类型/优先费变化）
  useEffect(() => {
    let cancelled = false;
    setEstimatedFee(null);
    const estimateFee = async () => {
      if (solanaService && message.trim()) {
        try {
          const fee = await solanaService.calculateInscriptionFee(message.trim(), inscriptionType, priority, publicKey?.toBase58(), recipient.trim() || undefined);
          if (!cancelled) setEstimatedFee(fee);
        } catch (error) {
          console.error('估算费用失败:', error);
          if (!cancelled) setEstimatedFee(null);
        }
      } else {
        setEstimatedFee(null);
      }
    };

    const timeoutId = setTimeout(estimateFee, 500);
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [solanaService, message, inscriptionType, priority, publicKey, recipient]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-basalt-50 to-basalt-100">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-basalt-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 bg-basalt-600 rounded-lg flex items-center justify-center">
                <Heart className="w-5 h-5 text-white" />
              </div>
              <h1 className="text-2xl font-bold text-basalt-900">Basalt</h1>
              <span className="hidden sm:inline-flex text-sm text-basalt-500 bg-basalt-100 px-2 py-1 rounded-full">
                玄武岩 - 永恒的爱情见证
              </span>
            </div>
            <WalletMultiButton className="!bg-basalt-600 hover:!bg-basalt-700" />
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {!publicKey ? (
          // 未连接钱包的欢迎页面
          <div className="text-center py-20">
            <div className="max-w-2xl mx-auto">
              <div className="w-24 h-24 bg-basalt-600 rounded-full flex items-center justify-center mx-auto mb-8">
                <Heart className="w-12 h-12 text-white" />
              </div>
              <h2 className="text-4xl font-bold text-basalt-900 mb-4">
                将爱情铭刻在区块链上
              </h2>
              <p className="text-xl text-basalt-600 mb-8 leading-relaxed">
                Basalt 将珍贵的爱情见证、承诺和回忆写入 Solana 链上账户，<br/>
                用寻回号和钱包目录再次找到。当前为可能重置的 Devnet 测试网络。
              </p>
              
              <div className="bg-basalt-50 rounded-xl p-6 mb-8">
                <h3 className="text-lg font-semibold text-basalt-800 mb-4">✨ 主要功能</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-basalt-600">
                  <div className="flex items-center space-x-2">
                    <Heart className="w-4 h-4 text-red-500" />
                    <span>链上存储信息</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Search className="w-4 h-4 text-blue-500" />
                    <span>快速查询记录</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Wallet className="w-4 h-4 text-green-500" />
                    <span>安全钱包连接</span>
                  </div>
                </div>
              </div>
              
              <div className="flex items-center justify-center space-x-2 text-basalt-500 mb-8">
                <Wallet className="w-5 h-5" />
                <span>请先连接您的 Solana 钱包开始使用</span>
              </div>
            </div>
          </div>
        ) : (
          // 已连接钱包的主要功能区域
          <div className="grid grid-cols-1 gap-6">
            <div className="space-y-8">
              {/* 加载状态 */}
              {(isLoading || isSearching) && (
                <div className="fixed top-4 right-4 bg-white shadow-lg rounded-lg p-4 border border-basalt-200 z-50">
                  <div className="flex items-center space-x-3">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-basalt-600"></div>
                    <span className="text-basalt-700 font-medium">
                      {isLoading ? '加载中...' : '搜索中...'}
                    </span>
                  </div>
                </div>
              )}
              {/* 铭刻区域 */}
              <div className="card max-w-xl mx-auto">
                <h3 className="text-2xl font-semibold text-basalt-900 mb-6 flex items-center justify-center">
                  <Heart className="w-6 h-6 mr-2 text-red-500" />
                  铭刻类型
                </h3>

                {/* 连接状态提示 */}
                {!connected && (
                  <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <div className="flex items-center">
                      <Wallet className="w-5 h-5 text-yellow-600 mr-2" />
                      <p className="text-yellow-800">请先连接钱包以使用铭刻功能</p>
                    </div>
                  </div>
                )}
              
                {/* 将操作表单区域居中并限制宽度 */}
                <div className="space-y-4 max-w-xl mx-auto">
                  <div>
                    <label className="block text-sm font-medium text-basalt-700 mb-2">铭刻类型</label>
                    <select
                      value={inscriptionType}
                      onChange={(e) => setInscriptionType(e.target.value as 'love' | 'general' | 'agreement')}
                      className="input-field"
                    >
                      <option value="general">通用</option>
                      <option value="love">爱情契约</option>
                      <option value="agreement">一般契约</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-basalt-700 mb-2">优先费档位</label>
                    <select
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as 'low' | 'medium' | 'high')}
                      className="input-field"
                    >
                      <option value="low">低（更省费，速度较慢）</option>
                      <option value="medium">中（推荐，均衡）</option>
                      <option value="high">高（更快，费用较高）</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-basalt-700 mb-2">铭刻内容</label>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value.slice(0, 280))}
                      placeholder="写下你想铭刻在链上的话..."
                      rows={4}
                      maxLength={280}
                      className="input-field"
                    />
                    <div className="mt-1 text-xs text-basalt-500 text-right">{message.length}/280 字符 · {new TextEncoder().encode(message).length}/560 UTF-8 字节</div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-basalt-700 mb-2">接收者地址 (可选)</label>
                    <input
                      type="text"
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                      placeholder="输入 Solana 钱包地址 (留空则发送给自己)"
                      className="input-field"
                    />
                  </div>

                  {/* 余额和费用信息 */}
                  {connected && (
                    <div className="bg-gradient-to-r from-basalt-50 to-blue-50 rounded-lg p-4 mb-6 border border-basalt-200">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-medium text-basalt-700">当前余额</span>
                            <span className={`text-lg font-semibold ${
                              balance !== null && estimatedFee && balance < (typeof estimatedFee === 'object' ? estimatedFee.totalFeeSOL : estimatedFee)
                                ? 'text-red-600' 
                                : 'text-basalt-900'
                            }`}>
                              {balance !== null ? `${balance.toFixed(6)} SOL` : (
                                <div className="flex items-center space-x-2">
                                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-basalt-400"></div>
                                  <span className="text-sm text-basalt-500">加载中...</span>
                                </div>
                              )}
                            </span>
                          </div>
                          
                          {balance !== null && estimatedFee && (
                            <div className="flex justify-between items-center text-sm">
                              <span className="text-basalt-600">铭刻后余额</span>
                              <span className={`font-medium ${
                                balance - (typeof estimatedFee === 'object' ? estimatedFee.totalFeeSOL : estimatedFee) < 0 ? 'text-red-600' : 'text-green-600'
                              }`}>
                                {(balance - (typeof estimatedFee === 'object' ? estimatedFee.totalFeeSOL : estimatedFee)).toFixed(6)} SOL
                              </span>
                            </div>
                          )}
                        </div>
                        
                        <div className="space-y-2">
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-medium text-basalt-700">铭刻费用</span>
                            <span className="text-lg font-semibold text-blue-600">
                              {estimatedFee ? `${(typeof estimatedFee === 'object' ? estimatedFee.totalFeeSOL : estimatedFee).toFixed(6)} SOL` : '~0.001 SOL'}
                            </span>
                          </div>
                          
                          {estimatedFee && typeof estimatedFee === 'object' && (
                            <div className="text-xs text-basalt-500 space-y-1">
                              <div>类型: {inscriptionType === 'general' ? '通用' : inscriptionType === 'love' ? '爱情契约' : '一般契约'}</div>
                              <div>优先费档位: {priority === 'low' ? '低' : priority === 'high' ? '高' : '中'}</div>
                              <div>网络费用: {(estimatedFee.networkFee / 1000000000).toFixed(6)} SOL</div>
                              <div>服务费: {estimatedFee.serviceFeeSOL.toFixed(6)} SOL</div>
                              <div>链上存储储备: {(estimatedFee.storageRentSOL || 0).toFixed(6)} SOL（一次性，当前不支持退回）</div>
                              {estimatedFee.serviceFeeWallet && (
                                <div className="text-xs text-basalt-400 mt-1 flex items-center gap-1">
                                  <span>服务费收款地址:</span>
                                  <a
                                    href={`https://explorer.solana.com/address/${estimatedFee.serviceFeeWallet}?cluster=devnet`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-blue-500 hover:underline inline-flex items-center gap-1"
                                  >
                                    {`${estimatedFee.serviceFeeWallet.slice(0, 6)}...${estimatedFee.serviceFeeWallet.slice(-4)}`}
                                  </a>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      
                      {estimatedFee && balance !== null && (
                        <div className="mt-3 pt-3 border-t border-basalt-200">
                          {balance < (typeof estimatedFee === 'object' ? estimatedFee.totalFeeSOL : estimatedFee) ? (
                            <div className="flex items-center space-x-2 text-red-600">
                              <span className="text-lg">⚠️</span>
                              <span className="text-sm font-medium">余额不足，需要至少 {(typeof estimatedFee === 'object' ? estimatedFee.totalFeeSOL : estimatedFee).toFixed(6)} SOL</span>
                            </div>
                          ) : (
                            <div className="flex items-center space-x-2 text-green-600">
                              <span className="text-lg">✅</span>
                              <span className="text-sm font-medium">余额充足，可以发起铭刻</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <button
                    onClick={handleInscribe}
                    disabled={!message.trim() || isInscribing || !connected || !estimatedFee || (balance !== null && balance < estimatedFee.totalFeeSOL)}
                    className={`w-full px-8 py-3 text-lg font-semibold rounded-lg transition-all duration-200 flex items-center justify-center space-x-2 ${
                      !message.trim() || !connected || (estimatedFee && balance !== null && balance < (typeof estimatedFee === 'object' ? estimatedFee.totalFeeSOL : estimatedFee))
                        ? 'bg-basalt-300 text-basalt-500 cursor-not-allowed'
                        : isInscribing
                        ? 'bg-blue-500 text-white cursor-wait'
                        : 'bg-gradient-to-r from-red-500 to-pink-500 text-white hover:from-red-600 hover:to-pink-600 transform hover:scale-105 shadow-lg hover:shadow-xl'
                    }`}
                  >
                    {isInscribing ? (
                      <>
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                        <span>铭刻中...</span>
                      </>
                    ) : (
                      <>
                        <Heart className="w-5 h-5" />
                        <span>铭刻到测试链</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              <section className="card max-w-xl mx-auto" aria-label="铭刻记录">
                <h3>铭刻记录 ({inscriptions.length})</h3>
                <p className="text-xs">最新记录；完整收发目录与更早记录请使用下方信息寻回。</p>
                {getCurrentPageData().map(item => <article key={item.recoveryCode || item.signature} className="my-4 border-b p-3">
                  <p className="whitespace-pre-wrap break-words">{item.message}</p>
                  <p className="text-xs break-all">发送者：{item.sender}</p>
                  {item.recipient && <p className="text-xs break-all">接收者：{item.recipient}</p>}
                  <a href={`https://explorer.solana.com/${item.recordAddress ? 'address/'+item.recordAddress : 'tx/'+item.signature}?cluster=devnet`} target="_blank" rel="noreferrer">{item.status || 'confirmed'} · 查看链上记录</a>
                </article>)}
                {!inscriptions.length && <p>暂无记录</p>}
                <button disabled={currentPage <= 1} onClick={() => setCurrentPage(p => p - 1)}>上一页</button>
                <span className="mx-4">{currentPage} / {totalPages}</span>
                <button disabled={currentPage >= totalPages} onClick={() => setCurrentPage(p => p + 1)}>下一页</button>
              </section>

              {/* 搜索区域 */}
              <div className="card max-w-xl mx-auto">
                <h3 className="text-2xl font-semibold text-basalt-900 mb-6 flex items-center">
                  <Search className="w-6 h-6 mr-2 text-blue-500" />
                  查询铭刻记录
                </h3>
                
                <div className="flex flex-wrap sm:flex-nowrap gap-2 mb-4">
                   <input
                     type="text"
                     value={searchQuery}
                     onChange={(e) => setSearchQuery(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
                     placeholder="输入关键词或地址进行搜索"
                     className="input-field min-w-0 flex-1 basis-full sm:basis-auto"
                   />
                   <button
                     className="btn-primary"
                     disabled={!searchQuery.trim() || isSearching}
                     onClick={() => handleSearch()}
                   >
                     {isSearching ? '搜索中...' : '搜索'}
                   </button>
                   <button className="btn-secondary" onClick={clearSearch}>清空</button>
                 </div>

                 {searchHistory.length > 0 && (
                   <div className="mb-4">
                     <p className="text-sm text-basalt-600 mb-2">搜索历史:</p>
                     <div className="flex flex-wrap gap-2">
                       {searchHistory.map((term, index) => (
                         <button
                           key={`${term}-${index}`}
                           onClick={() => { setSearchQuery(term); handleSearch(term); }}
                           className="px-3 py-1 text-sm bg-basalt-100 text-basalt-700 rounded-full hover:bg-basalt-200 transition-colors"
                         >
                           {term.length > 20 ? `${term.slice(0, 20)}...` : term}
                         </button>
                       ))}
                     </div>
                   </div>
                 )}
              </div>
            </div>
          </div>
        )}
        <RecoveryPanel service={solanaService} wallet={publicKey?.toBase58()} lastReceipt={lastReceipt}/>
      </main>
    </div>
  );
};
