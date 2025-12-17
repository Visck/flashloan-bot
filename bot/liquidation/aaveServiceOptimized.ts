/**
 * ============================================================================
 * AAVE SERVICE OPTIMIZED - Versão Otimizada para Economia de CUs
 * ============================================================================
 *
 * Estende o AaveService com:
 * - Multicall para batching de chamadas
 * - Cache inteligente
 * - Rate limiting integrado
 *
 * ECONOMIA ESTIMADA: 80-90% de redução em CUs
 */

import { JsonRpcProvider, Wallet, formatUnits, Interface } from 'ethers';
import { logger } from '../logger';
import { AaveService, AAVE_V3_ADDRESSES, UserAccountData, ReserveData } from './aaveService';
import { MulticallService, createMulticallService } from './multicallService';
import { CacheService, cache } from './cacheService';
import { RateLimiter, rateLimiter } from './rateLimiter';
import { cuTracker, CU_COSTS, OptimizationConfig, FREE_TIER_CONFIG } from './optimizedConfig';

// ============================================================================
// ABIs para Multicall
// ============================================================================

const POOL_INTERFACE = new Interface([
    'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'
]);

const ORACLE_INTERFACE = new Interface([
    'function getAssetPrice(address asset) view returns (uint256)'
]);

// ============================================================================
// OPTIMIZED AAVE SERVICE CLASS
// ============================================================================

export class AaveServiceOptimized extends AaveService {
    private multicall: MulticallService;
    private cacheService: CacheService;
    private rateLimiter: RateLimiter;
    private config: OptimizationConfig;

    // Estatísticas
    private stats = {
        callsSaved: 0,
        cusUsed: 0,
        cusSaved: 0,
        cacheHits: 0,
        cacheMisses: 0
    };

    constructor(
        provider: JsonRpcProvider,
        wallet?: Wallet,
        config: OptimizationConfig = FREE_TIER_CONFIG
    ) {
        super(provider, wallet);
        this.multicall = createMulticallService(provider);
        this.cacheService = cache;
        this.rateLimiter = rateLimiter;
        this.config = config;

        // Configura rate limiter
        this.rateLimiter.updateConfig({
            maxRequestsPerSecond: config.maxRequestsPerSecond,
            maxRequestsPerMinute: config.maxRequestsPerMinute
        });
    }

    // ========================================================================
    // OTIMIZADO: Health Factors em Batch
    // ========================================================================

    /**
     * Busca health factors de múltiplos usuários usando multicall
     * ECONOMIA: 100 usuários = 1 chamada RPC = ~26 CUs
     * (vs 100 chamadas = ~2600 CUs sem otimização)
     */
    async getMultipleHealthFactorsOptimized(
        addresses: string[]
    ): Promise<Map<string, number>> {
        const results = new Map<string, number>();
        if (addresses.length === 0) return results;

        // 1. Verifica cache primeiro
        const uncached: string[] = [];
        for (const addr of addresses) {
            const cached = this.cacheService.getHealthFactor(addr);
            if (cached !== null) {
                results.set(addr.toLowerCase(), cached);
                this.stats.cacheHits++;
            } else {
                uncached.push(addr);
                this.stats.cacheMisses++;
            }
        }

        if (uncached.length === 0) {
            logger.debug(`All ${addresses.length} health factors from cache`);
            return results;
        }

        // 2. Busca via multicall os não cacheados
        const cusBefore = addresses.length * CU_COSTS.eth_call;

        try {
            await this.rateLimiter.execute(async () => {
                const healthFactors = await this.multicall.getMultipleHealthFactors(
                    AAVE_V3_ADDRESSES.POOL,
                    uncached
                );

                for (const [addr, hfBigInt] of healthFactors) {
                    const hf = parseFloat(formatUnits(hfBigInt, 18));
                    results.set(addr, hf);

                    // Salva no cache
                    this.cacheService.setHealthFactor(addr, hf);
                }
            });

            // Registra economia
            const cusUsed = CU_COSTS.multicall;
            const cusSaved = cusBefore - cusUsed;
            this.stats.cusUsed += cusUsed;
            this.stats.cusSaved += cusSaved;
            this.stats.callsSaved += uncached.length - 1;

            cuTracker.record(cusUsed);

            logger.debug(
                `Fetched ${uncached.length} health factors via multicall. ` +
                `Saved ${cusSaved} CUs (${((cusSaved / cusBefore) * 100).toFixed(0)}%)`
            );

        } catch (error) {
            logger.error('Multicall health factors failed:', error);
            // Fallback para chamadas individuais (mais lento, mais caro)
            await this.fallbackGetHealthFactors(uncached, results);
        }

        return results;
    }

    /**
     * Fallback: busca individual com rate limiting
     */
    private async fallbackGetHealthFactors(
        addresses: string[],
        results: Map<string, number>
    ): Promise<void> {
        for (const addr of addresses) {
            try {
                await this.rateLimiter.execute(async () => {
                    const data = await super.getUserAccountData(addr);
                    const hf = parseFloat(formatUnits(data.healthFactor, 18));
                    results.set(addr.toLowerCase(), hf);
                    this.cacheService.setHealthFactor(addr, hf);
                    cuTracker.record(CU_COSTS.eth_call);
                });
            } catch {
                // Ignora erros individuais
            }
        }
    }

    // ========================================================================
    // OTIMIZADO: Verificação de Liquidáveis
    // ========================================================================

    /**
     * Verifica quais usuários podem ser liquidados
     * Usa cache e multicall para máxima eficiência
     */
    async checkLiquidatableOptimized(
        addresses: string[]
    ): Promise<Map<string, boolean>> {
        const healthFactors = await this.getMultipleHealthFactorsOptimized(addresses);
        const liquidatable = new Map<string, boolean>();

        for (const [addr, hf] of healthFactors) {
            liquidatable.set(addr, hf < 1.0);
        }

        return liquidatable;
    }

    /**
     * Filtra apenas usuários liquidáveis (HF < 1.0)
     */
    async filterLiquidatable(addresses: string[]): Promise<string[]> {
        const liquidatable = await this.checkLiquidatableOptimized(addresses);
        return Array.from(liquidatable.entries())
            .filter(([_, isLiq]) => isLiq)
            .map(([addr]) => addr);
    }

    // ========================================================================
    // OTIMIZADO: Preços
    // ========================================================================

    /**
     * Busca preços de múltiplos tokens via multicall
     */
    async getMultiplePricesOptimized(
        tokenAddresses: string[]
    ): Promise<Map<string, number>> {
        const results = new Map<string, number>();
        if (tokenAddresses.length === 0) return results;

        // 1. Verifica cache
        const uncached: string[] = [];
        for (const addr of tokenAddresses) {
            const cached = this.cacheService.getPrice(addr);
            if (cached !== null) {
                results.set(addr.toLowerCase(), cached);
                this.stats.cacheHits++;
            } else {
                uncached.push(addr);
                this.stats.cacheMisses++;
            }
        }

        if (uncached.length === 0) return results;

        // 2. Busca via multicall
        try {
            await this.rateLimiter.execute(async () => {
                const prices = await this.multicall.getMultiplePrices(
                    AAVE_V3_ADDRESSES.ORACLE,
                    uncached
                );

                for (const [addr, priceBigInt] of prices) {
                    const price = parseFloat(formatUnits(priceBigInt, 8));
                    results.set(addr, price);
                    this.cacheService.setPrice(addr, price);
                }
            });

            cuTracker.record(CU_COSTS.multicall);

        } catch (error) {
            logger.error('Multicall prices failed:', error);
        }

        return results;
    }

    // ========================================================================
    // OTIMIZADO: Account Data com Cache
    // ========================================================================

    /**
     * Busca dados de conta com cache
     */
    async getUserAccountDataCached(userAddress: string): Promise<UserAccountData> {
        const cacheKey = `accountData:${userAddress.toLowerCase()}`;
        const cached = this.cacheService.get<UserAccountData>(cacheKey);

        if (cached) {
            this.stats.cacheHits++;
            return cached;
        }

        this.stats.cacheMisses++;

        const data = await this.rateLimiter.execute(async () => {
            cuTracker.record(CU_COSTS.eth_call);
            return super.getUserAccountData(userAddress);
        });

        this.cacheService.set(cacheKey, data, this.config.healthFactorCacheTTL);
        return data;
    }

    // ========================================================================
    // OTIMIZADO: Reserve Config com Cache Longo
    // ========================================================================

    /**
     * Busca configuração de reserva (cache longo - raramente muda)
     */
    async getReserveConfigCached(assetAddress: string): Promise<ReserveData | null> {
        const cached = this.cacheService.getReserveConfig(assetAddress);
        if (cached) {
            this.stats.cacheHits++;
            return cached;
        }

        this.stats.cacheMisses++;

        const config = await this.rateLimiter.execute(async () => {
            cuTracker.record(CU_COSTS.eth_call);
            return super.getReserveConfig(assetAddress);
        });

        if (config) {
            this.cacheService.setReserveConfig(assetAddress, config);
        }

        return config;
    }

    // ========================================================================
    // SMART MONITORING
    // ========================================================================

    /**
     * Monitora usuários de forma inteligente baseado em risco
     * Usuários de alto risco são verificados mais frequentemente
     */
    async smartMonitor(
        criticalUsers: string[],   // HF < 1.0 - verificar sempre
        highRiskUsers: string[],   // HF < 1.05 - verificar frequentemente
        mediumRiskUsers: string[], // HF < 1.15 - verificar ocasionalmente
        lowRiskUsers: string[]     // HF >= 1.15 - verificar raramente
    ): Promise<Map<string, number>> {
        const results = new Map<string, number>();

        // Sempre verifica críticos (fresh data)
        if (criticalUsers.length > 0) {
            const criticalHFs = await this.getMultipleHealthFactorsOptimized(criticalUsers);
            for (const [addr, hf] of criticalHFs) {
                results.set(addr, hf);
            }
        }

        // Verifica alto risco (usa cache curto)
        if (highRiskUsers.length > 0) {
            const highRiskHFs = await this.getMultipleHealthFactorsOptimized(highRiskUsers);
            for (const [addr, hf] of highRiskHFs) {
                results.set(addr, hf);
            }
        }

        // Médio risco - usa cache mais longo, não força refresh
        for (const addr of mediumRiskUsers) {
            const cached = this.cacheService.getHealthFactor(addr);
            if (cached !== null) {
                results.set(addr.toLowerCase(), cached);
            }
        }

        // Baixo risco - só usa cache
        for (const addr of lowRiskUsers) {
            const cached = this.cacheService.getHealthFactor(addr);
            if (cached !== null) {
                results.set(addr.toLowerCase(), cached);
            }
        }

        return results;
    }

    // ========================================================================
    // STATISTICS
    // ========================================================================

    /**
     * Retorna estatísticas de otimização
     */
    getOptimizationStats(): {
        callsSaved: number;
        cusUsed: number;
        cusSaved: number;
        savingsPercent: number;
        cacheHitRate: number;
        cuTracker: ReturnType<typeof cuTracker.getStats>;
        rateLimiter: ReturnType<typeof rateLimiter.getStats>;
        cache: ReturnType<typeof cache.getStats>;
    } {
        const totalCalls = this.stats.cacheHits + this.stats.cacheMisses;
        const cacheHitRate = totalCalls > 0
            ? (this.stats.cacheHits / totalCalls) * 100
            : 0;

        const totalCUs = this.stats.cusUsed + this.stats.cusSaved;
        const savingsPercent = totalCUs > 0
            ? (this.stats.cusSaved / totalCUs) * 100
            : 0;

        return {
            ...this.stats,
            savingsPercent: Math.round(savingsPercent * 100) / 100,
            cacheHitRate: Math.round(cacheHitRate * 100) / 100,
            cuTracker: cuTracker.getStats(),
            rateLimiter: rateLimiter.getStats(),
            cache: cache.getStats()
        };
    }

    /**
     * Retorna resumo formatado
     */
    getOptimizationSummary(): string {
        const stats = this.getOptimizationStats();
        return `
📊 *OTIMIZAÇÃO DE CUs*
═══════════════════════════
💾 *Cache:*
   Hit Rate: ${stats.cacheHitRate}%
   Entries: ${stats.cache.entries}

⚡ *Multicall:*
   Calls Saved: ${stats.callsSaved}
   CUs Saved: ${stats.cusSaved.toLocaleString()}
   Savings: ${stats.savingsPercent}%

📈 *Rate Limiter:*
   Throttled: ${stats.rateLimiter.throttleRate}%
   Queue: ${stats.rateLimiter.currentQueueSize}

💰 *CU Budget:*
   ${cuTracker.getSummary()}
═══════════════════════════
        `.trim();
    }

    /**
     * Reset estatísticas
     */
    resetStats(): void {
        this.stats = {
            callsSaved: 0,
            cusUsed: 0,
            cusSaved: 0,
            cacheHits: 0,
            cacheMisses: 0
        };
    }

    /**
     * Atualiza configuração
     */
    setOptimizationConfig(config: OptimizationConfig): void {
        this.config = config;
        this.rateLimiter.updateConfig({
            maxRequestsPerSecond: config.maxRequestsPerSecond,
            maxRequestsPerMinute: config.maxRequestsPerMinute
        });
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createAaveServiceOptimized(
    provider: JsonRpcProvider,
    privateKey?: string,
    config?: OptimizationConfig
): AaveServiceOptimized {
    let wallet: Wallet | undefined;
    if (privateKey) {
        wallet = new Wallet(privateKey, provider);
    }
    return new AaveServiceOptimized(provider, wallet, config);
}
