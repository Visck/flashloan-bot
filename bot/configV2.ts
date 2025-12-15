/**
 * ============================================================================
 * CONFIGURAÇÃO V2 - BOT DE ARBITRAGEM AVANÇADO
 * ============================================================================
 *
 * Versão 2.1 com suporte a:
 * - 6 DEXs: Uniswap V3, SushiSwap, Camelot, Balancer, Curve 2pool, Curve Tricrypto
 * - Mais tokens
 * - Arbitragem triangular
 * - Múltiplos RPCs
 * - WebSocket
 */

import { config } from 'dotenv';
config();

// ============================================================================
// MÚLTIPLOS RPCs - REDUNDÂNCIA E VELOCIDADE
// ============================================================================

export const RPC_ENDPOINTS = {
    // Principal - Alchemy (mais rápido e confiável)
    primary: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',

    // Backups
    backups: [
        'https://arb1.arbitrum.io/rpc',            // Arbitrum público
        'https://arbitrum.llamarpc.com',           // LlamaRPC
        'https://rpc.ankr.com/arbitrum',           // Ankr
        'https://arbitrum.drpc.org',               // dRPC
    ],

    // WebSocket para tempo real - Alchemy
    websocket: process.env.ARBITRUM_WSS_URL || '',
};

// ============================================================================
// DEXs SUPORTADAS
// ============================================================================

export enum DEX {
    UNISWAP_V3 = 0,
    SUSHISWAP = 1,
    CAMELOT = 2,
    BALANCER = 3,
    CURVE_2POOL = 4,
    CURVE_TRICRYPTO = 5,
}

export const DEX_INFO = {
    [DEX.UNISWAP_V3]: {
        name: 'Uniswap V3',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        fees: [100, 500, 3000, 10000], // 0.01%, 0.05%, 0.3%, 1%
    },
    [DEX.SUSHISWAP]: {
        name: 'SushiSwap',
        router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
        factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
        fee: 3000, // 0.3% fixo
    },
    [DEX.CAMELOT]: {
        name: 'Camelot',
        router: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
        factory: '0x6EcCab422D763aC031210895C81787E87B43A652',
        fee: 3000, // Variável por par
    },
    [DEX.BALANCER]: {
        name: 'Balancer V2',
        vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        // Pool IDs conhecidos no Arbitrum
        pools: {
            'WETH/USDC': '0x64541216bafffeec8ea535bb71fbc927831d0595000100000000000000000002',
            'WETH/USDC_NATIVE': '0x0c8972437a38b389ec83d1e666b69b8a4fcf8bfd00000000000000000000049e',
            'ARB/WETH': '0xcc65a812ce382ab909a11e434dbf75b34f1cc59d000200000000000000000001',
        },
        fee: 500, // ~0.05% típico
    },
    [DEX.CURVE_2POOL]: {
        name: 'Curve 2pool',
        pool: '0x7f90122BF0700F9E7e1F688fe926940E8839F353', // USDC/USDT
        tokens: ['USDC', 'USDT'],
        fee: 40, // 0.04%
    },
    [DEX.CURVE_TRICRYPTO]: {
        name: 'Curve Tricrypto',
        pool: '0x960ea3e3C7FB317332d990873d354E18d7645590', // USDT/WBTC/WETH
        tokens: ['USDT', 'WBTC', 'WETH'],
        fee: 40, // 0.04%
    },
};

// ============================================================================
// TOKENS EXPANDIDOS - ARBITRUM MAINNET
// ============================================================================

export interface TokenInfo {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    isStable?: boolean;
}

export const TOKENS: Record<string, TokenInfo> = {
    // === PRINCIPAIS ===
    WETH: {
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        symbol: 'WETH',
        name: 'Wrapped Ether',
        decimals: 18,
    },
    USDC_E: {
        address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        symbol: 'USDC.e',
        name: 'USD Coin (Bridged)',
        decimals: 6,
        isStable: true,
    },
    USDC: {
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        symbol: 'USDC',
        name: 'USD Coin (Native)',
        decimals: 6,
        isStable: true,
    },
    USDT: {
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6,
        isStable: true,
    },
    DAI: {
        address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
        symbol: 'DAI',
        name: 'Dai Stablecoin',
        decimals: 18,
        isStable: true,
    },
    ARB: {
        address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        symbol: 'ARB',
        name: 'Arbitrum',
        decimals: 18,
    },
    WBTC: {
        address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
        symbol: 'WBTC',
        name: 'Wrapped Bitcoin',
        decimals: 8,
    },

    // === TOKENS POPULARES ARBITRUM ===
    GMX: {
        address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
        symbol: 'GMX',
        name: 'GMX',
        decimals: 18,
    },
    MAGIC: {
        address: '0x539bdE0d7Dbd336b79148AA742883198BBF60342',
        symbol: 'MAGIC',
        name: 'MAGIC',
        decimals: 18,
    },
    RDNT: {
        address: '0x3082CC23568eA640225c2467653dB90e9250AaA0',
        symbol: 'RDNT',
        name: 'Radiant',
        decimals: 18,
    },
    PENDLE: {
        address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
        symbol: 'PENDLE',
        name: 'Pendle',
        decimals: 18,
    },
    GRAIL: {
        address: '0x3d9907F9a368ad0a51Be60f7Da3b97cf940982D8',
        symbol: 'GRAIL',
        name: 'Camelot Token',
        decimals: 18,
    },
    LINK: {
        address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
        symbol: 'LINK',
        name: 'Chainlink Token',
        decimals: 18,
    },
    UNI: {
        address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0',
        symbol: 'UNI',
        name: 'Uniswap',
        decimals: 18,
    },

    // === LIQUID STAKING ===
    WSTETH: {
        address: '0x5979D7b546E38E414F7E9822514be443A4800529',
        symbol: 'wstETH',
        name: 'Wrapped stETH',
        decimals: 18,
    },
    RETH: {
        address: '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8',
        symbol: 'rETH',
        name: 'Rocket Pool ETH',
        decimals: 18,
    },

    // === STABLECOINS EXTRAS ===
    FRAX: {
        address: '0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F',
        symbol: 'FRAX',
        name: 'Frax',
        decimals: 18,
        isStable: true,
    },
    MIM: {
        address: '0xFEa7a6a0B346362BF88A9e4A88416B77a57D6c2A',
        symbol: 'MIM',
        name: 'Magic Internet Money',
        decimals: 18,
        isStable: true,
    },
    LUSD: {
        address: '0x93b346b6BC2548dA6A1E7d98E9a421B42541425b',
        symbol: 'LUSD',
        name: 'Liquity USD',
        decimals: 18,
        isStable: true,
    },
};

// ============================================================================
// PARES DE ARBITRAGEM EXPANDIDOS
// ============================================================================

export interface ArbitragePair {
    tokenA: TokenInfo;
    tokenB: TokenInfo;
    dexes: DEX[];           // DEXs para verificar
    uniswapFees: number[];  // Fees a testar no Uniswap
    minProfitBps: number;
    maxAmountUsd: number;
    priority: number;       // 1 = alta, 2 = média, 3 = baixa
}

export const ARBITRAGE_PAIRS: ArbitragePair[] = [
    // === PARES ESSENCIAIS (Alchemy free tier) ===
    // Apenas WETH/USDC - par mais líquido e com mais oportunidades
    {
        tokenA: TOKENS.USDC,
        tokenB: TOKENS.WETH,
        dexes: [DEX.UNISWAP_V3],  // Apenas Uniswap V3 para reduzir chamadas
        uniswapFees: [500],        // Apenas fee de 0.05%
        minProfitBps: 10,
        maxAmountUsd: 100000,
        priority: 1,
    },
    // WETH/ARB - segundo par mais importante
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.ARB,
        dexes: [DEX.UNISWAP_V3],
        uniswapFees: [3000],
        minProfitBps: 15,
        maxAmountUsd: 50000,
        priority: 1,
    },
    // Stablecoin USDC/USDT - baixo risco
    {
        tokenA: TOKENS.USDC,
        tokenB: TOKENS.USDT,
        dexes: [DEX.UNISWAP_V3],
        uniswapFees: [100],
        minProfitBps: 5,
        maxAmountUsd: 200000,
        priority: 1,
    },
];

// ============================================================================
// ROTAS TRIANGULARES
// ============================================================================

export interface TriangularRoute {
    tokenBorrow: TokenInfo;
    tokenMiddle: TokenInfo;
    tokenTarget: TokenInfo;
    name: string;
    priority: number;
}

// Triangular routes desabilitadas para reduzir rate limit no Alchemy free tier
export const TRIANGULAR_ROUTES: TriangularRoute[] = [
    // Desabilitado para economizar compute units
    // {
    //     tokenBorrow: TOKENS.USDC,
    //     tokenMiddle: TOKENS.WETH,
    //     tokenTarget: TOKENS.ARB,
    //     name: 'USDC->WETH->ARB',
    //     priority: 1,
    // },
];

// ============================================================================
// CONFIGURAÇÕES DO BOT V2
// ============================================================================

export const BOT_CONFIG_V2 = {
    // Lucro
    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || '0.5'),
    minProfitPercentage: parseFloat(process.env.MIN_PROFIT_PERCENTAGE || '0.1'),

    // Limites
    maxFlashLoanUsd: parseFloat(process.env.MAX_FLASH_LOAN_USD || '100000'),
    maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '50'),
    maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '5'),

    // Rate limiting (evita throttling do RPC - Alchemy free tier)
    maxParallelQuotes: 1,  // Cotações sequenciais para evitar rate limit
    quoteDelayMs: 500,     // 500ms delay entre cotações

    // Monitoramento
    monitoringIntervalMs: parseInt(process.env.MONITORING_INTERVAL_MS || '500'),
    useWebSocket: process.env.USE_WEBSOCKET === 'true',

    // Execução
    simulationMode: process.env.SIMULATION_MODE !== 'false',
    enableTriangular: process.env.ENABLE_TRIANGULAR !== 'false',
    maxConcurrentChecks: parseInt(process.env.MAX_CONCURRENT_CHECKS || '5'),

    // RPCs
    rpcRetryAttempts: 3,
    rpcTimeoutMs: 5000,

    // Proteção MEV
    useFlashbots: process.env.USE_FLASHBOTS === 'true',
    flashbotsRpc: 'https://rpc.flashbots.net',
};

// ============================================================================
// ABIs
// ============================================================================

export const CAMELOT_ROUTER_ABI = [
    'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline) external',
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline) external returns (uint256[] amounts)',
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
    'function factory() view returns (address)',
];

export const CAMELOT_PAIR_ABI = [
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint16 token0FeePercent, uint16 token1FeePercent)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];

// Re-exporta ABIs existentes
export {
    ERC20_ABI,
    UNISWAP_QUOTER_ABI,
    SUSHISWAP_ROUTER_ABI,
} from './config';
