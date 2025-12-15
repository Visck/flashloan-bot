/**
 * ============================================================================
 * CONFIGURAÇÃO V3 - BOT DE ARBITRAGEM OTIMIZADO
 * ============================================================================
 *
 * Melhorias sobre V2:
 * - 15+ pares de arbitragem (vs 2 anteriores)
 * - Intervalo de 200ms (vs 3000ms)
 * - Rotas triangulares ativas
 * - Configurações otimizadas para competitividade
 */

import { config } from 'dotenv';
config();

// ============================================================================
// MÚLTIPLOS RPCs
// ============================================================================

export const RPC_ENDPOINTS = {
    // Principal - Use RPC pago para latência baixa
    primary: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',

    // Backups
    backups: [
        'https://arb1.arbitrum.io/rpc',
        'https://rpc.ankr.com/arbitrum',
        'https://arbitrum-one-rpc.publicnode.com',
        'https://1rpc.io/arb',
    ],

    // WebSocket para eventos em tempo real
    websocket: process.env.ARBITRUM_WSS_URL || '',
};

// ============================================================================
// DEXs
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
        fees: [100, 500, 3000, 10000],
    },
    [DEX.SUSHISWAP]: {
        name: 'SushiSwap',
        router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
        factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
        fee: 3000,
    },
    [DEX.CAMELOT]: {
        name: 'Camelot',
        router: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
        factory: '0x6EcCab422D763aC031210895C81787E87B43A652',
        fee: 3000,
    },
    [DEX.BALANCER]: {
        name: 'Balancer V2',
        vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        fee: 500,
    },
    [DEX.CURVE_2POOL]: {
        name: 'Curve 2pool',
        pool: '0x7f90122BF0700F9E7e1F688fe926940E8839F353',
        tokens: ['USDC', 'USDT'],
        fee: 40,
    },
    [DEX.CURVE_TRICRYPTO]: {
        name: 'Curve Tricrypto',
        pool: '0x960ea3e3C7FB317332d990873d354E18d7645590',
        tokens: ['USDT', 'WBTC', 'WETH'],
        fee: 40,
    },
};

// ============================================================================
// TOKENS - ARBITRUM MAINNET
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
    LUSD: {
        address: '0x93b346b6BC2548dA6A1E7d98E9a421B42541425b',
        symbol: 'LUSD',
        name: 'Liquity USD',
        decimals: 18,
        isStable: true,
    },
};

// ============================================================================
// PARES DE ARBITRAGEM - EXPANDIDO
// ============================================================================

export interface ArbitragePair {
    tokenA: TokenInfo;
    tokenB: TokenInfo;
    dexes: DEX[];
    uniswapFees: number[];
    minProfitBps: number;
    maxAmountUsd: number;
    priority: number; // 1 = alta, 2 = média, 3 = baixa
}

export const ARBITRAGE_PAIRS: ArbitragePair[] = [
    // ============================================
    // PRIORIDADE 1 - Pares mais líquidos
    // ============================================

    // WETH/USDC - Par mais líquido
    {
        tokenA: TOKENS.USDC,
        tokenB: TOKENS.WETH,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP, DEX.CAMELOT],
        uniswapFees: [500, 3000],
        minProfitBps: 10,
        maxAmountUsd: 100000,
        priority: 1,
    },

    // WETH/USDC.e (bridged)
    {
        tokenA: TOKENS.USDC_E,
        tokenB: TOKENS.WETH,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP, DEX.CAMELOT],
        uniswapFees: [500, 3000],
        minProfitBps: 10,
        maxAmountUsd: 100000,
        priority: 1,
    },

    // WETH/USDT
    {
        tokenA: TOKENS.USDT,
        tokenB: TOKENS.WETH,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP, DEX.CAMELOT],
        uniswapFees: [500, 3000],
        minProfitBps: 10,
        maxAmountUsd: 100000,
        priority: 1,
    },

    // WBTC/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.WBTC,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP, DEX.BALANCER],
        uniswapFees: [500, 3000],
        minProfitBps: 10,
        maxAmountUsd: 150000,
        priority: 1,
    },

    // ============================================
    // PRIORIDADE 2 - Tokens nativos Arbitrum
    // ============================================

    // ARB/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.ARB,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP, DEX.CAMELOT],
        uniswapFees: [500, 3000],
        minProfitBps: 15,
        maxAmountUsd: 50000,
        priority: 2,
    },

    // ARB/USDC
    {
        tokenA: TOKENS.USDC,
        tokenB: TOKENS.ARB,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP, DEX.CAMELOT],
        uniswapFees: [3000],
        minProfitBps: 15,
        maxAmountUsd: 50000,
        priority: 2,
    },

    // GMX/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.GMX,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP, DEX.CAMELOT],
        uniswapFees: [3000, 10000],
        minProfitBps: 20,
        maxAmountUsd: 30000,
        priority: 2,
    },

    // MAGIC/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.MAGIC,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP, DEX.CAMELOT],
        uniswapFees: [3000, 10000],
        minProfitBps: 25,
        maxAmountUsd: 20000,
        priority: 2,
    },

    // GRAIL/WETH (token nativo Camelot)
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.GRAIL,
        dexes: [DEX.UNISWAP_V3, DEX.CAMELOT],
        uniswapFees: [10000],
        minProfitBps: 30,
        maxAmountUsd: 15000,
        priority: 2,
    },

    // ============================================
    // PRIORIDADE 3 - Stablecoins (menor spread)
    // ============================================

    // USDC/USDT
    {
        tokenA: TOKENS.USDC,
        tokenB: TOKENS.USDT,
        dexes: [DEX.UNISWAP_V3, DEX.CURVE_2POOL],
        uniswapFees: [100],
        minProfitBps: 3,
        maxAmountUsd: 200000,
        priority: 3,
    },

    // USDC.e/USDT
    {
        tokenA: TOKENS.USDC_E,
        tokenB: TOKENS.USDT,
        dexes: [DEX.UNISWAP_V3, DEX.CURVE_2POOL],
        uniswapFees: [100],
        minProfitBps: 3,
        maxAmountUsd: 200000,
        priority: 3,
    },

    // USDC/DAI
    {
        tokenA: TOKENS.USDC,
        tokenB: TOKENS.DAI,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP],
        uniswapFees: [100, 500],
        minProfitBps: 3,
        maxAmountUsd: 150000,
        priority: 3,
    },

    // ============================================
    // PRIORIDADE 2 - Liquid Staking (LST)
    // ============================================

    // wstETH/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.WSTETH,
        dexes: [DEX.UNISWAP_V3, DEX.BALANCER],
        uniswapFees: [100, 500],
        minProfitBps: 5,
        maxAmountUsd: 100000,
        priority: 2,
    },

    // rETH/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.RETH,
        dexes: [DEX.UNISWAP_V3, DEX.BALANCER],
        uniswapFees: [500],
        minProfitBps: 5,
        maxAmountUsd: 80000,
        priority: 2,
    },

    // ============================================
    // PRIORIDADE 3 - DeFi tokens
    // ============================================

    // LINK/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.LINK,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP],
        uniswapFees: [3000],
        minProfitBps: 15,
        maxAmountUsd: 40000,
        priority: 3,
    },

    // UNI/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.UNI,
        dexes: [DEX.UNISWAP_V3, DEX.SUSHISWAP],
        uniswapFees: [3000],
        minProfitBps: 15,
        maxAmountUsd: 30000,
        priority: 3,
    },

    // PENDLE/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.PENDLE,
        dexes: [DEX.UNISWAP_V3, DEX.CAMELOT],
        uniswapFees: [3000, 10000],
        minProfitBps: 20,
        maxAmountUsd: 25000,
        priority: 3,
    },

    // RDNT/WETH
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.RDNT,
        dexes: [DEX.UNISWAP_V3, DEX.CAMELOT],
        uniswapFees: [3000, 10000],
        minProfitBps: 25,
        maxAmountUsd: 15000,
        priority: 3,
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

export const TRIANGULAR_ROUTES: TriangularRoute[] = [
    // USDC -> WETH -> ARB -> USDC
    {
        tokenBorrow: TOKENS.USDC,
        tokenMiddle: TOKENS.WETH,
        tokenTarget: TOKENS.ARB,
        name: 'USDC->WETH->ARB',
        priority: 1,
    },
    // USDT -> WETH -> GMX -> USDT
    {
        tokenBorrow: TOKENS.USDT,
        tokenMiddle: TOKENS.WETH,
        tokenTarget: TOKENS.GMX,
        name: 'USDT->WETH->GMX',
        priority: 2,
    },
    // USDC -> WETH -> MAGIC -> USDC
    {
        tokenBorrow: TOKENS.USDC,
        tokenMiddle: TOKENS.WETH,
        tokenTarget: TOKENS.MAGIC,
        name: 'USDC->WETH->MAGIC',
        priority: 2,
    },
    // USDC -> WBTC -> WETH -> USDC
    {
        tokenBorrow: TOKENS.USDC,
        tokenMiddle: TOKENS.WBTC,
        tokenTarget: TOKENS.WETH,
        name: 'USDC->WBTC->WETH',
        priority: 1,
    },
    // WETH -> wstETH -> USDC -> WETH
    {
        tokenBorrow: TOKENS.WETH,
        tokenMiddle: TOKENS.WSTETH,
        tokenTarget: TOKENS.USDC,
        name: 'WETH->wstETH->USDC',
        priority: 2,
    },
];

// ============================================================================
// CONFIGURAÇÕES DO BOT V3
// ============================================================================

export const BOT_CONFIG_V3 = {
    // === LUCRO ===
    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || '1.0'),
    minProfitPercentage: parseFloat(process.env.MIN_PROFIT_PERCENTAGE || '0.1'),

    // === LIMITES ===
    maxFlashLoanUsd: parseFloat(process.env.MAX_FLASH_LOAN_USD || '100000'),
    maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '50'),
    maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '5'),

    // === MONITORAMENTO (OTIMIZADO) ===
    monitoringIntervalMs: parseInt(process.env.MONITORING_INTERVAL_MS || '200'), // 200ms!
    useWebSocket: process.env.USE_WEBSOCKET === 'true',
    useSequencerFeed: true, // NOVO: Ativa Sequencer Feed

    // === MULTICALL ===
    useMulticall: true,
    maxCallsPerBatch: 20,

    // === EXECUÇÃO ===
    simulationMode: process.env.SIMULATION_MODE !== 'false',
    enableTriangular: true, // ATIVADO
    maxConcurrentChecks: 5, // Mais pares por ciclo

    // === RPCs ===
    rpcRetryAttempts: 3,
    rpcTimeoutMs: 5000,
    rotateRpcOnError: true,

    // === PROTEÇÃO MEV ===
    useFlashbotsProtect: false, // Ativar quando tiver RPC privado
    dynamicSlippage: true,
    maxSlippageForSize: {
        small: 100,  // <$10k: 1% slippage
        medium: 50,  // $10k-$50k: 0.5%
        large: 25,   // >$50k: 0.25%
    },
};

// ============================================================================
// EXPORTS
// ============================================================================

export {
    ERC20_ABI,
    UNISWAP_QUOTER_ABI,
    SUSHISWAP_ROUTER_ABI,
    FLASH_LOAN_ARBITRAGE_ABI,
} from './config';

export const CAMELOT_ROUTER_ABI = [
    'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline) external',
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, address referrer, uint256 deadline) external returns (uint256[] amounts)',
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
];
