import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { createMemoInstruction } from '@solana/spl-memo';
import bs58 from 'bs58';

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
interface FeeResponseData {
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

// 导出服务类
export class SolanaService {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  private async getApiConfig(): Promise<ApiConfig | null> {
    try {
      const res = await fetchFromBases('/api/config');
      if (!res.ok) return null;
      const json = await res.json();
      if (!json?.success) return null;
      return json.data as ApiConfig;
    } catch (_) {
      return null;
    }
  }

  /**
   * 计算铭刻费用（包含20%服务费）- 使用后端API
   */
  async calculateInscriptionFee(
    message: string,
    type: 'love' | 'general' | 'agreement' = 'general',
    priority: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<FeeResponseData> {
    try {
      const response = await fetchFromBases('/api/inscription/calculate-fee', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, type, priority }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || '计算费用失败');
      }

      return data.data as FeeResponseData;
    } catch (error) {
      console.error('计算费用时出错:', error);
      // 返回更贴近当前网络的保守估算（约 0.000080001 SOL），避免严重低估
      const fallback: FeeResponseData = {
        networkFee: 80001, // 约 0.000080001 SOL（包含常见的优先费情况）
        serviceFee: 0,     // 回退模式不收取服务费，确保与链上实际一致性不至于高估
        totalFee: 80001,
        totalFeeSOL: 80001 / LAMPORTS_PER_SOL,
        serviceFeeSOL: 0,
        serviceFeeWallet: '',
        type,
      };
      return fallback;
    }
  }

  /**
   * 铭刻消息到区块链（优先 Program 模式，回退到纯 Memo 模式）
   */
  async inscribeMessage(
    message: string,
    senderPublicKey: PublicKey,
    sendTransaction: (transaction: Transaction, connection: Connection) => Promise<string>,
    recipient?: string,
    signTransaction?: (transaction: Transaction) => Promise<Transaction>,
    type: 'love' | 'general' | 'agreement' = 'general',
    priority: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<InscriptionData> {
    // 在 try 外部预定义，便于 catch 分支访问
    let apiConfig: ApiConfig | null = null;
    let canUseProgram: boolean = false;
    let programId: PublicKey | null = null;
    let feeInfo: FeeResponseData = {
      networkFee: 0,
      serviceFee: 0,
      totalFee: 0,
      totalFeeSOL: 0,
      serviceFeeSOL: 0,
      serviceFeeWallet: '',
      type,
    };
    try {
      // 获取最新区块哈希，确保网络可用
      await this.connection.getLatestBlockhash();

      // 读取后端配置，决定是否走 Program 模式
      apiConfig = await this.getApiConfig();
      canUseProgram = Boolean(apiConfig?.programMode && apiConfig?.programId && apiConfig?.programConfig);
      programId = canUseProgram ? new PublicKey(apiConfig!.programId!) : null;

      // 先从后端获取费用与服务费钱包信息，确保与展示一致
      feeInfo = await this.calculateInscriptionFee(message, type, priority);

      // 先构建交易
      const { blockhash } = await this.connection.getLatestBlockhash();
      const transaction = new Transaction({
        recentBlockhash: blockhash,
        feePayer: senderPublicKey,
      });

      // 添加 ComputeBudget 指令，使用选定档位（若 Program 模式启用，则不低于后端要求）
      const preset = getPriorityPreset(priority);
      let cuLimit = preset.cuLimit;
      let cuPriceMicroLamports = preset.cuPriceMicroLamports;
      if (canUseProgram && apiConfig?.programConfig) {
        cuLimit = Math.max(cuLimit, apiConfig.programConfig.minCuLimit);
        cuPriceMicroLamports = Math.max(cuPriceMicroLamports, apiConfig.programConfig.minCuPrice);
      }
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports })
      );
 
       // 构建 v1 格式的铭刻内容
       let inscriptionContent = `💎 Basalt Inscription v1 💎\n`;
       inscriptionContent += `Type: ${type}\n`;
       inscriptionContent += `Message: ${message}\n`;
       inscriptionContent += `From: ${senderPublicKey.toString()}\n`;
       if (recipient) {
         inscriptionContent += `To: ${recipient}\n`;
       }
       inscriptionContent += `Timestamp: ${Date.now()}\n`;
       inscriptionContent += `Platform: Basalt (玄武岩)`;
 
       // 创建 memo 指令
       const memoInstruction = createMemoInstruction(inscriptionContent);
 
       if (canUseProgram && programId) {
         // 计算 memo_hash（sha256），并构造 Anchor 指令数据：
         // discriminator(8) + memo_hash([u8;32]) + cu_limit(u32 LE) + cu_price(u64 LE)
         const memoHash = await sha256Bytes(inscriptionContent);
         const data = Buffer.concat([
           Buffer.from('962c2900430e490c', 'hex'),
           memoHash,
           u32LE(cuLimit),
           u64LE(cuPriceMicroLamports),
         ]);
 
         const keys = [
           { pubkey: senderPublicKey, isSigner: true, isWritable: true }, // payer
           { pubkey: deriveConfigPda(programId), isSigner: false, isWritable: true }, // config
           { pubkey: new PublicKey(apiConfig!.programConfig?.serviceFeeWallet || feeInfo.serviceFeeWallet), isSigner: false, isWritable: true }, // service_fee_wallet
           { pubkey: new PublicKey('Sysvar1nstructions1111111111111111111111111'), isSigner: false, isWritable: false }, // instructions sysvar
           { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
         ];
 
         const programIx = new TransactionInstruction({ programId, keys, data });
         // 顺序：ComputeBudget -> Program -> Memo（事件可索引 memo 文本）
         transaction.add(programIx, memoInstruction);
       } else {
         // 纯 Memo 模式：按照旧逻辑，仅附带服务费转账（如有）
         transaction.add(memoInstruction);
 
         let serviceFeeLamports = 0;
         if (feeInfo.serviceFee > 0 && feeInfo.serviceFeeWallet) {
           const serviceFeeWallet = new PublicKey(feeInfo.serviceFeeWallet);
           serviceFeeLamports = feeInfo.serviceFee; // 使用后端返回的服务费
           const transferInstruction = SystemProgram.transfer({
             fromPubkey: senderPublicKey,
             toPubkey: serviceFeeWallet,
             lamports: serviceFeeLamports,
           });
           transaction.add(transferInstruction);
         }
       }
 
       // 发送前再次刷新区块哈希，避免过期
       const { blockhash: freshBlockhash, lastValidBlockHeight: freshLastValidBlockHeight } = await this.connection.getLatestBlockhash();
       transaction.recentBlockhash = freshBlockhash;
 
       // 发送前做一个余额预检（不足则直接报错）
       try {
         const accountInfo = await this.connection.getAccountInfo(senderPublicKey);
         const balanceLamports = accountInfo?.lamports ?? 0;
         const needLamports = feeInfo.networkFee + (canUseProgram ? 0 : (feeInfo.serviceFee || 0)); // Program 模式下不再提前本地转服务费
         if (balanceLamports < needLamports) {
           throw new Error(`余额不足！当前余额: ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL，需要: ${((needLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
         }
       } catch (preflightErr) {
         throw preflightErr;
       }
 
       // 发送交易
       console.log('正在发送交易...');
       let signature: string;
       let rawTx: Uint8Array | null = null;
       if (signTransaction) {
         try {
           // 强制通过当前 DApp 的连接广播，避免钱包在错误网络上广播
           const signedTx = await signTransaction(transaction);
 
           // 发送前本地模拟，尽早拿到链上错误与日志
           try {
             const simRes = await this.connection.simulateTransaction(signedTx, {
               sigVerify: true,
               commitment: 'processed' as any,
             });
             if (simRes.value.err) {
               const simLogs = simRes.value.logs || [];
               const headLogs = (simLogs || []).slice(0, 12).join('\n');
               throw new Error(`交易模拟失败: ${JSON.stringify(simRes.value.err)}\n日志:\n${headLogs}`);
             }
           } catch (simErr) {
             // 如果模拟接口本身报错，记录但不中断（由 sendRawTransaction 继续获得更明确错误）
             console.warn('simulateTransaction 异常：', simErr);
           }
 
          rawTx = signedTx.serialize();
           signature = await this.connection.sendRawTransaction(rawTx, {
             skipPreflight: false,
             preflightCommitment: 'confirmed' as any,
             maxRetries: 3,
           } as any);
           console.log('已通过 DApp 连接直接广播交易');
         } catch (directSendErr) {
           console.warn('使用 signTransaction+sendRawTransaction 失败，回退到钱包 sendTransaction：', directSendErr);
           signature = await sendTransaction(transaction, this.connection);
         }
       } else {
         signature = await sendTransaction(transaction, this.connection);
       }
 
       console.log('交易已发送，签名:', signature);
 
       // 给网络一点时间传播
       await new Promise((resolve) => setTimeout(resolve, 1200));
       console.log('交易已提交，进入确认流程...');
 
       // 立即检查交易是否被网络拒绝
       try {
         const immediateStatus = await this.connection.getSignatureStatus(signature);
         console.log('交易立即状态:', immediateStatus);
 
         if (immediateStatus.value?.err) {
           console.error('交易立即失败:', immediateStatus.value.err);
           throw new Error(`交易被网络拒绝: ${JSON.stringify(immediateStatus.value.err)}`);
         }
 
         if (!immediateStatus.value) {
           console.warn('暂未查询到签名状态（可能尚未入池），继续等待确认...');
           // 若前述使用了原始已签名交易，尝试重广播一次以提升可见性
           if (rawTx) {
             try {
               console.log('尝试重广播已签名交易以提升可见性');
               await this.connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 3 } as any);
             } catch (rebroadcastErr) {
               console.warn('重广播失败（可忽略）:', rebroadcastErr);
             }
           }
         } else {
           console.log('交易已被网络接受，等待确认...');
         }
       } catch (statusError) {
         console.warn('无法立即获取交易状态，继续确认流程。原因:', statusError);
       }
 
       // 等待确认
       try {
         const confirmPromise = this.connection.confirmTransaction({
           signature,
           blockhash: freshBlockhash,
           lastValidBlockHeight: freshLastValidBlockHeight,
         }, 'confirmed');
 
         const timeoutPromise = new Promise((_, reject) => {
           setTimeout(() => reject(new Error('Transaction confirmation timeout')), 60000);
         });
 
         await Promise.race([confirmPromise, timeoutPromise]);
       } catch (confirmError) {
         console.warn('交易确认异常，检查交易状态...', confirmError);
 
         let transactionConfirmed = false;
 
         try {
           const status = await this.connection.getSignatureStatus(signature);
           console.log('检查交易状态:', status);
 
           if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
             console.log('交易已确认，继续处理');
             transactionConfirmed = true;
           } else if (status.value?.err) {
             console.error('交易失败，错误信息:', status.value.err);
             throw new Error(`交易失败: ${JSON.stringify(status.value.err)}`);
           } else {
             console.log('交易状态未确认，当前状态:', status.value?.confirmationStatus || 'null');
           }
         } catch (statusError) {
           console.warn('无法获取交易状态，使用轮询方式重试...', statusError);
         }
 
         if (!transactionConfirmed) {
           let retryCount = 0;
           const maxRetries = 10;
 
           while (retryCount < maxRetries && !transactionConfirmed) {
             await new Promise(resolve => setTimeout(resolve, 3000));
 
             try {
               const retryStatus = await this.connection.getSignatureStatus(signature);
               console.log(`轮询重试 ${retryCount + 1}，交易状态:`, retryStatus);
 
               if (retryStatus.value?.confirmationStatus === 'confirmed' || retryStatus.value?.confirmationStatus === 'finalized') {
                 console.log('轮询确认交易成功');
                 transactionConfirmed = true;
                 break;
               } else if (retryStatus.value?.err) {
                 console.error('轮询发现交易失败:', retryStatus.value.err);
                 throw new Error(`交易失败: ${JSON.stringify(retryStatus.value.err)}`);
               } else {
                 console.log(`轮询重试 ${retryCount + 1}，交易仍未确认，状态:`, retryStatus.value?.confirmationStatus || 'null');
               }
             } catch (retryError) {
               console.warn(`轮询重试 ${retryCount + 1} 失败:`, retryError);
             }
 
             retryCount++;
           }
         }
 
         if (!transactionConfirmed) {
           console.error(`交易确认失败。Signature: ${signature}`);
 
           try {
             const finalCheck = await this.connection.getTransaction(signature, {
               commitment: 'confirmed',
               // 兼容 v0 版本交易
               maxSupportedTransactionVersion: 0,
             });
 
             if (finalCheck) {
               console.log('交易确实存在于区块链上，但确认状态异常');
               return {
                 message,
                 sender: senderPublicKey.toString(),
                 recipient,
                 timestamp: Date.now(),
                 signature,
                 blockTime: finalCheck.blockTime || undefined,
                 status: 'confirmed',
                 type,
               };
             } else {
               console.error('交易不存在于区块链上');
 
               // 已移除跨网络诊断逻辑，避免浏览器直连公共 RPC 导致 403/连接关闭
 
               // 返回挂起状态，允许前端展示“已提交，待确认”并由用户稍后在 Explorer 查看
               console.warn('交易仍未在链上可见，返回挂起状态，稍后可能确认');
               return {
                 message,
                 sender: senderPublicKey.toString(),
                 recipient,
                 timestamp: Date.now(),
                 signature,
                 blockTime: undefined,
                 status: 'pending',
                 type,
               };
             }
           } catch (finalError) {
             console.error('最终检查失败:', finalError);
             throw new Error(`交易确认超时且无法验证交易状态。Signature: ${signature}。请检查网络连接和账户余额。`);
           }
         }
       }
 
       // 走到这里表示已确认
       const transactionInfo = await this.connection.getTransaction(signature, {
         commitment: 'confirmed',
         // 兼容 v0 版本交易
         maxSupportedTransactionVersion: 0,
       });
 
       return {
         message,
         sender: senderPublicKey.toString(),
         recipient,
         timestamp: Date.now(),
         signature,
         blockTime: transactionInfo?.blockTime || undefined,
         status: 'confirmed',
         type,
       };
     } catch (error) {
       console.error('铭刻消息时出错:', error);
 
       // 如果 Program 模式失败，尝试回退到纯 Memo 模式
       let fallbackError: any = undefined;
       if (canUseProgram) {
         try {
           console.warn('Program 模式失败，回退到纯 Memo 模式重试...');
 
           // 重建仅含 Memo（及服务费转账）的交易
           const { blockhash } = await this.connection.getLatestBlockhash();
           const fallbackTx = new Transaction({
             recentBlockhash: blockhash,
             feePayer: senderPublicKey,
           });
 
           const { cuLimit, cuPriceMicroLamports } = getPriorityPreset(priority);
           fallbackTx.add(
             ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
             ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports })
           );
 
           // 重新构建 memo 内容
           let inscriptionContent = `💎 Basalt Inscription v1 💎\n`;
           inscriptionContent += `Type: ${type}\n`;
           inscriptionContent += `Message: ${message}\n`;
           inscriptionContent += `From: ${senderPublicKey.toString()}\n`;
           if (recipient) {
             inscriptionContent += `To: ${recipient}\n`;
           }
           inscriptionContent += `Timestamp: ${Date.now()}\n`;
           inscriptionContent += `Platform: Basalt (玄武岩)`;
 
           const memoInstruction = createMemoInstruction(inscriptionContent);
           fallbackTx.add(memoInstruction);
 
           // 按后端返回的服务费增加转账
           if (feeInfo.serviceFee > 0 && feeInfo.serviceFeeWallet) {
             const serviceFeeWallet = new PublicKey(feeInfo.serviceFeeWallet);
             const transferInstruction = SystemProgram.transfer({
               fromPubkey: senderPublicKey,
               toPubkey: serviceFeeWallet,
               lamports: feeInfo.serviceFee,
             });
             fallbackTx.add(transferInstruction);
           }
 
           const { blockhash: fbBlockhash, lastValidBlockHeight: fbLastValidBlockHeight } = await this.connection.getLatestBlockhash();
           fallbackTx.recentBlockhash = fbBlockhash;
 
           console.log('正在发送回退交易（Memo 模式）...');
           let signature: string;
           try {
             if (signTransaction) {
               const signedTx = await signTransaction(fallbackTx);
 
               // 回退交易发送前模拟
               try {
                 const simRes = await this.connection.simulateTransaction(signedTx, {
                   sigVerify: true,
                   commitment: 'processed' as any,
                 });
                 if (simRes.value.err) {
                   const simLogs = simRes.value.logs || [];
                   const headLogs = (simLogs || []).slice(0, 12).join('\n');
                   throw new Error(`回退交易模拟失败: ${JSON.stringify(simRes.value.err)}\n日志:\n${headLogs}`);
                 }
               } catch (simErr) {
                 console.warn('回退 simulateTransaction 异常：', simErr);
               }
 
               const fbRawTx = signedTx.serialize();
               signature = await this.connection.sendRawTransaction(fbRawTx, {
                 skipPreflight: false,
                 preflightCommitment: 'confirmed' as any,
                 maxRetries: 3,
               } as any);
             } else {
               signature = await sendTransaction(fallbackTx, this.connection);
             }
           } catch (fbDirectErr) {
             console.warn('回退直发失败，改用钱包 sendTransaction：', fbDirectErr);
             signature = await sendTransaction(fallbackTx, this.connection);
           }
 
           await this.connection.confirmTransaction({
             signature,
             blockhash: fbBlockhash,
             lastValidBlockHeight: fbLastValidBlockHeight,
           }, 'confirmed');
 
           const txInfo = await this.connection.getTransaction(signature, {
             commitment: 'confirmed',
             maxSupportedTransactionVersion: 0,
           });
 
           return {
             message,
             sender: senderPublicKey.toString(),
             recipient,
             timestamp: Date.now(),
             signature,
             blockTime: txInfo?.blockTime || undefined,
             status: 'confirmed',
             type,
           };
         } catch (fbErr) {
           fallbackError = fbErr;
           console.error('回退 Memo 模式也失败:', fbErr);
         }
       }
 
       // 提取尽可能多的上下文，帮助前端显示/诊断
       const e: any = error;
       const parts: string[] = [];
       const name = e?.name || 'Error';
       const code = e?.code;
       const msg = e?.message || '未知错误';
       const causeMsg = e?.cause?.message || e?.error?.message || e?.data?.message;
       const logs: string[] | undefined = e?.logs || e?.data?.logs;
 
       // 部分常见钱包/链上错误识别
       if (code === 4001 || /User rejected|user rejected|reject/i.test(msg)) {
         parts.push('用户拒绝了签名');
       }
       if (/Transaction simulation failed|Simulation failed/i.test(msg) && logs?.length) {
         parts.push('模拟失败日志:');
         parts.push(...logs.slice(0, 10));
       }
 
       if (fallbackError) {
         const fe: any = fallbackError;
         const feName = fe?.name || 'Error';
         const feCode = fe?.code;
         const feMsg = fe?.message || '未知错误';
         const feLogs: string[] | undefined = fe?.logs || fe?.data?.logs;
         parts.push('——');
         parts.push(`回退 Memo 模式失败: ${feName}${feCode !== undefined ? ` (code ${feCode})` : ''}: ${feMsg}`);
         if (feLogs?.length) {
           parts.push('回退失败日志:');
           parts.push(...feLogs.slice(0, 10));
         }
       }
 
       // 汇总信息
       parts.unshift(`${name}${code !== undefined ? ` (code ${code})` : ''}: ${msg}`);
       if (causeMsg && causeMsg !== msg) {
         parts.push(`原因: ${causeMsg}`);
       }
 
       const detail = parts.join('\n');
       throw new Error(`铭刻失败: ${detail}`);
     }
   }

  /**
   * 根据地址查询铭刻记录
   */
  async getInscriptionsByAddress(address: string, limit: number = 100): Promise<InscriptionData[]> {
    try {
      const publicKey = new PublicKey(address);
      const signatures = await this.connection.getSignaturesForAddress(publicKey, { limit });

      const inscriptions: InscriptionData[] = [];
      for (const signatureInfo of signatures) {
        try {
          const transaction = await this.connection.getTransaction(signatureInfo.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          if (transaction && transaction.meta && !transaction.meta.err) {
            const memoInstructions = ('version' in transaction.transaction.message
              ? transaction.transaction.message.compiledInstructions
              : (transaction.transaction.message as any).instructions
            ).filter((instruction: { programIdIndex: number; data: string }) => {
              const programId = ('version' in transaction.transaction.message
                ? transaction.transaction.message.getAccountKeys()
                : (transaction.transaction.message as any).accountKeys)[instruction.programIdIndex].toString();
              return programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
            });

            for (const instruction of memoInstructions) {
              try {
                let memoData = '';
                try {
                  memoData = Buffer.from(instruction.data, 'base64').toString('utf8');
                } catch {}
                if (!memoData || /\uFFFD/.test(memoData)) {
                  try {
                    memoData = Buffer.from(bs58.decode(instruction.data)).toString('utf8');
                  } catch {}
                }
                if (!memoData) continue;

                let isBasalt = false;
                let inscriptionType: 'love' | 'general' | 'agreement' = 'general';
                if (memoData.includes('Basalt Inscription v1')) {
                  isBasalt = true;
                  const typeMatch = memoData.match(/Type: (.+?)\n/);
                  inscriptionType = (typeMatch && typeMatch[1]) ? (typeMatch[1].toLowerCase() as any) : 'general';
                } else if (memoData.includes('Basalt Love Inscription')) {
                  isBasalt = true;
                  inscriptionType = 'love';
                }
                if (!isBasalt) continue;

                const messageMatch = memoData.match(/Message: (.+?)\n/);
                const fromMatch = memoData.match(/From: (.+?)\n/);
                const toMatch = memoData.match(/To: (.+?)\n/);
                const timestampMatch = memoData.match(/Timestamp: (\d+)\n/);

                if (messageMatch && (fromMatch || memoData.includes('Basalt Love Inscription')) && timestampMatch) {
                  inscriptions.push({
                    message: messageMatch[1],
                    sender: fromMatch ? fromMatch[1] : ('version' in transaction.transaction.message
                      ? transaction.transaction.message.getAccountKeys().get(0)?.toString()
                      : (transaction.transaction.message as any).accountKeys[0]?.toString() || ''),
                    recipient: toMatch ? toMatch[1] : undefined,
                    timestamp: parseInt(timestampMatch[1]),
                    signature: signatureInfo.signature,
                    blockTime: transaction.blockTime || undefined,
                    type: inscriptionType,
                  });
                }
              } catch (parseError) {
                console.warn('解析memo数据时出错:', parseError);
              }
            }
          }
        } catch (txError) {
          console.warn(`获取交易 ${signatureInfo.signature} 时出错:`, txError);
        }
      }

      return inscriptions.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('查询铭刻记录时出错:', error);
      return [];
    }
  }

  /**
   * 根据交易签名查询单条铭刻记录（若该交易包含 Basalt 的 Memo）
   */
  async getInscriptionBySignature(signature: string): Promise<InscriptionData | null> {
    try {
      const tx = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) return null;

      // 提取 Memo 指令
      const memoInstructions = ('version' in tx.transaction.message ?
        tx.transaction.message.compiledInstructions :
        (tx.transaction.message as any).instructions
      ).filter(
        (instruction: { programIdIndex: number; data: string }) => {
          const programId = ('version' in tx.transaction.message ?
            tx.transaction.message.getAccountKeys() :
            (tx.transaction.message as any).accountKeys)[
            instruction.programIdIndex
          ].toString();
          return programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
        }
      );

      for (const instruction of memoInstructions) {
        try {
          // 解析 memo 文本（兼容 base64 与 bs58）
          let memoData = '';
          try {
            memoData = Buffer.from(instruction.data, 'base64').toString('utf8');
          } catch {}
          if (!memoData || /\uFFFD/.test(memoData)) {
            try {
              memoData = Buffer.from(bs58.decode(instruction.data)).toString('utf8');
            } catch {}
          }
          if (!memoData) continue;

          // 识别 Basalt 格式
          let isBasalt = false;
          let inscriptionType: 'love' | 'general' | 'agreement' = 'general';
          if (memoData.includes('Basalt Inscription v1')) {
            isBasalt = true;
            const typeMatch = memoData.match(/Type: (.+?)\n/);
            inscriptionType = (typeMatch && typeMatch[1]) ? (typeMatch[1].toLowerCase() as any) : 'general';
          } else if (memoData.includes('Basalt Love Inscription')) {
            isBasalt = true;
            inscriptionType = 'love';
          }
          if (!isBasalt) continue;

          const messageMatch = memoData.match(/Message: (.+?)\n/);
          const fromMatch = memoData.match(/From: (.+?)\n/);
          const toMatch = memoData.match(/To: (.+?)\n/);
          const timestampMatch = memoData.match(/Timestamp: (\d+)\n/);

          if (messageMatch && (fromMatch || memoData.includes('Basalt Love Inscription')) && timestampMatch) {
            return {
              message: messageMatch[1],
              sender: fromMatch ? fromMatch[1] : ('version' in tx.transaction.message ?
                tx.transaction.message.getAccountKeys().get(0)?.toString() :
                (tx.transaction.message as any).accountKeys[0]?.toString() || ''),
              recipient: toMatch ? toMatch[1] : undefined,
              timestamp: parseInt(timestampMatch[1]),
              signature,
              blockTime: tx.blockTime || undefined,
              type: inscriptionType,
            };
          }
        } catch (e) {
          console.warn('解析 memo（签名查询）失败:', e);
        }
      }
      return null;
    } catch (error) {
      console.warn('根据签名查询交易失败:', error);
      return null;
    }
  }

  /**
   * 搜索铭刻记录
   */
  async searchInscriptions(query: string, addresses: string[] = [], limit: number = 100): Promise<InscriptionData[]> {
    try {
      let allInscriptions: InscriptionData[] = [];

      // 读取本地缓存（手动/按签名命中后写入的记录）
      let cached: InscriptionData[] = [];
      try {
        if (typeof window !== 'undefined') {
          const raw = localStorage.getItem('basalt_manual_cache');
          if (raw) cached = JSON.parse(raw);
        }
      } catch {}
      if (cached.length > 0) {
        allInscriptions = allInscriptions.concat(cached);
      }

      // 读取后端配置，决定是否纳入 serviceFeeWallet 聚合搜索
      const apiConfig = await this.getApiConfig().catch(() => null);

      // 构建搜索目标地址集合：传入的地址 + program 的 serviceFeeWallet + legacy 的 serviceFeeWallet + 若 query 是地址也加入
      const targetSet = new Set<string>();
      const normalize = (addr: string) => { try { return new PublicKey(addr).toString(); } catch { return null; } };

      for (const addr of addresses || []) {
        const n = addr ? normalize(addr) : null; if (n) targetSet.add(n);
      }

      // 统一收集 serviceFeeWallet 候选（program 与 legacy）
      const sfwCandidates = new Set<string>();
      const sfwProgram = apiConfig?.programConfig?.serviceFeeWallet ? normalize(apiConfig!.programConfig!.serviceFeeWallet) : null;
      if (sfwProgram) { sfwCandidates.add(sfwProgram); targetSet.add(sfwProgram); }
      const sfwLegacy = apiConfig?.serviceFeeWallet ? normalize(apiConfig!.serviceFeeWallet) : null;
      if (sfwLegacy) { sfwCandidates.add(sfwLegacy); targetSet.add(sfwLegacy); }

      // 查询词若为有效地址也加入
      const qAddr = normalize(query);
      if (qAddr) targetSet.add(qAddr);

      const targets = Array.from(targetSet);
      if (targets.length > 0) {
        for (const address of targets) {
          const isServiceFee = sfwCandidates.has(address);
          const isQueryAddr = qAddr ? (address === qAddr) : false;
          // 对 serviceFeeWallet 与 “查询地址本身” 提升扫描窗口，避免遗漏
          const perTargetLimit = (isServiceFee || isQueryAddr) ? Math.max(limit, 1000) : limit;
          const inscriptions = await this.getInscriptionsByAddress(address, perTargetLimit);
          allInscriptions = allInscriptions.concat(inscriptions);
        }
      }

      // 若 query 看起来像交易签名（或包含签名片段），尝试直接按签名解析
      let sigHit: InscriptionData | null = null;
      const base58Seg = (query.match(/[1-9A-HJ-NP-Za-km-z]{64,}/)?.[0]) || null; // 签名通常>=64字符
      if (base58Seg) {
        sigHit = await this.getInscriptionBySignature(base58Seg);
        if (sigHit) {
          allInscriptions.push(sigHit);
          // 写入本地缓存（去重）
          try {
            if (typeof window !== 'undefined') {
              const raw = localStorage.getItem('basalt_manual_cache');
              const list: InscriptionData[] = raw ? JSON.parse(raw) : [];
              const exists = list.find((i) => i.signature === sigHit!.signature);
              if (!exists) {
                list.unshift(sigHit);
                // 控制缓存长度，最多保存最近 200 条
                if (list.length > 200) list.length = 200;
                localStorage.setItem('basalt_manual_cache', JSON.stringify(list));
              }
            }
          } catch {}
        }
      }

      // 去重（按交易签名）
      const uniqueMap = new Map<string, InscriptionData>();
      for (const ins of allInscriptions) {
        if (!uniqueMap.has(ins.signature)) uniqueMap.set(ins.signature, ins);
      }
      const unique = Array.from(uniqueMap.values());

      const qLower = query.toLowerCase();
      let isQueryAddress = false;
      try { new PublicKey(query); isQueryAddress = true; } catch {}

      const filteredInscriptions = unique.filter(inscription => {
        const msgMatch = inscription.message.toLowerCase().includes(qLower);
        const senderLower = inscription.sender.toLowerCase();
        const recipientLower = inscription.recipient ? inscription.recipient.toLowerCase() : '';
        const fuzzyAddrMatch = senderLower.includes(qLower) || (!!recipientLower && recipientLower.includes(qLower));
        const exactAddrMatch = isQueryAddress && (senderLower === qLower || (!!recipientLower && recipientLower === qLower));
        const sigExact = base58Seg ? (inscription.signature === base58Seg) : false;
        return msgMatch || exactAddrMatch || fuzzyAddrMatch || sigExact;
      });

      return filteredInscriptions
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    } catch (error) {
      console.error('搜索铭刻记录时出错:', error);
      return [];
    }
  }

  /**
   * 获取账户余额 - 使用后端API
   */
  async getBalance(publicKey: PublicKey): Promise<number> {
    try {
      const response = await fetchFromBases(`/api/account/balance/${publicKey.toString()}`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || '获取余额失败');
      }

      return data.data.balanceSOL;
    } catch (error) {
      console.error('获取余额时出错:', error);
      // 降级到直接使用连接
      try {
        const balance = await this.connection.getBalance(publicKey);
        return balance / LAMPORTS_PER_SOL;
      } catch (fallbackError) {
        console.error('降级获取余额也失败:', fallbackError);
        return 0;
      }
    }
  }

  /**
   * 检查网络连接
   */
  async checkConnection(): Promise<boolean> {
    try {
      await this.connection.getLatestBlockhash();
      return true;
    } catch (error) {
      console.error('网络连接检查失败:', error);
      return false;
    }
  }
}

// 导出服务类
// 移除了此处的默认导出，避免重复导出冲突
// export default SolanaService;

// 简单的后端 API 基址获取与回退（优先使用环境变量），其次尝试 3001 和 3002
function getApiBases(): string[] {
  try {
    // @ts-ignore
    const env = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
    const base = env?.VITE_API_BASE as string | undefined;
    if (base && typeof base === 'string') {
      return [base.replace(/\/$/, '')];
    }
  } catch (_) {}
  return ['http://localhost:3001', 'http://localhost:3002'];
}

async function fetchFromBases(path: string, init?: RequestInit): Promise<Response> {
  const bases = getApiBases();
  let lastErr: any = null;
  for (const base of bases) {
    try {
      const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
      const res = await fetch(url, init);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All API base URLs failed');
}

export default SolanaService;

// 统一的优先费档位配置（Devnet 保证非 0 的优先费，从而为后续 Program 抽成提供稳定基准）
function getPriorityPreset(preset: 'low' | 'medium' | 'high' = 'medium') {
  switch (preset) {
    case 'low':
      return { cuLimit: 120_000, cuPriceMicroLamports: 20_000 } as const;
    case 'high':
      return { cuLimit: 300_000, cuPriceMicroLamports: 100_000 } as const;
    case 'medium':
    default:
      return { cuLimit: 200_000, cuPriceMicroLamports: 50_000 } as const;
  }
}

// 工具函数：Anchor 指令 discriminator

async function sha256Bytes(text: string): Promise<Buffer> {
  try {
    if (typeof crypto !== 'undefined' && (crypto as any).subtle && typeof TextEncoder !== 'undefined') {
      const enc = new TextEncoder();
      const digest = await (crypto as any).subtle.digest('SHA-256', enc.encode(text));
      // @ts-ignore - Buffer polyfilled in main.tsx
      return Buffer.from(new Uint8Array(digest));
    }
  } catch (e) {
    console.warn('SubtleCrypto digest 失败，将尝试回退。原因:', e);
  }
  throw new Error('环境缺少 WebCrypto SubtleCrypto 或 Buffer。请在现代浏览器中运行本应用，或为项目添加 js-sha256 等轻量依赖。');
}
 function u32LE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function u64LE(n: number): Buffer {
  const b = Buffer.alloc(8);
  const bn = BigInt(n);
  b.writeBigUInt64LE(bn);
  return b;
}

function deriveConfigPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  return pda;
}
