/**
 * ============================================================================
 * TESTE DO SEQUENCER FEED - VER TRANSAÇÕES PENDENTES EM TEMPO REAL
 * ============================================================================
 *
 * Executa: npx ts-node bot/testSequencer.ts
 */

import { SequencerFeed } from './sequencerFeed';
import { ethers } from 'ethers';

// Estatísticas
let txCount = 0;
let swapCount = 0;
let startTime = Date.now();

// Selectors conhecidos de swaps
const SWAP_SELECTORS: Record<string, string> = {
    // Uniswap V3
    '0x414bf389': 'exactInputSingle',
    '0xc04b8d59': 'exactInput',
    '0xdb3e2198': 'exactOutputSingle',
    '0xf28c0498': 'exactOutput',
    '0x5ae401dc': 'multicall (V3)',
    '0xac9650d8': 'multicall (V3)',

    // Uniswap V2 / SushiSwap
    '0x38ed1739': 'swapExactTokensForTokens',
    '0x7ff36ab5': 'swapExactETHForTokens',
    '0x18cbafe5': 'swapExactTokensForETH',
    '0xfb3bdb41': 'swapETHForExactTokens',
    '0x8803dbee': 'swapTokensForExactTokens',
    '0x4a25d94a': 'swapTokensForExactETH',

    // Camelot
    '0x5c11d795': 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
    '0xb6f9de95': 'swapExactETHForTokensSupportingFeeOnTransferTokens',

    // Balancer
    '0x52bbbe29': 'swap (Balancer)',
    '0x945bcec9': 'batchSwap (Balancer)',

    // 1inch / Aggregators
    '0x12aa3caf': 'swap (1inch)',
    '0xe449022e': 'uniswapV3Swap (1inch)',
    '0x0502b1c5': 'unoswap (1inch)',
};

// DEX Routers conhecidos
const DEX_NAMES: Record<string, string> = {
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 Router 2',
    '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506': 'SushiSwap Router',
    '0xc873fecbd354f5a56e00e710b90ef4201db2448d': 'Camelot Router',
    '0xba12222222228d8ba445958a75a0704d566bf2c8': 'Balancer Vault',
    '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch Router',
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap',
    '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'Paraswap',
};

async function main() {
    console.log('============================================================');
    console.log('🔥 ARBITRUM SEQUENCER FEED - MONITORAMENTO EM TEMPO REAL');
    console.log('============================================================');
    console.log('');
    console.log('Conectando ao sequencer para ver transações ANTES dos blocos...');
    console.log('');

    const feed = new SequencerFeed();

    // Callback para cada transação
    feed.onTransaction((tx) => {
        txCount++;

        const selector = tx.data.slice(0, 10).toLowerCase();
        const swapType = SWAP_SELECTORS[selector];
        const dexName = tx.to ? DEX_NAMES[tx.to.toLowerCase()] : null;

        // Se for um swap em DEX conhecido
        if (swapType || dexName) {
            swapCount++;

            const value = parseFloat(ethers.formatEther(tx.value)).toFixed(4);
            const gasPrice = parseFloat(ethers.formatUnits(tx.gasPrice, 'gwei')).toFixed(3);
            const timeSinceStart = ((Date.now() - startTime) / 1000).toFixed(1);

            console.log('');
            console.log(`🎯 [${timeSinceStart}s] SWAP #${swapCount} DETECTADO!`);
            console.log(`   ├─ DEX: ${dexName || 'Desconhecido'}`);
            console.log(`   ├─ Tipo: ${swapType || selector}`);
            console.log(`   ├─ From: ${tx.from.slice(0, 10)}...${tx.from.slice(-8)}`);
            console.log(`   ├─ Value: ${value} ETH`);
            console.log(`   ├─ Gas: ${gasPrice} Gwei`);
            console.log(`   └─ Hash: ${tx.hash.slice(0, 20)}...`);

            // Calcular potencial de arbitragem
            if (parseFloat(value) > 0.1) {
                console.log(`   ⚡ ALTO VALOR - Potencial para backrun!`);
            }
        }

        // Mostrar estatísticas a cada 100 transações
        if (txCount % 100 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = (txCount / elapsed).toFixed(1);
            console.log('');
            console.log(`📊 Stats: ${txCount} tx total | ${swapCount} swaps | ${rate} tx/s`);
        }
    });

    try {
        await feed.connect();

        console.log('');
        console.log('✅ Conectado! Monitorando transações pendentes...');
        console.log('   Pressione Ctrl+C para parar');
        console.log('');
        console.log('============================================================');

        // Manter rodando
        process.on('SIGINT', () => {
            console.log('');
            console.log('============================================================');
            console.log('📊 ESTATÍSTICAS FINAIS');
            console.log('============================================================');
            console.log(`Total de transações: ${txCount}`);
            console.log(`Swaps detectados: ${swapCount}`);
            console.log(`Tempo de execução: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
            console.log('============================================================');

            feed.disconnect();
            process.exit(0);
        });

    } catch (error) {
        console.error('❌ Erro ao conectar:', error);
        process.exit(1);
    }
}

main();
