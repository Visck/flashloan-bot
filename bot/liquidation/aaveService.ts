/**
 * ============================================================================
 * AAVE SERVICE - Interação com Aave V3 Protocol
 * ============================================================================
 *
 * Módulo de interação com Aave V3 que:
 * - Busca dados de usuários on-chain
 * - Executa liquidações
 * - Calcula health factors precisos
 * - Gerencia assets e reservas
 */

import {
    JsonRpcProvider,
    Contract,
    Wallet,
    formatUnits,
    parseUnits,
    Interface
} from 'ethers';
import { logger } from '../logger';

// ============================================================================
// AAVE V3 ADDRESSES (ARBITRUM)
// ============================================================================

export const AAVE_V3_ADDRESSES = {
    POOL: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    POOL_DATA_PROVIDER: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
    ORACLE: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7',
    POOL_ADDRESSES_PROVIDER: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb'
};

// ============================================================================
// INTERFACES
// ============================================================================

export interface UserAccountData {
    totalCollateralBase: bigint;
    totalDebtBase: bigint;
    availableBorrowsBase: bigint;
    currentLiquidationThreshold: bigint;
    ltv: bigint;
    healthFactor: bigint;
}

export interface UserPosition {
    address: string;
    healthFactor: number;
    totalCollateralUsd: number;
    totalDebtUsd: number;
    collateralAssets: AssetPosition[];
    debtAssets: AssetPosition[];
}

export interface AssetPosition {
    symbol: string;
    address: string;
    balance: bigint;
    balanceUsd: number;
    liquidationThreshold?: number;
    liquidationBonus?: number;
}

export interface ReserveData {
    symbol: string;
    address: string;
    decimals: number;
    liquidationThreshold: number;
    liquidationBonus: number;
    usageAsCollateralEnabled: boolean;
    borrowingEnabled: boolean;
    stableBorrowRateEnabled: boolean;
    isActive: boolean;
    isFrozen: boolean;
}

export interface LiquidationParams {
    collateralAsset: string;
    debtAsset: string;
    user: string;
    debtToCover: bigint;
    receiveAToken: boolean;
}

// ============================================================================
// ABIs
// ============================================================================

const POOL_ABI = [
    'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
    'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)',
    'function getReservesList() view returns (address[])',
    'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))'
];

const DATA_PROVIDER_ABI = [
    'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
    'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
    'function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)',
    'function getAllReservesTokens() view returns (tuple(string symbol, address tokenAddress)[])'
];

const ORACLE_ABI = [
    'function getAssetPrice(address asset) view returns (uint256)',
    'function getAssetsPrices(address[] assets) view returns (uint256[])',
    'function BASE_CURRENCY_UNIT() view returns (uint256)'
];

const ERC20_ABI = [
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function approve(address spender, uint256 amount) returns (bool)'
];

// ============================================================================
// AAVE SERVICE CLASS
// ============================================================================

export class AaveService {
    private pool: Contract;
    private dataProvider: Contract;
    private oracle: Contract;
    private reserveCache: Map<string, ReserveData> = new Map();
    private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
    private baseCurrencyUnit: bigint = 100000000n; // 8 decimals

    constructor(
        private provider: JsonRpcProvider,
        private wallet?: Wallet
    ) {
        this.pool = new Contract(AAVE_V3_ADDRESSES.POOL, POOL_ABI, wallet || provider);
        this.dataProvider = new Contract(AAVE_V3_ADDRESSES.POOL_DATA_PROVIDER, DATA_PROVIDER_ABI, provider);
        this.oracle = new Contract(AAVE_V3_ADDRESSES.ORACLE, ORACLE_ABI, provider);
    }

    // ========================================================================
    // USER DATA
    // ========================================================================

    /**
     * Busca dados de conta do usuário
     */
    async getUserAccountData(userAddress: string): Promise<UserAccountData> {
        const data = await this.pool.getUserAccountData(userAddress);

        return {
            totalCollateralBase: data.totalCollateralBase,
            totalDebtBase: data.totalDebtBase,
            availableBorrowsBase: data.availableBorrowsBase,
            currentLiquidationThreshold: data.currentLiquidationThreshold,
            ltv: data.ltv,
            healthFactor: data.healthFactor
        };
    }

    /**
     * Busca posição completa do usuário
     */
    async getUserPosition(userAddress: string): Promise<UserPosition> {
        const [accountData, reserves] = await Promise.all([
            this.getUserAccountData(userAddress),
            this.getReservesList()
        ]);

        const collateralAssets: AssetPosition[] = [];
        const debtAssets: AssetPosition[] = [];

        // Busca dados de cada reserva para o usuário
        const reservePromises = reserves.map(async (assetAddress) => {
            try {
                const [userData, reserveConfig, price] = await Promise.all([
                    this.dataProvider.getUserReserveData(assetAddress, userAddress),
                    this.getReserveConfig(assetAddress),
                    this.getAssetPrice(assetAddress)
                ]);

                const decimals = reserveConfig?.decimals || 18;

                // Colateral
                if (userData.currentATokenBalance > 0n) {
                    const balance = userData.currentATokenBalance;
                    const balanceUsd = this.toUsd(balance, decimals, price);

                    collateralAssets.push({
                        symbol: reserveConfig?.symbol || 'UNKNOWN',
                        address: assetAddress,
                        balance,
                        balanceUsd,
                        liquidationThreshold: reserveConfig?.liquidationThreshold || 0,
                        liquidationBonus: reserveConfig?.liquidationBonus || 0
                    });
                }

                // Dívida (variável + estável)
                const totalDebt = userData.currentVariableDebt + userData.currentStableDebt;
                if (totalDebt > 0n) {
                    const balanceUsd = this.toUsd(totalDebt, decimals, price);

                    debtAssets.push({
                        symbol: reserveConfig?.symbol || 'UNKNOWN',
                        address: assetAddress,
                        balance: totalDebt,
                        balanceUsd
                    });
                }
            } catch (error) {
                // Ignora erros de reservas individuais
            }
        });

        await Promise.all(reservePromises);

        // Calcula totais
        const totalCollateralUsd = collateralAssets.reduce((sum, a) => sum + a.balanceUsd, 0);
        const totalDebtUsd = debtAssets.reduce((sum, a) => sum + a.balanceUsd, 0);

        // Health factor (18 decimals no contrato)
        const healthFactor = accountData.healthFactor > 0n
            ? parseFloat(formatUnits(accountData.healthFactor, 18))
            : Infinity;

        return {
            address: userAddress,
            healthFactor,
            totalCollateralUsd,
            totalDebtUsd,
            collateralAssets: collateralAssets.sort((a, b) => b.balanceUsd - a.balanceUsd),
            debtAssets: debtAssets.sort((a, b) => b.balanceUsd - a.balanceUsd)
        };
    }

    /**
     * Busca health factor de múltiplos usuários (otimizado)
     */
    async getMultipleHealthFactors(addresses: string[]): Promise<Map<string, number>> {
        const results = new Map<string, number>();

        // Batch de 50 usuários por vez
        const batchSize = 50;
        for (let i = 0; i < addresses.length; i += batchSize) {
            const batch = addresses.slice(i, i + batchSize);

            const promises = batch.map(async (address) => {
                try {
                    const data = await this.getUserAccountData(address);
                    const hf = data.healthFactor > 0n
                        ? parseFloat(formatUnits(data.healthFactor, 18))
                        : Infinity;
                    return { address, hf };
                } catch {
                    return { address, hf: Infinity };
                }
            });

            const batchResults = await Promise.all(promises);
            for (const { address, hf } of batchResults) {
                results.set(address.toLowerCase(), hf);
            }
        }

        return results;
    }

    // ========================================================================
    // LIQUIDATION
    // ========================================================================

    /**
     * Verifica se usuário pode ser liquidado
     */
    async canBeLiquidated(userAddress: string): Promise<boolean> {
        const data = await this.getUserAccountData(userAddress);
        const hf = parseFloat(formatUnits(data.healthFactor, 18));
        return hf < 1.0 && data.totalDebtBase > 0n;
    }

    /**
     * Calcula parâmetros ótimos de liquidação
     */
    async calculateLiquidationParams(
        userAddress: string
    ): Promise<LiquidationParams | null> {
        const position = await this.getUserPosition(userAddress);

        if (position.healthFactor >= 1.0) {
            return null;
        }

        if (position.collateralAssets.length === 0 || position.debtAssets.length === 0) {
            return null;
        }

        // Escolhe melhor colateral (maior valor * maior bonus)
        const bestCollateral = position.collateralAssets
            .sort((a, b) => {
                const scoreA = a.balanceUsd * (a.liquidationBonus || 1);
                const scoreB = b.balanceUsd * (b.liquidationBonus || 1);
                return scoreB - scoreA;
            })[0];

        // Escolhe melhor dívida (maior valor)
        const bestDebt = position.debtAssets[0];

        // Máximo que pode ser liquidado = 50% da dívida
        const maxLiquidation = bestDebt.balance / 2n;

        return {
            collateralAsset: bestCollateral.address,
            debtAsset: bestDebt.address,
            user: userAddress,
            debtToCover: maxLiquidation,
            receiveAToken: false
        };
    }

    /**
     * Executa liquidação
     */
    async executeLiquidation(params: LiquidationParams): Promise<string> {
        if (!this.wallet) {
            throw new Error('Wallet not configured for liquidation');
        }

        logger.info(`Executing liquidation for ${params.user}`);

        // Aprova token de dívida se necessário
        const debtToken = new Contract(params.debtAsset, ERC20_ABI, this.wallet);
        const allowance = await debtToken.allowance(
            this.wallet.address,
            AAVE_V3_ADDRESSES.POOL
        );

        if (allowance < params.debtToCover) {
            logger.debug('Approving debt token...');
            const approveTx = await debtToken.approve(
                AAVE_V3_ADDRESSES.POOL,
                params.debtToCover * 2n // Aprova um pouco mais
            );
            await approveTx.wait();
        }

        // Executa liquidação
        const tx = await this.pool.liquidationCall(
            params.collateralAsset,
            params.debtAsset,
            params.user,
            params.debtToCover,
            params.receiveAToken
        );

        const receipt = await tx.wait();
        logger.info(`Liquidation executed: ${receipt.hash}`);

        return receipt.hash;
    }

    /**
     * Simula liquidação (dry run)
     */
    async simulateLiquidation(params: LiquidationParams): Promise<{
        success: boolean;
        error?: string;
        estimatedGas?: bigint;
    }> {
        try {
            const gas = await this.pool.liquidationCall.estimateGas(
                params.collateralAsset,
                params.debtAsset,
                params.user,
                params.debtToCover,
                params.receiveAToken
            );

            return { success: true, estimatedGas: gas };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || 'Unknown error'
            };
        }
    }

    // ========================================================================
    // RESERVES & PRICES
    // ========================================================================

    /**
     * Busca lista de todas as reservas
     */
    async getReservesList(): Promise<string[]> {
        return await this.pool.getReservesList();
    }

    /**
     * Busca configuração de uma reserva
     */
    async getReserveConfig(assetAddress: string): Promise<ReserveData | null> {
        const cached = this.reserveCache.get(assetAddress.toLowerCase());
        if (cached) return cached;

        try {
            const [config, tokens] = await Promise.all([
                this.dataProvider.getReserveConfigurationData(assetAddress),
                this.dataProvider.getReserveTokensAddresses(assetAddress)
            ]);

            // Busca símbolo
            const token = new Contract(assetAddress, ERC20_ABI, this.provider);
            const symbol = await token.symbol();

            const reserveData: ReserveData = {
                symbol,
                address: assetAddress,
                decimals: Number(config.decimals),
                liquidationThreshold: Number(config.liquidationThreshold) / 100,
                liquidationBonus: (Number(config.liquidationBonus) - 10000) / 100,
                usageAsCollateralEnabled: config.usageAsCollateralEnabled,
                borrowingEnabled: config.borrowingEnabled,
                stableBorrowRateEnabled: config.stableBorrowRateEnabled,
                isActive: config.isActive,
                isFrozen: config.isFrozen
            };

            this.reserveCache.set(assetAddress.toLowerCase(), reserveData);
            return reserveData;
        } catch (error) {
            logger.error(`Failed to get reserve config for ${assetAddress}:`, error);
            return null;
        }
    }

    /**
     * Busca preço de um asset
     */
    async getAssetPrice(assetAddress: string): Promise<number> {
        const cached = this.priceCache.get(assetAddress.toLowerCase());
        if (cached && Date.now() - cached.timestamp < 60000) {
            return cached.price;
        }

        try {
            const priceRaw = await this.oracle.getAssetPrice(assetAddress);
            const price = parseFloat(formatUnits(priceRaw, 8)); // Oracle usa 8 decimals

            this.priceCache.set(assetAddress.toLowerCase(), {
                price,
                timestamp: Date.now()
            });

            return price;
        } catch (error) {
            return cached?.price || 0;
        }
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    /**
     * Converte valor para USD
     */
    private toUsd(amount: bigint, decimals: number, priceUsd: number): number {
        const value = parseFloat(formatUnits(amount, decimals));
        return value * priceUsd;
    }

    /**
     * Limpa cache
     */
    clearCache(): void {
        this.priceCache.clear();
        // Mantém reserve cache pois raramente muda
    }

    /**
     * Atualiza provider
     */
    setProvider(provider: JsonRpcProvider): void {
        this.provider = provider;
        this.pool = new Contract(AAVE_V3_ADDRESSES.POOL, POOL_ABI, this.wallet || provider);
        this.dataProvider = new Contract(AAVE_V3_ADDRESSES.POOL_DATA_PROVIDER, DATA_PROVIDER_ABI, provider);
        this.oracle = new Contract(AAVE_V3_ADDRESSES.ORACLE, ORACLE_ABI, provider);
    }

    /**
     * Atualiza wallet
     */
    setWallet(wallet: Wallet): void {
        this.wallet = wallet;
        this.pool = new Contract(AAVE_V3_ADDRESSES.POOL, POOL_ABI, wallet);
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createAaveService(
    provider: JsonRpcProvider,
    privateKey?: string
): AaveService {
    let wallet: Wallet | undefined;

    if (privateKey) {
        wallet = new Wallet(privateKey, provider);
    }

    return new AaveService(provider, wallet);
}
