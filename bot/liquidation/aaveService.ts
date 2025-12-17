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
    OPTIMIZATION_CONFIG,
} from './liquidationConfig';
import { CacheService, cache } from './cacheService';
import { RateLimiter, rateLimiter } from './rateLimiter';
import { cuTracker, CU_COSTS } from './optimizedConfig';

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

    // Optimization services
    private cacheService: CacheService = cache;
    private rateLimiterService: RateLimiter = rateLimiter;

    // Statistics
    private stats = {
        cacheHits: 0,
        cacheMisses: 0,
        rpcCalls: 0,
        cusSaved: 0,
    };

    constructor(provider: Provider, config: ProtocolConfig) {
        this.provider = provider;
        this.config = config;
        this.multicall = new Multicall(provider);

        this.poolContract = new Contract(config.poolAddress, AAVE_POOL_ABI, provider);
        this.dataProviderContract = new Contract(config.poolDataProvider, AAVE_DATA_PROVIDER_ABI, provider);
        this.oracleContract = new Contract(config.oracleAddress, AAVE_ORACLE_ABI, provider);

        // Configure rate limiter based on optimization preset
        this.rateLimiterService.updateConfig({
            maxRequestsPerSecond: OPTIMIZATION_CONFIG.maxRequestsPerSecond,
            maxRequestsPerMinute: OPTIMIZATION_CONFIG.maxRequestsPerMinute,
        });
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

    // ========================================================================
    // OPTIMIZED METHODS - Com Cache e Rate Limiting
    // ========================================================================

    /**
     * Busca dados de conta com cache
     * Economia: Evita chamadas RPC repetidas para mesmo usuário
     */
    async getBatchUserAccountDataOptimized(users: string[]): Promise<UserAccountData[]> {
        if (users.length === 0) return [];

        const results: UserAccountData[] = [];
        const uncachedUsers: string[] = [];

        // 1. Verifica cache primeiro
        for (const user of users) {
            const cached = this.cacheService.getHealthFactor(user);
            if (cached !== null) {
                this.stats.cacheHits++;
                // Retorna dados parciais do cache (HF é o mais importante)
                results.push({
                    user,
                    totalCollateralBase: 0n,
                    totalDebtBase: 0n,
                    availableBorrowsBase: 0n,
                    currentLiquidationThreshold: 0n,
                    ltv: 0n,
                    healthFactor: BigInt(Math.floor(cached * 1e18)),
                    healthFactorNum: cached,
                });
            } else {
                this.stats.cacheMisses++;
                uncachedUsers.push(user);
            }
        }

        // 2. Busca dados não cacheados via RPC (com rate limiting)
        if (uncachedUsers.length > 0) {
            const cusBefore = uncachedUsers.length * CU_COSTS.eth_call;

            try {
                const freshData = await this.rateLimiterService.execute(async () => {
                    this.stats.rpcCalls++;
                    cuTracker.record(CU_COSTS.multicall); // 1 multicall ao invés de N chamadas
                    return await this.getBatchUserAccountData(uncachedUsers);
                });

                // Adiciona aos resultados e salva no cache
                for (const data of freshData) {
                    results.push(data);
                    this.cacheService.setHealthFactor(data.user, data.healthFactorNum);
                }

                // Calcula economia
                const cusSaved = cusBefore - CU_COSTS.multicall;
                this.stats.cusSaved += cusSaved;

                if (uncachedUsers.length > 10) {
                    logger.debug(
                        `Fetched ${uncachedUsers.length} users via multicall. ` +
                        `Saved ~${cusSaved} CUs (${((cusSaved / cusBefore) * 100).toFixed(0)}%)`
                    );
                }
            } catch (error) {
                logger.error('Failed to fetch batch user data:', error);
            }
        }

        return results;
    }

    /**
     * Filtra usuários por health factor (usa cache)
     * Retorna apenas usuários com HF abaixo do threshold
     */
    async filterLiquidatableUsers(users: string[]): Promise<string[]> {
        const accountData = await this.getBatchUserAccountDataOptimized(users);
        return accountData
            .filter(data => data.healthFactorNum < BOT_CONFIG.healthFactorThreshold)
            .map(data => data.user);
    }

    /**
     * Classifica usuários por nível de risco
     */
    async classifyUsersByRisk(users: string[]): Promise<{
        critical: string[];   // HF < 1.0
        highRisk: string[];   // HF < 1.05
        mediumRisk: string[]; // HF < 1.15
        lowRisk: string[];    // HF >= 1.15
    }> {
        const accountData = await this.getBatchUserAccountDataOptimized(users);

        const critical: string[] = [];
        const highRisk: string[] = [];
        const mediumRisk: string[] = [];
        const lowRisk: string[] = [];

        for (const data of accountData) {
            const hf = data.healthFactorNum;
            if (hf < OPTIMIZATION_CONFIG.criticalHF) {
                critical.push(data.user);
            } else if (hf < OPTIMIZATION_CONFIG.highRiskHF) {
                highRisk.push(data.user);
            } else if (hf < OPTIMIZATION_CONFIG.mediumRiskHF) {
                mediumRisk.push(data.user);
            } else {
                lowRisk.push(data.user);
            }
        }

        return { critical, highRisk, mediumRisk, lowRisk };
    }

    /**
     * Retorna estatísticas de otimização
     */
    getOptimizationStats(): {
        cacheHits: number;
        cacheMisses: number;
        cacheHitRate: number;
        rpcCalls: number;
        cusSaved: number;
    } {
        const total = this.stats.cacheHits + this.stats.cacheMisses;
        const hitRate = total > 0 ? (this.stats.cacheHits / total) * 100 : 0;

        return {
            ...this.stats,
            cacheHitRate: Math.round(hitRate * 100) / 100,
        };
    }

    /**
     * Limpa cache de um usuário específico (após liquidação)
     */
    invalidateUserCache(user: string): void {
        this.cacheService.delete(`hf:${user.toLowerCase()}`);
    }

    /**
     * Limpa todas as estatísticas
     */
    resetStats(): void {
        this.stats = {
            cacheHits: 0,
            cacheMisses: 0,
            rpcCalls: 0,
            cusSaved: 0,
        };
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
        // Usar Flash Loan se contrato configurado
        if (BOT_CONFIG.flashLoanContractAddress) {
            return this.executeLiquidationWithFlashLoan(opportunity, signer);
        }

        // Fallback: liquidação direta (precisa ter tokens)
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

    /**
     * Executa liquidação usando Flash Loan (não precisa de capital próprio)
     */
    async executeLiquidationWithFlashLoan(
        opportunity: LiquidationOpportunity,
        signer: Wallet
    ): Promise<string | null> {
        if (!BOT_CONFIG.flashLoanContractAddress) {
            logger.error('Flash loan contract address not configured');
            return null;
        }

        if (BOT_CONFIG.simulationMode) {
            logger.info(`[SIMULATION] Would liquidate ${opportunity.user} with Flash Loan`);
            return 'SIMULATION_TX_HASH';
        }

        try {
            const LIQUIDATOR_ABI = [
                'function executeLiquidation((address collateralAsset, address debtAsset, address user, uint256 debtToCover, uint24 swapFee, uint256 minProfit) params) external',
                'function owner() view returns (address)'
            ];

            const liquidatorContract = new Contract(
                BOT_CONFIG.flashLoanContractAddress,
                LIQUIDATOR_ABI,
                signer
            );

            // Determina fee do Uniswap baseado nos tokens
            const swapFee = this.getSwapFee(opportunity.collateralAsset, opportunity.debtAsset);

            // Calcula lucro mínimo (em wei do debt token)
            const minProfitWei = 0n; // Aceita qualquer lucro positivo

            const params = {
                collateralAsset: opportunity.collateralAsset,
                debtAsset: opportunity.debtAsset,
                user: opportunity.user,
                debtToCover: opportunity.maxLiquidatableDebt,
                swapFee: swapFee,
                minProfit: minProfitWei
            };

            logger.info(`Executing Flash Loan liquidation for ${opportunity.user}`);
            logger.info(`  Debt: ${opportunity.debtSymbol} - ${ethers.formatUnits(opportunity.maxLiquidatableDebt, 18)}`);
            logger.info(`  Collateral: ${opportunity.collateralSymbol}`);
            logger.info(`  Expected profit: $${opportunity.expectedProfitUsd.toFixed(2)}`);

            const tx = await liquidatorContract.executeLiquidation(params, {
                gasLimit: 800000n
            });

            const receipt = await tx.wait();
            logger.info(`Flash Loan liquidation executed: ${receipt.hash}`);

            return receipt.hash;
        } catch (error) {
            logger.error(`Flash Loan liquidation failed: ${error}`);
            return null;
        }
    }

    /**
     * Determina a fee do Uniswap V3 para o par de tokens
     */
    private getSwapFee(tokenA: string, tokenB: string): number {
        // Stablecoins geralmente usam 100 (0.01%) ou 500 (0.05%)
        const stablecoins = [
            '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
            '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // USDC.e
            '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
            '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'  // DAI
        ].map(a => a.toLowerCase());

        const aIsStable = stablecoins.includes(tokenA.toLowerCase());
        const bIsStable = stablecoins.includes(tokenB.toLowerCase());

        // Par de stablecoins: fee baixa
        if (aIsStable && bIsStable) return 100;

        // Um é stablecoin: fee média
        if (aIsStable || bIsStable) return 500;

        // Ambos voláteis: fee alta
        return 3000;
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
