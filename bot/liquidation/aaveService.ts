import { ethers, Contract, Provider, Wallet } from 'ethers';
import { logger } from '../services/logger';
import { Multicall, batchGetUserAccountData } from '../services/multicall';
import {
    AAVE_POOL_ABI,
    AAVE_DATA_PROVIDER_ABI,
    AAVE_ORACLE_ABI,
    ERC20_ABI,
    ProtocolConfig,
    BOT_CONFIG,
} from './liquidationConfig';

export interface UserAccountData {
    user: string;
    totalCollateralBase: bigint;
    totalDebtBase: bigint;
    availableBorrowsBase: bigint;
    currentLiquidationThreshold: bigint;
    ltv: bigint;
    healthFactor: bigint;
    healthFactorNum: number;
}

export interface UserReserveData {
    asset: string;
    symbol: string;
    aTokenBalance: bigint;
    stableDebt: bigint;
    variableDebt: bigint;
    usageAsCollateralEnabled: boolean;
    decimals: number;
}

export interface LiquidationOpportunity {
    protocol: string;
    user: string;
    healthFactor: number;
    collateralAsset: string;
    collateralSymbol: string;
    collateralAmount: bigint;
    collateralValueUsd: number;
    debtAsset: string;
    debtSymbol: string;
    debtAmount: bigint;
    debtValueUsd: number;
    maxLiquidatableDebt: bigint;
    liquidationBonus: number;
    expectedProfitUsd: number;
    gasEstimateUsd: number;
    netProfitUsd: number;
}

export interface ReserveInfo {
    address: string;
    symbol: string;
    decimals: number;
    liquidationBonus: number;
    liquidationThreshold: number;
    ltv: number;
    priceUsd: number;
}

export class AaveService {
    private provider: Provider;
    private poolContract: Contract;
    private dataProviderContract: Contract;
    private oracleContract: Contract;
    private multicall: Multicall;
    private config: ProtocolConfig;
    private reservesCache: Map<string, ReserveInfo> = new Map();
    private baseCurrencyUnit: bigint = BigInt(1e8); // USD com 8 decimals

    constructor(provider: Provider, config: ProtocolConfig) {
        this.provider = provider;
        this.config = config;
        this.multicall = new Multicall(provider);

        this.poolContract = new Contract(config.poolAddress, AAVE_POOL_ABI, provider);
        this.dataProviderContract = new Contract(config.poolDataProvider, AAVE_DATA_PROVIDER_ABI, provider);
        this.oracleContract = new Contract(config.oracleAddress, AAVE_ORACLE_ABI, provider);
    }

    async initialize(): Promise<void> {
        logger.info(`Initializing ${this.config.name} service...`);

        try {
            this.baseCurrencyUnit = await this.oracleContract.BASE_CURRENCY_UNIT();
            await this.loadReserves();
            logger.info(`${this.config.name} initialized with ${this.reservesCache.size} reserves`);
        } catch (error) {
            logger.error(`Failed to initialize ${this.config.name}: ${error}`);
            throw error;
        }
    }

    private async loadReserves(): Promise<void> {
        const reserveTokens = await this.dataProviderContract.getAllReservesTokens();

        for (const token of reserveTokens) {
            try {
                const [configData, price] = await Promise.all([
                    this.dataProviderContract.getReserveConfigurationData(token.tokenAddress),
                    this.oracleContract.getAssetPrice(token.tokenAddress),
                ]);

                const reserveInfo: ReserveInfo = {
                    address: token.tokenAddress,
                    symbol: token.symbol,
                    decimals: Number(configData.decimals),
                    liquidationBonus: Number(configData.liquidationBonus) / 100, // basis points to %
                    liquidationThreshold: Number(configData.liquidationThreshold) / 100,
                    ltv: Number(configData.ltv) / 100,
                    priceUsd: Number(price) / Number(this.baseCurrencyUnit),
                };

                this.reservesCache.set(token.tokenAddress.toLowerCase(), reserveInfo);
            } catch (error) {
                logger.warn(`Failed to load reserve ${token.symbol}: ${error}`);
            }
        }
    }

    async getUserAccountData(user: string): Promise<UserAccountData> {
        const data = await this.poolContract.getUserAccountData(user);

        return {
            user,
            totalCollateralBase: data[0],
            totalDebtBase: data[1],
            availableBorrowsBase: data[2],
            currentLiquidationThreshold: data[3],
            ltv: data[4],
            healthFactor: data[5],
            healthFactorNum: Number(data[5]) / 1e18,
        };
    }

    async getBatchUserAccountData(users: string[]): Promise<UserAccountData[]> {
        const dataMap = await batchGetUserAccountData(this.multicall, this.poolContract, users);
        const results: UserAccountData[] = [];

        for (const [user, data] of dataMap) {
            if (data) {
                results.push({
                    user,
                    totalCollateralBase: data[0],
                    totalDebtBase: data[1],
                    availableBorrowsBase: data[2],
                    currentLiquidationThreshold: data[3],
                    ltv: data[4],
                    healthFactor: data[5],
                    healthFactorNum: Number(data[5]) / 1e18,
                });
            }
        }

        return results;
    }

    async getUserReserves(user: string): Promise<UserReserveData[]> {
        const reserves: UserReserveData[] = [];

        for (const [address, info] of this.reservesCache) {
            try {
                const data = await this.dataProviderContract.getUserReserveData(address, user);

                if (data[0] > 0n || data[1] > 0n || data[2] > 0n) {
                    reserves.push({
                        asset: address,
                        symbol: info.symbol,
                        aTokenBalance: data[0],
                        stableDebt: data[1],
                        variableDebt: data[2],
                        usageAsCollateralEnabled: data[8],
                        decimals: info.decimals,
                    });
                }
            } catch (error) {
                logger.warn(`Failed to get user reserve data for ${info.symbol}: ${error}`);
            }
        }

        return reserves;
    }

    async calculateLiquidationOpportunity(
        user: string,
        accountData: UserAccountData
    ): Promise<LiquidationOpportunity | null> {
        if (accountData.healthFactorNum >= BOT_CONFIG.healthFactorThreshold) {
            return null;
        }

        const userReserves = await this.getUserReserves(user);

        // Encontra o maior colateral e a maior divida
        let bestCollateral: UserReserveData | null = null;
        let bestCollateralValue = 0;
        let bestDebt: UserReserveData | null = null;
        let bestDebtValue = 0;

        for (const reserve of userReserves) {
            const reserveInfo = this.reservesCache.get(reserve.asset.toLowerCase());
            if (!reserveInfo) continue;

            // Verifica colateral
            if (reserve.aTokenBalance > 0n && reserve.usageAsCollateralEnabled) {
                const value = Number(reserve.aTokenBalance) / Math.pow(10, reserve.decimals) * reserveInfo.priceUsd;
                if (value > bestCollateralValue) {
                    bestCollateralValue = value;
                    bestCollateral = reserve;
                }
            }

            // Verifica divida (estavel + variavel)
            const totalDebt = reserve.stableDebt + reserve.variableDebt;
            if (totalDebt > 0n) {
                const value = Number(totalDebt) / Math.pow(10, reserve.decimals) * reserveInfo.priceUsd;
                if (value > bestDebtValue) {
                    bestDebtValue = value;
                    bestDebt = reserve;
                }
            }
        }

        if (!bestCollateral || !bestDebt) {
            return null;
        }

        const collateralInfo = this.reservesCache.get(bestCollateral.asset.toLowerCase())!;
        const debtInfo = this.reservesCache.get(bestDebt.asset.toLowerCase())!;

        // Calcula quanto pode liquidar (max 50% da divida)
        const totalDebt = bestDebt.stableDebt + bestDebt.variableDebt;
        const maxLiquidatableDebt = (totalDebt * BigInt(Math.floor(BOT_CONFIG.maxLiquidationPercent * 10000))) / 10000n;

        // Calcula lucro esperado
        const debtValueUsd = Number(maxLiquidatableDebt) / Math.pow(10, debtInfo.decimals) * debtInfo.priceUsd;
        const liquidationBonusPercent = collateralInfo.liquidationBonus - 100; // Bonus acima de 100%
        const bonusValueUsd = debtValueUsd * (liquidationBonusPercent / 100);

        // Estima gas (aproximado)
        const gasEstimateUsd = 0.5; // ~0.5 USD em gas na Arbitrum

        const netProfitUsd = bonusValueUsd - gasEstimateUsd;

        if (netProfitUsd < BOT_CONFIG.minProfitUsd) {
            return null;
        }

        return {
            protocol: this.config.name,
            user,
            healthFactor: accountData.healthFactorNum,
            collateralAsset: bestCollateral.asset,
            collateralSymbol: collateralInfo.symbol,
            collateralAmount: bestCollateral.aTokenBalance,
            collateralValueUsd: bestCollateralValue,
            debtAsset: bestDebt.asset,
            debtSymbol: debtInfo.symbol,
            debtAmount: totalDebt,
            debtValueUsd: bestDebtValue,
            maxLiquidatableDebt,
            liquidationBonus: collateralInfo.liquidationBonus,
            expectedProfitUsd: bonusValueUsd,
            gasEstimateUsd,
            netProfitUsd,
        };
    }

    async simulateLiquidation(opportunity: LiquidationOpportunity): Promise<boolean> {
        try {
            await this.poolContract.liquidationCall.staticCall(
                opportunity.collateralAsset,
                opportunity.debtAsset,
                opportunity.user,
                opportunity.maxLiquidatableDebt,
                false // receiveAToken = false (receber o ativo diretamente)
            );
            return true;
        } catch (error) {
            logger.warn(`Simulation failed for ${opportunity.user}: ${error}`);
            return false;
        }
    }

    async executeLiquidation(
        opportunity: LiquidationOpportunity,
        signer: Wallet
    ): Promise<string | null> {
        if (BOT_CONFIG.simulationMode) {
            logger.info(`[SIMULATION] Would liquidate ${opportunity.user}`);
            return 'SIMULATION_TX_HASH';
        }

        try {
            const poolWithSigner = this.poolContract.connect(signer) as Contract;

            const tx = await poolWithSigner.liquidationCall(
                opportunity.collateralAsset,
                opportunity.debtAsset,
                opportunity.user,
                opportunity.maxLiquidatableDebt,
                false
            );

            const receipt = await tx.wait();
            logger.info(`Liquidation executed: ${receipt.hash}`);

            return receipt.hash;
        } catch (error) {
            logger.error(`Liquidation failed: ${error}`);
            return null;
        }
    }

    getReserveInfo(address: string): ReserveInfo | undefined {
        return this.reservesCache.get(address.toLowerCase());
    }

    getAllReserves(): ReserveInfo[] {
        return Array.from(this.reservesCache.values());
    }

    getPoolAddress(): string {
        return this.config.poolAddress;
    }

    getProtocolName(): string {
        return this.config.name;
    }
}
