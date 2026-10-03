const { Connection } = require('@solana/web3.js');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fetch = require('node-fetch');
const endpoint = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const agent = proxy ? new HttpsProxyAgent(proxy, { keepAlive: true, maxSockets: 4 }) : undefined;
function rpcFetch(url, init = {}) { return fetch(url, { ...init, agent, timeout: 20000 }); }
function createConnection() { return new Connection(endpoint, { commitment: 'confirmed', fetch: rpcFetch }); }
async function confirm(connection, signature, lastValidBlockHeight) {
  for (let n = 0; n < 40; n++) {
    const status = (await connection.getSignatureStatus(signature, { searchTransactionHistory: true })).value;
    if (status?.err) throw new Error(`Transaction failed ${signature}: ${JSON.stringify(status.err)}`);
    if (['confirmed', 'finalized'].includes(status?.confirmationStatus)) return;
    if (await connection.getBlockHeight('confirmed') > lastValidBlockHeight) throw new Error(`Transaction expired: ${signature}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Confirmation pending, check signature before retry: ${signature}`);
}
module.exports = { endpoint, rpcFetch, createConnection, confirm };
