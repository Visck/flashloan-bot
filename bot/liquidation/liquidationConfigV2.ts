/**
 * Configuração Multi-Chain V2 para Liquidation Bot
 * Suporta: Arbitrum, Base, Optimism, Polygon, Avalanche
 */

import dotenv from 'dotenv';
dotenv.config();

export interface ProtocolConfig {
    name: string;
    type: 'aave' | 'radiant' | 'compound' | 'silo';
    poolAddress: string;
    poolDataProvider: string;
    oracleAddress: string;
    liquidationBonus: number; // Em basis points (500 = 5%)
    enabled: boolean;
    minProfitUsd?: number; // Override do minProfit global
}

export interface ChainConfig {
    name: string;
    chainId: number;
    rpcUrls: string[]; // Múltiplos RPCs para failover
    wssUrls?: string[];
    protocols: ProtocolConfig[];
    multicallAddress: string;
    blockExplorer: string;
    avgBlockTime: number; // em ms
    nativeToken: string;
    enabled: boolean;
}

// ==============================================================================
// CONFIGURAÇÕES POR CHAIN
// ==============================================================================

export const CHAINS: Record<string, ChainConfig> = {
    // ==========================================================================
    // ARBITRUM ONE (Principal)
    // ==========================================================================
    arbitrum: {
        name: 'Arbitrum One',
        chainId: 42161,
        rpcUrls: [
            process.env.LOCAL_NODE_RPC_URL || '', // Nó próprio (maior prioridade)
            process.env.ARBITRUM_RPC_URL || '',   // Alchemy
            'https://arb1.arbitrum.io/rpc',
            'https://arbitrum-one-rpc.publicnode.com',
            'https://arbitrum.drpc.org',
            'https://1rpc.io/arb',
            'https://arbitrum.meowrpc.com',
        ].filter(url => url && url.length > 0),
        wssUrls: [
            process.env.LOCAL_NODE_WSS_URL || '', // Nó próprio WebSocket
            process.env.ARBITRUM_WSS_URL || '',   // Alchemy WSS
            'wss://arbitrum-one-rpc.publicnode.com',
            'wss://arbitrum.drpc.org',
        ].filter(url => url && url.length > 0),
        multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
        blockExplorer: 'https://arbiscan.io',
        avgBlockTime: 250, // Arbitrum: ~250ms por bloco
        nativeToken: 'ETH',
        enabled: true,
        protocols: [
            {
                name: 'Aave V3',
                type: 'aave',
                poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
                poolDataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
                oracleAddress: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7',
                liquidationBonus: 500, // 5%
                enabled: true,
            },
            {
                name: 'Radiant Capital',
                type: 'radiant',
                poolAddress: '0xF4B1486DD74D07706052A33d31d7c0AAFD0659E1',
                poolDataProvider: '0x596B0cc4c5094507C50b579a662FE7e7b094A2cC',
                oracleAddress: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7',
                liquidationBonus: 750, // 7.5%
                enabled: false, // Desabilitado - protocolo comprometido
            },
            {
                name: 'Silo Finance',
                type: 'silo',
                poolAddress: '0x0000000000000000000000000000000000000000', // TODO: Adicionar
                poolDataProvider: '0x0000000000000000000000000000000000000000',
                oracleAddress: '0x0000000000000000000000000000000000000000',
                liquidationBonus: 500,
                enabled: false,
            },
        ],
    },

    // ==========================================================================
    // BASE
    // ==========================================================================
    base: {
        name: 'Base',
        chainId: 8453,
        rpcUrls: [
            process.env.BASE_RPC_URL || '',
            'https://mainnet.base.org',
            'https://base-rpc.publicnode.com',
            'https://base.drpc.org',
            'https://1rpc.io/base',
        ].filter(url => url && url.length > 0),
        wssUrls: [
            process.env.BASE_WSS_URL || '',
            'wss://base-rpc.publicnode.com',
        ].filter(url => url && url.length > 0),
        multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
        blockExplorer: 'https://basescan.org',
        avgBlockTime: 2000, // Base: ~2s por bloco
        nativeToken: 'ETH',
        enabled: true,
        protocols: [
            {
                name: 'Aave V3',
                type: 'aave',
                poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
                poolDataProvider: '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac',
                oracleAddress: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156',
                liquidationBonus: 500, // 5%
                enabled: true,
            },
            {
                name: 'Moonwell',
                type: 'compound',
                poolAddress: '0x0000000000000000000000000000000000000000', // TODO
                poolDataProvider: '0x0000000000000000000000000000000000000000',
                oracleAddress: '0x0000000000000000000000000000000000000000',
                liquidationBonus: 800, // 8%
                enabled: false,
            },
        ],
    },

    // ==========================================================================
    // OPTIMISM
    // ==========================================================================
    optimism: {
        name: 'Optimism',
        chainId: 10,
        rpcUrls: [
            process.env.OPTIMISM_RPC_URL || '',
            'https://mainnet.optimism.io',
            'https://optimism-rpc.publicnode.com',
            'https://optimism.drpc.org',
            'https://1rpc.io/op',
        ].filter(url => url && url.length > 0),
        wssUrls: [
            process.env.OPTIMISM_WSS_URL || '',
            'wss://optimism-rpc.publicnode.com',
        ].filter(url => url && url.length > 0),
        multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
        blockExplorer: 'https://optimistic.etherscan.io',
        avgBlockTime: 2000, // Optimism: ~2s por bloco
        nativeToken: 'ETH',
        enabled: true,
        protocols: [
            {
                name: 'Aave V3',
                type: 'aave',
                poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
                poolDataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
                oracleAddress: '0xD81eb3728a631871a7eBBaD631b5f424909f0c77',
                liquidationBonus: 500, // 5%
                enabled: true,
            },
        ],
    },

    // ==========================================================================
    // POLYGON
    // ==========================================================================
    polygon: {
        name: 'Polygon',
        chainId: 137,
        rpcUrls: [
            process.env.POLYGON_RPC_URL || '',
            'https://polygon-rpc.com',
            'https://polygon-bor-rpc.publicnode.com',
            'https://polygon.drpc.org',
            'https://1rpc.io/matic',
        ].filter(url => url && url.length > 0),
        wssUrls: [
            process.env.POLYGON_WSS_URL || '',
            'wss://polygon-bor-rpc.publicnode.com',
        ].filter(url => url && url.length > 0),
        multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
        blockExplorer: 'https://polygonscan.com',
        avgBlockTime: 2000, // Polygon: ~2s por bloco
        nativeToken: 'MATIC',
        enabled: false, // Desabilitado por padrão
        protocols: [
            {
                name: 'Aave V3',
                type: 'aave',
                poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
                poolDataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
                oracleAddress: '0xb023e699F5a33916Ea823A16485e259257cA8Bd1',
                liquidationBonus: 500, // 5%
                enabled: true,
            },
        ],
    },

    // ==========================================================================
    // AVALANCHE
    // ==========================================================================
    avalanche: {
        name: 'Avalanche C-Chain',
        chainId: 43114,
        rpcUrls: [
            process.env.AVALANCHE_RPC_URL || '',
            'https://api.avax.network/ext/bc/C/rpc',
            'https://avalanche-c-chain-rpc.publicnode.com',
            'https://avalanche.drpc.org',
            'https://1rpc.io/avax/c',
        ].filter(url => url && url.length > 0),
        wssUrls: [
            process.env.AVALANCHE_WSS_URL || '',
            'wss://avalanche-c-chain-rpc.publicnode.com',
        ].filter(url => url && url.length > 0),
        multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
        blockExplorer: 'https://snowtrace.io',
        avgBlockTime: 2000, // Avalanche: ~2s por bloco
        nativeToken: 'AVAX',
        enabled: false, // Desabilitado por padrão
        protocols: [
            {
                name: 'Aave V3',
                type: 'aave',
                poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
                poolDataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
                oracleAddress: '0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C',
                liquidationBonus: 500, // 5%
                enabled: true,
            },
        ],
    },
};

// ==============================================================================
// CONFIGURAÇÕES DO BOT
// ==============================================================================

export const BOT_CONFIG = {
    // Modo de operação
    simulationMode: process.env.SIMULATION_MODE !== 'false', // Default: true

    // Limites de lucro
    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || '5'),
    maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '2'),

    // Performance
    pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '500'), // Reduzido para 500ms
    maxUsersPerBatch: parseInt(process.env.MAX_USERS_PER_BATCH || '200'), // Aumentado
    parallelBatches: parseInt(process.env.PARALLEL_BATCHES || '20'), // Mais paralelismo

    // Liquidação
    healthFactorThreshold: parseFloat(process.env.HEALTH_FACTOR_THRESHOLD || '1.0'),
    maxLiquidationPercent: 0.5, // 50% max por liquidação

    // Flash Loan
    flashLoanContractAddress: process.env.FLASH_LOAN_CONTRACT_ADDRESS,
    useFlashLoan: process.env.USE_FLASH_LOAN === 'true',

    // MEV Protection
    useMevProtection: process.env.USE_MEV_PROTECTION === 'true',

    // Nó próprio
    useLocalNode: process.env.USE_LOCAL_NODE === 'true',
    localNodeRpcUrl: process.env.LOCAL_NODE_RPC_URL || 'http://localhost:8547',
    localNodeWssUrl: process.env.LOCAL_NODE_WSS_URL || 'ws://localhost:8548',

    // WebSocket
    useWebSocket: process.env.USE_WEBSOCKET !== 'false', // Default: true

    // Descoberta de usuários
    userDiscoveryBlocksBack: parseInt(process.env.USER_DISCOVERY_BLOCKS || '10000'),
    fastDiscoveryInterval: parseInt(process.env.FAST_DISCOVERY_INTERVAL || '3000'), // 3s
    deepDiscoveryInterval: parseInt(process.env.DEEP_DISCOVERY_INTERVAL || '900000'), // 15min

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
    verboseLogs: process.env.VERBOSE_LOGS === 'true',
};

// ==============================================================================
// ABIs
// ==============================================================================

export const AAVE_POOL_ABI = [
    'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
    'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external',
    'function getReservesList() external view returns (address[] memory)',
    'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
    // Eventos para descoberta de usuários
    'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
    'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
    'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
    'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
    'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
];

export const AAVE_DATA_PROVIDER_ABI = [
    'function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
    'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
    'function getAllReservesTokens() external view returns (tuple(string symbol, address tokenAddress)[] memory)',
    'function getReserveTokensAddresses(address asset) external view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)',
];

export const AAVE_ORACLE_ABI = [
    'function getAssetPrice(address asset) external view returns (uint256)',
    'function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory)',
    'function BASE_CURRENCY_UNIT() external view returns (uint256)',
];

export const ERC20_ABI = [
    'function balanceOf(address account) external view returns (uint256)',
    'function decimals() external view returns (uint8)',
    'function symbol() external view returns (string)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) external view returns (uint256)',
];

// ==============================================================================
// HELPERS
// ==============================================================================

export function getEnabledChains(): ChainConfig[] {
    return Object.values(CHAINS).filter(chain => chain.enabled);
}

export function getChainByName(name: string): ChainConfig | undefined {
    return CHAINS[name.toLowerCase()];
}

export function getChainById(chainId: number): ChainConfig | undefined {
    return Object.values(CHAINS).find(chain => chain.chainId === chainId);
}

export function getEnabledProtocols(chain: ChainConfig): ProtocolConfig[] {
    return chain.protocols.filter(protocol => protocol.enabled);
}
