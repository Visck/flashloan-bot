import dotenv from 'dotenv';
dotenv.config();

export interface ProtocolConfig {
    name: string;
    type: 'aave' | 'radiant';
    poolAddress: string;
    poolDataProvider: string;
    oracleAddress: string;
    liquidationBonus: number; // Em basis points (500 = 5%)
    enabled: boolean;
}

export interface ChainConfig {
    name: string;
    chainId: number;
    rpcUrl: string;
    wssUrl?: string;
    protocols: ProtocolConfig[];
    multicallAddress: string;
    blockExplorer: string;
}

export const CHAINS: Record<string, ChainConfig> = {
    arbitrum: {
        name: 'Arbitrum One',
        chainId: 42161,
        rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        wssUrl: process.env.ARBITRUM_WSS_URL,
        multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
        blockExplorer: 'https://arbiscan.io',
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
                enabled: false, // Desabilitado - protocolo migrou apos hack em Oct/2024
            },
        ],
    },
    base: {
        name: 'Base',
        chainId: 8453,
        rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
        multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
        blockExplorer: 'https://basescan.org',
        protocols: [
            {
                name: 'Aave V3',
                type: 'aave',
                poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
                poolDataProvider: '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac',
                oracleAddress: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156',
                liquidationBonus: 500,
                enabled: false, // Habilitar no futuro
            },
        ],
    },
};

export const BOT_CONFIG = {
    simulationMode: process.env.SIMULATION_MODE === 'true',
    minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || '5'),
    maxGasPriceGwei: parseFloat(process.env.MAX_GAS_PRICE_GWEI || '2'),
    pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '1000'),
    maxUsersPerBatch: 100,
    healthFactorThreshold: 1.0,
    maxLiquidationPercent: 0.5, // 50% max por liquidacao
    flashLoanContractAddress: process.env.FLASH_LOAN_CONTRACT_ADDRESS,
};

export const AAVE_POOL_ABI = [
    'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
    'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external',
    'function getReservesList() external view returns (address[] memory)',
    'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
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
];
