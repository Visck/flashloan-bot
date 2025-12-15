/**
 * ============================================================================
 * CONFIGURAÇÃO DO BOT DE ARBITRAGEM - ARBITRUM
 * ============================================================================
 *
 * Este arquivo contém todas as constantes e configurações necessárias
 * para o funcionamento do bot de arbitragem.
 *
 * ESTRUTURA:
 * - Endereços de contratos na Arbitrum
 * - Informações de tokens
 * - Parâmetros do bot
 * - ABIs dos contratos
 */

import { config } from 'dotenv';

// Carrega variáveis de ambiente do arquivo .env
config();

// ============================================================================
// CONFIGURAÇÃO DE REDE
// ============================================================================

/**
 * Configurações de RPC para conexão com a Arbitrum
 *
 * NOTA: Use um provedor confiável como Alchemy, Infura ou QuickNode
 * RPCs públicos podem ter rate limits e latência alta
 */
export const NETWORK_CONFIG = {
    // RPC HTTP para chamadas normais
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',

    // WebSocket para monitoramento em tempo real
    wssUrl: process.env.ARBITRUM_WSS_URL || '',

    // Chain ID da Arbitrum One
    chainId: 42161,

    // Nome da rede
    name: 'Arbitrum One',

    // Explorer
    explorer: 'https://arbiscan.io',
};

// ============================================================================
// ENDEREÇOS DE CONTRATOS - ARBITRUM MAINNET
// ============================================================================

/**
 * Endereços dos contratos principais na Arbitrum
 *
 * FONTES OFICIAIS:
 * - Aave V3: https://docs.aave.com/developers/deployed-contracts/v3-mainnet/arbitrum
 * - Uniswap V3: https://docs.uniswap.org/contracts/v3/reference/deployments
 * - SushiSwap: https://docs.sushi.com/docs/Developers/Deployment%20Addresses
 */
export const CONTRACTS = {
    // ========== AAVE V3 ==========
    aave: {
        // Pool principal - usado para flash loans
        pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        // Provedor de endereços
        addressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
        // Oracle de preços
        priceOracle: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7',
    },

    // ========== UNISWAP V3 ==========
    uniswap: {
        // Router para swaps
        swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        // Quoter para simulações de preço
        quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
        // Factory para encontrar pools
        factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    },

    // ========== SUSHISWAP ==========
    sushiswap: {
        // Router (estilo Uniswap V2)
        router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
        // Factory
        factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    },

    // ========== SEU CONTRATO ==========
    // Endereço do FlashLoanArbitrage após deploy
    flashLoanArbitrage: process.env.FLASH_LOAN_CONTRACT_ADDRESS || '',
};

// ============================================================================
// TOKENS - ARBITRUM MAINNET
// ============================================================================

/**
 * Interface para informações de token
 */
export interface TokenInfo {
    address: string;      // Endereço do contrato
    symbol: string;       // Símbolo (ex: WETH)
    name: string;         // Nome completo
    decimals: number;     // Casas decimais
}

/**
 * Tokens principais na Arbitrum
 *
 * IMPORTANTE: Diferentes tokens têm diferentes decimais!
 * - ETH/WETH: 18 decimais
 * - USDC/USDT: 6 decimais
 * - WBTC: 8 decimais
 *
 * Sempre considere os decimais ao calcular valores!
 */
export const TOKENS: Record<string, TokenInfo> = {
    // Wrapped Ether - versão ERC20 do ETH
    WETH: {
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        symbol: 'WETH',
        name: 'Wrapped Ether',
        decimals: 18,
    },

    // USD Coin (bridged) - versão mais antiga/líquida
    USDC_E: {
        address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        symbol: 'USDC.e',
        name: 'USD Coin (Bridged)',
        decimals: 6,
    },

    // USD Coin (native) - versão nativa mais recente
    USDC: {
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        symbol: 'USDC',
        name: 'USD Coin (Native)',
        decimals: 6,
    },

    // Tether USD
    USDT: {
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6,
    },

    // Arbitrum Token
    ARB: {
        address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        symbol: 'ARB',
        name: 'Arbitrum',
        decimals: 18,
    },

    // Wrapped Bitcoin
    WBTC: {
        address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
        symbol: 'WBTC',
        name: 'Wrapped Bitcoin',
        decimals: 8,
    },

    // DAI Stablecoin
    DAI: {
        address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
        symbol: 'DAI',
        name: 'Dai Stablecoin',
        decimals: 18,
    },

    // GMX Token
    GMX: {
        address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
        symbol: 'GMX',
        name: 'GMX',
        decimals: 18,
    },

    // LINK Token
    LINK: {
        address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
        symbol: 'LINK',
        name: 'Chainlink Token',
        decimals: 18,
    },
};

// ============================================================================
// PARES DE ARBITRAGEM
// ============================================================================

/**
 * Interface para definir um par de arbitragem
 */
export interface ArbitragePair {
    tokenA: TokenInfo;          // Token base (geralmente o emprestado)
    tokenB: TokenInfo;          // Token alvo (comprar/vender)
    uniswapFee: number;         // Taxa do pool Uniswap (500, 3000, 10000)
    minProfitBps: number;       // Lucro mínimo em basis points
    maxAmountUsd: number;       // Valor máximo em USD para tentar
}

/**
 * Pares de arbitragem pré-configurados
 *
 * FEES DO UNISWAP V3:
 * - 100 = 0.01% (pares muito estáveis, ex: USDC/USDT)
 * - 500 = 0.05% (pares estáveis, ex: WETH/USDC)
 * - 3000 = 0.3% (pares padrão)
 * - 10000 = 1% (pares voláteis/exóticos)
 *
 * ESTRATÉGIA:
 * - Pares com stablecoins são mais seguros
 * - Pares voláteis têm mais oportunidades mas mais risco
 * - Comece com valores pequenos para testar
 */
export const ARBITRAGE_PAIRS: ArbitragePair[] = [
    {
        tokenA: TOKENS.USDC_E,
        tokenB: TOKENS.WETH,
        uniswapFee: 500,      // Pool de 0.05%
        minProfitBps: 10,     // Mínimo 0.1% de lucro
        maxAmountUsd: 50000,  // Máximo $50k por operação
    },
    {
        tokenA: TOKENS.USDC_E,
        tokenB: TOKENS.ARB,
        uniswapFee: 3000,     // Pool de 0.3%
        minProfitBps: 20,     // Mínimo 0.2% de lucro
        maxAmountUsd: 30000,
    },
    {
        tokenA: TOKENS.WETH,
        tokenB: TOKENS.WBTC,
        uniswapFee: 500,
        minProfitBps: 15,
        maxAmountUsd: 100000,
    },
    {
        tokenA: TOKENS.USDC_E,
        tokenB: TOKENS.USDT,
        uniswapFee: 100,      // Pool de 0.01%
        minProfitBps: 5,      // Aceita lucro menor (mais estável)
        maxAmountUsd: 100000,
    },
    {
        tokenA: TOKENS.USDC_E,
        tokenB: TOKENS.DAI,
        uniswapFee: 100,
        minProfitBps: 5,
        maxAmountUsd: 100000,
    },
];

// ============================================================================
// PARÂMETROS DO BOT
// ============================================================================

/**
 * Configurações operacionais do bot
 */
export const BOT_CONFIG = {
    // ========== LUCRO ==========
    // Lucro mínimo em USD para executar (sobrescreve par específico)
    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || '5'),

    // Lucro mínimo em porcentagem
    minProfitPercentage: parseFloat(process.env.MIN_PROFIT_PERCENTAGE || '0.5'),

    // ========== LIMITES ==========
    // Valor máximo de flash loan em USD
    maxFlashLoanUsd: parseFloat(process.env.MAX_FLASH_LOAN_USD || '100000'),

    // Slippage máximo em basis points (100 = 1%)
    maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '100'),

    // Gas price máximo em Gwei
    maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '1'),

    // ========== MONITORAMENTO ==========
    // Intervalo entre checagens em ms
    monitoringIntervalMs: parseInt(process.env.MONITORING_INTERVAL_MS || '1000'),

    // Número de blocos para confirmar transação
    confirmationBlocks: parseInt(process.env.CONFIRMATION_BLOCKS || '1'),

    // Timeout de transação em segundos
    txTimeoutSeconds: parseInt(process.env.TX_TIMEOUT_SECONDS || '60'),

    // ========== MODO DE OPERAÇÃO ==========
    // Modo simulação (não executa transações reais)
    simulationMode: process.env.SIMULATION_MODE === 'true',

    // Multiplicador de gas (1.1 = 10% extra)
    gasMultiplier: parseFloat(process.env.GAS_MULTIPLIER || '1.1'),

    // ========== LOGS ==========
    // Nível de log
    logLevel: process.env.LOG_LEVEL || 'info',

    // Logs detalhados de transações
    verboseTxLogs: process.env.VERBOSE_TX_LOGS === 'true',
};

// ============================================================================
// ABIs MINIFICADAS
// ============================================================================

/**
 * ABIs mínimas necessárias para interação com os contratos
 * Usar ABIs completas aumentaria muito o tamanho do código
 */

// ABI do ERC20
export const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
];

// ABI do Uniswap V3 Quoter
export const UNISWAP_QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
    'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
];

// ABI do Uniswap V3 Pool
export const UNISWAP_POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function liquidity() view returns (uint128)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
];

// ABI do Uniswap V3 Factory
export const UNISWAP_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

// ABI do SushiSwap Router
export const SUSHISWAP_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
    'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)',
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
];

// ABI do SushiSwap Pair
export const SUSHISWAP_PAIR_ABI = [
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];

// ABI do FlashLoanArbitrage (seu contrato)
export const FLASH_LOAN_ARBITRAGE_ABI = [
    'function executeArbitrage((address tokenBorrow, address tokenTarget, uint256 amountBorrow, uint8 dexBuy, uint8 dexSell, uint24 uniswapFeeBuy, uint24 uniswapFeeSell, uint256 minProfit)) external',
    'function simulateArbitrage((address tokenBorrow, address tokenTarget, uint256 amountBorrow, uint8 dexBuy, uint8 dexSell, uint24 uniswapFeeBuy, uint24 uniswapFeeSell, uint256 minProfit)) view returns (uint256 expectedProfit, bool isProfitable)',
    'function withdrawToken(address token, address to, uint256 amount) external',
    'function withdrawETH(address to, uint256 amount) external',
    'function owner() view returns (address)',
    'event ArbitrageExecuted(address indexed tokenBorrow, address indexed tokenTarget, uint256 amountBorrowed, uint256 profit, uint256 timestamp)',
];

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Enum correspondente ao DEX do contrato Solidity
 */
export enum DEX {
    UNISWAP_V3 = 0,
    SUSHISWAP = 1,
}

// ============================================================================
// VALIDAÇÃO DE CONFIGURAÇÃO
// ============================================================================

/**
 * Valida se as configurações essenciais estão presentes
 * Chame esta função no início do bot
 */
export function validateConfig(): void {
    const errors: string[] = [];

    // Verifica RPC URL
    if (!process.env.ARBITRUM_RPC_URL) {
        errors.push('ARBITRUM_RPC_URL não configurado');
    }

    // Verifica chave privada (apenas avisa, não é obrigatório em modo simulação)
    if (!process.env.PRIVATE_KEY && !BOT_CONFIG.simulationMode) {
        errors.push('PRIVATE_KEY não configurado (necessário para executar transações)');
    }

    // Verifica endereço do contrato
    if (!CONTRACTS.flashLoanArbitrage && !BOT_CONFIG.simulationMode) {
        errors.push('FLASH_LOAN_CONTRACT_ADDRESS não configurado');
    }

    if (errors.length > 0) {
        console.error('❌ Erros de configuração:');
        errors.forEach(err => console.error(`   - ${err}`));
        console.error('\n📝 Configure o arquivo .env baseado no .env.example');

        if (!BOT_CONFIG.simulationMode) {
            process.exit(1);
        } else {
            console.warn('⚠️  Continuando em modo simulação...\n');
        }
    }
}
