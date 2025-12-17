/**
 * ============================================================================
 * LIQUIDATION BOT - Bot Principal de Liquidações Aave V3
 * ============================================================================
 *
 * Bot competitivo de liquidações que:
 * - Monitora posições em risco via Subgraph + On-chain
 * - Prioriza usuários por risco e lucratividade
 * - Executa liquidações com gas otimizado
 * - Envia notificações via Telegram
 * - Coleta métricas detalhadas
 *
 * OTIMIZAÇÕES DE CU:
 * - Multicall para batching (99% economia)
 * - Cache inteligente (50-70% economia)
 * - Rate limiting (evita throttling)
 * - Polling adaptativo por risco
 *
 * MODO DE SIMULAÇÃO: SIMULATION_MODE=true
 */

import { Wallet, formatUnits } from 'ethers';
import { logger } from '../logger';

// Core Services
import { RPCManager, createRPCManager } from './rpcManager';
import { GasStrategy, createGasStrategy } from './gasStrategy';
import { SubgraphService, createSubgraphService } from './subgraphService';
import { UserPrioritizer, createUserPrioritizer, PrioritizedUser, UserPosition } from './userPrioritizer';
import { RealtimeMonitor, createRealtimeMonitor } from './realtimeMonitor';
import { MetricsService, metrics } from './metrics';
import { TelegramService, createTelegramService } from './telegramService';

// Optimized Services
import { AaveServiceOptimized, createAaveServiceOptimized } from './aaveServiceOptimized';
import { CacheService, cache } from './cacheService';
import { RateLimiter, rateLimiter } from './rateLimiter';
import {
    OptimizationConfig,
    FREE_TIER_CONFIG,
    PAID_TIER_CONFIG,
    ULTRA_ECONOMY_CONFIG,
    cuTracker,
    getConfigForPlan
} from './optimizedConfig';

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface LiquidationBotConfig {
    // Mode
    simulationMode: boolean;

    // Monitoring
    monitoringIntervalMs: number;
    healthCheckIntervalMs: number;
    subgraphRefreshMs: number;

    // Execution
    minProfitUsd: number;
    maxGasPercentOfProfit: number;
    maxConcurrentLiquidations: number;

    // Alerts
    alertOnHighRiskUser: boolean;
    highRiskThreshold: number;

    // Telegram
    telegramReportIntervalMs: number;

    // CU Optimization
    optimizationPreset: 'free' | 'paid' | 'economy';
    enableCUTracking: boolean;
    cuWarningThreshold: number;
}

const DEFAULT_CONFIG: LiquidationBotConfig = {
    simulationMode: true,
    monitoringIntervalMs: 1000,
    healthCheckIntervalMs: 30000,
    subgraphRefreshMs: 60000,
    minProfitUsd: 5,
    maxGasPercentOfProfit: 0.3,
    maxConcurrentLiquidations: 3,
    alertOnHighRiskUser: true,
    highRiskThreshold: 1.05,
    telegramReportIntervalMs: 3600000,
    // CU Optimization defaults
    optimizationPreset: 'free',
    enableCUTracking: true,
    cuWarningThreshold: 0.8
};

// ============================================================================
// LIQUIDATION BOT CLASS
// ============================================================================

export class LiquidationBot {
    private config: LiquidationBotConfig;
    private optimizationConfig: OptimizationConfig;
    private isRunning: boolean = false;
    private isPaused: boolean = false;

    // Core Services
    private rpcManager: RPCManager;
    private gasStrategy!: GasStrategy;
    private subgraph: SubgraphService;
    private prioritizer: UserPrioritizer;
    private monitor: RealtimeMonitor;
    private telegram: TelegramService;

    // Optimized Services
    private aave!: AaveServiceOptimized;
    private cacheService: CacheService;
    private rateLimiterService: RateLimiter;

    // State
    private wallet?: Wallet;
    private monitoredUsers: Map<string, PrioritizedUser> = new Map();
    private pendingLiquidations: Set<string> = new Set();
    private lastBlockProcessed: number = 0;
    private monitoringInterval: NodeJS.Timeout | null = null;
    private cuCheckInterval: NodeJS.Timeout | null = null;

    constructor(config: Partial<LiquidationBotConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Get optimization config based on preset
        this.optimizationConfig = getConfigForPlan(this.config.optimizationPreset);

        // Initialize core services
        this.rpcManager = createRPCManager();
        this.subgraph = createSubgraphService();
        this.prioritizer = createUserPrioritizer();
        this.monitor = createRealtimeMonitor();
        this.telegram = createTelegramService();

        // Initialize optimization services
        this.cacheService = cache;
        this.rateLimiterService = rateLimiter;

        // Configure rate limiter based on preset
        this.rateLimiterService.updateConfig({
            maxRequestsPerSecond: this.optimizationConfig.maxRequestsPerSecond,
            maxRequestsPerMinute: this.optimizationConfig.maxRequestsPerMinute
        });

        logger.info('LiquidationBot initialized');
        logger.info(`Optimization preset: ${this.config.optimizationPreset.toUpperCase()}`);
        logger.info(`Rate limit: ${this.optimizationConfig.maxRequestsPerSecond} req/s`);
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    /**
     * Inicia o bot
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('Bot already running');
            return;
        }

        logger.info('═'.repeat(60));
        logger.info('🚀 STARTING LIQUIDATION BOT');
        logger.info('═'.repeat(60));
        logger.info(`Mode: ${this.config.simulationMode ? '🧪 SIMULATION' : '🔴 PRODUCTION'}`);
        logger.info(`Optimization: ${this.config.optimizationPreset.toUpperCase()} preset`);
        logger.info(`Rate Limit: ${this.optimizationConfig.maxRequestsPerSecond} req/s`);

        try {
            // 1. Initialize wallet if not simulation
            await this.initializeWallet();

            // 2. Initialize services (with optimization)
            await this.initializeServices();

            // 3. Start RPC health checks
            this.rpcManager.startHealthChecks(this.config.healthCheckIntervalMs);

            // 4. Connect realtime monitor
            await this.monitor.connect();

            // 5. Fetch initial users from subgraph (FREE - no CUs!)
            await this.fetchAndPrioritizeUsers();

            // 6. Setup block handler
            this.monitor.onNewBlock(async (blockNumber, timestamp) => {
                await this.onNewBlock(blockNumber, timestamp);
            });

            // 7. Start periodic monitoring (optimized)
            this.startPeriodicMonitoring();

            // 8. Start CU tracking
            if (this.config.enableCUTracking) {
                this.startCUTracking();
            }

            // 9. Start Telegram reports
            if (this.telegram.isConfigured()) {
                metrics.setTelegramCallback(async (msg) => { await this.telegram.sendMessage(msg); });
                metrics.startPeriodicReports(this.config.telegramReportIntervalMs);

                await this.telegram.notifyBotStarted({
                    simulationMode: this.config.simulationMode,
                    usersMonitored: this.monitoredUsers.size
                });
            }

            this.isRunning = true;
            logger.info('✅ Bot started successfully');
            logger.info(`📊 Monitoring ${this.monitoredUsers.size} users`);
            logger.info(`💾 Cache enabled | ⚡ Multicall enabled | 🔒 Rate limiting enabled`);

        } catch (error) {
            logger.error('Failed to start bot:', error);
            await this.telegram.notifyCriticalError(`Failed to start: ${error}`);
            throw error;
        }
    }

    /**
     * Para o bot
     */
    async stop(reason: string = 'Manual stop'): Promise<void> {
        if (!this.isRunning) return;

        logger.info(`Stopping bot: ${reason}`);

        this.isRunning = false;

        // Stop intervals
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }
        if (this.cuCheckInterval) {
            clearInterval(this.cuCheckInterval);
        }

        // Stop services
        this.rpcManager.stopHealthChecks();
        this.subgraph.stopAutoRefresh();
        await this.monitor.disconnect();
        metrics.stopPeriodicReports();
        this.cacheService.stop();

        // Log final optimization stats
        logger.info('📊 Final Optimization Stats:');
        logger.info(this.aave.getOptimizationSummary());

        // Send final report
        await this.telegram.notifyBotStopped(reason);
        await this.telegram.sendStatusReport(metrics.getSummary());

        logger.info('Bot stopped');
    }

    /**
     * Pausa/resume o bot
     */
    togglePause(): boolean {
        this.isPaused = !this.isPaused;
        logger.info(`Bot ${this.isPaused ? 'PAUSED' : 'RESUMED'}`);
        return this.isPaused;
    }

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    private async initializeWallet(): Promise<void> {
        const privateKey = process.env.PRIVATE_KEY;

        if (!this.config.simulationMode && !privateKey) {
            throw new Error('PRIVATE_KEY required for production mode');
        }

        if (privateKey) {
            const provider = await this.rpcManager.getBestProvider();
            this.wallet = new Wallet(privateKey, provider);
            logger.info(`Wallet: ${this.wallet.address}`);
        }
    }

    private async initializeServices(): Promise<void> {
        const provider = await this.rpcManager.getBestProvider();

        // Gas Strategy
        this.gasStrategy = createGasStrategy(provider);

        // Optimized Aave Service (with multicall + cache)
        this.aave = createAaveServiceOptimized(
            provider,
            this.config.simulationMode ? undefined : process.env.PRIVATE_KEY,
            this.optimizationConfig
        );

        logger.info('Initialized AaveServiceOptimized with:');
        logger.info(`  - Multicall batching (up to 100 calls per request)`);
        logger.info(`  - Cache TTL: ${this.optimizationConfig.healthFactorCacheTTL}ms for health factors`);
        logger.info(`  - Rate limiting: ${this.optimizationConfig.maxRequestsPerSecond} req/s`);

        // Update ETH price
        await this.updateEthPrice();
    }

    /**
     * Inicia monitoramento de uso de CUs
     */
    private startCUTracking(): void {
        // Log CU usage every 5 minutes
        this.cuCheckInterval = setInterval(() => {
            const cuStats = cuTracker.getStats();
            const cacheStats = this.cacheService.getStats();

            logger.info(`📊 CU Usage: ${cuStats.usedThisHour.toLocaleString()}/${this.optimizationConfig.hourlyCUBudget.toLocaleString()}/h (${cuStats.percentUsedThisHour.toFixed(1)}%)`);
            logger.info(`💾 Cache: ${cacheStats.entries} entries | ${cacheStats.hitRate}% hit rate`);

            // Alerta se estiver perto do limite
            if (cuTracker.isNearLimit()) {
                logger.warn('⚠️ Approaching CU budget limit!');
                this.telegram.sendMessage(`⚠️ *CU BUDGET WARNING*\n${cuTracker.getSummary()}`);
            }
        }, 300000); // 5 minutos
    }

    private async updateEthPrice(): Promise<void> {
        try {
            // WETH address on Arbitrum
            const wethAddress = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
            const price = await this.aave.getAssetPrice(wethAddress);
            this.gasStrategy.updateEthPrice(price);
        } catch (error) {
            logger.warn('Failed to update ETH price, using default');
        }
    }

    // ========================================================================
    // USER MONITORING
    // ========================================================================

    /**
     * Busca e prioriza usuários (OTIMIZADO)
     * Usa Subgraph (GRÁTIS) + Multicall (1 CU por 100 usuários)
     */
    private async fetchAndPrioritizeUsers(): Promise<void> {
        logger.debug('Fetching users from subgraph (FREE)...');

        // 1. Subgraph é GRÁTIS - não consome CUs
        const subgraphUsers = await this.subgraph.fetchAllUsers();

        // 2. Filtra usuários relevantes
        const addresses = subgraphUsers
            .filter(u => parseFloat(u.totalBorrowsUSD) >= 100)
            .map(u => u.id);

        // 3. Busca health factors via MULTICALL OTIMIZADO
        // 500 usuários = apenas ~5 chamadas RPC = ~130 CUs (ao invés de 13,000 CUs)
        const healthFactors = await this.aave.getMultipleHealthFactorsOptimized(
            addresses.slice(0, 500)
        );

        // 4. Converte para UserPosition
        const positions: UserPosition[] = subgraphUsers.map(u => {
            const hf = healthFactors.get(u.id.toLowerCase()) || Infinity;

            return {
                address: u.id,
                healthFactor: hf,
                totalDebtUsd: parseFloat(u.totalBorrowsUSD),
                totalCollateralUsd: parseFloat(u.totalCollateralUSD),
                collateralAssets: [],
                debtAssets: []
            };
        });

        // 5. Prioriza
        const prioritized = this.prioritizer.prioritizeUsers(positions);

        // 6. Atualiza cache local
        this.monitoredUsers.clear();
        for (const user of prioritized) {
            this.monitoredUsers.set(user.address.toLowerCase(), user);
        }

        // 7. Atualiza métricas
        const stats = this.prioritizer.getStats(prioritized);
        metrics.updateUserCounts(stats.total, stats.high + stats.critical, stats.liquidatable);

        logger.info(`Prioritized ${prioritized.length} users (${stats.liquidatable} liquidatable)`);
        logger.debug(`CU efficient: Used multicall for ${addresses.length} users`);
    }

    /**
     * Monitoramento periódico de usuários de alto risco
     */
    private startPeriodicMonitoring(): void {
        this.monitoringInterval = setInterval(async () => {
            if (!this.isRunning || this.isPaused) return;

            await this.monitorHighRiskUsers();
        }, this.config.monitoringIntervalMs);

        // Atualiza lista de usuários periodicamente
        setInterval(async () => {
            if (!this.isRunning) return;
            await this.fetchAndPrioritizeUsers();
        }, this.config.subgraphRefreshMs);
    }

    /**
     * Monitora usuários de alto risco (OTIMIZADO com Multicall)
     */
    private async monitorHighRiskUsers(): Promise<void> {
        const highRiskUsers = Array.from(this.monitoredUsers.values())
            .filter(u => u.riskLevel === 'critical' || u.riskLevel === 'high');

        if (highRiskUsers.length === 0) return;

        // OTIMIZAÇÃO: Usa multicall para buscar todos os HFs de uma vez
        // 20 usuários = 1 chamada RPC = ~26 CUs (ao invés de ~520 CUs)
        const addresses = highRiskUsers.slice(0, 20).map(u => u.address);

        try {
            const healthFactors = await this.aave.getMultipleHealthFactorsOptimized(addresses);

            // Atualiza cache e verifica liquidações
            for (const user of highRiskUsers.slice(0, 20)) {
                const newHf = healthFactors.get(user.address.toLowerCase());
                if (newHf === undefined) continue;

                // Atualiza no cache
                const cached = this.monitoredUsers.get(user.address.toLowerCase());
                if (cached) {
                    cached.healthFactor = newHf;
                    cached.liquidatable = newHf < 1.0;
                }

                // Verifica liquidação
                if (newHf < 1.0 && !this.pendingLiquidations.has(user.address.toLowerCase())) {
                    await this.handleLiquidationOpportunity(user);
                }
            }
        } catch (error) {
            logger.error('Error monitoring high risk users:', error);
        }
    }

    // ========================================================================
    // BLOCK PROCESSING
    // ========================================================================

    /**
     * Handler de novo bloco
     */
    private async onNewBlock(blockNumber: number, timestamp: number): Promise<void> {
        if (!this.isRunning || this.isPaused) return;
        if (blockNumber <= this.lastBlockProcessed) return;

        const startTime = Date.now();
        this.lastBlockProcessed = blockNumber;

        try {
            // Verifica usuários críticos
            const criticalUsers = Array.from(this.monitoredUsers.values())
                .filter(u => u.riskLevel === 'critical');

            for (const user of criticalUsers) {
                if (this.pendingLiquidations.has(user.address.toLowerCase())) continue;

                try {
                    const canLiquidate = await this.aave.canBeLiquidated(user.address);
                    if (canLiquidate) {
                        await this.handleLiquidationOpportunity(user);
                    }
                } catch {
                    // Ignora erros individuais
                }
            }
        } catch (error) {
            logger.error(`Block ${blockNumber} processing error:`, error);
        }

        metrics.recordBlockProcessing(Date.now() - startTime);
    }

    // ========================================================================
    // LIQUIDATION EXECUTION
    // ========================================================================

    /**
     * Processa oportunidade de liquidação
     */
    private async handleLiquidationOpportunity(user: PrioritizedUser): Promise<void> {
        const userKey = user.address.toLowerCase();

        // Evita duplicatas
        if (this.pendingLiquidations.has(userKey)) return;
        if (this.pendingLiquidations.size >= this.config.maxConcurrentLiquidations) return;

        this.pendingLiquidations.add(userKey);
        metrics.recordOpportunityFound();

        const startTime = Date.now();

        try {
            logger.info(`\n${'═'.repeat(50)}`);
            logger.info(`🎯 LIQUIDATION OPPORTUNITY`);
            logger.info(`User: ${user.address}`);
            logger.info(`HF: ${user.healthFactor.toFixed(4)}`);
            logger.info(`Debt: $${user.totalDebtUsd.toFixed(2)}`);
            logger.info(`Est. Profit: $${user.estimatedProfit.toFixed(2)}`);
            logger.info(`${'═'.repeat(50)}`);

            // Busca posição completa
            const position = await this.aave.getUserPosition(user.address);

            // Verifica se ainda é liquidável
            if (position.healthFactor >= 1.0) {
                logger.info('User no longer liquidatable (HF recovered)');
                return;
            }

            // Calcula parâmetros de liquidação
            const params = await this.aave.calculateLiquidationParams(user.address);
            if (!params) {
                logger.warn('Could not calculate liquidation params');
                return;
            }

            // Calcula gas
            const gasEstimate = await this.gasStrategy.calculateOptimalGas(
                user.estimatedProfit,
                'high'
            );

            if (!gasEstimate.isViable) {
                logger.info(`Gas too expensive: $${gasEstimate.estimatedCostUsd.toFixed(4)} > ${this.config.maxGasPercentOfProfit * 100}% of profit`);
                metrics.recordOpportunitySkipped();
                return;
            }

            // Notifica oportunidade
            await this.telegram.notifyOpportunityFound({
                userAddress: user.address,
                healthFactor: position.healthFactor,
                debtUsd: position.totalDebtUsd,
                collateralUsd: position.totalCollateralUsd,
                estimatedProfit: user.estimatedProfit
            });

            // Executa ou simula
            if (this.config.simulationMode) {
                await this.simulateLiquidation(user, params, gasEstimate);
            } else {
                await this.executeLiquidation(user, params, gasEstimate);
            }

        } catch (error: any) {
            const executionTime = Date.now() - startTime;
            const isLostToCompetitor = error.message?.includes('cannot liquidate') ||
                                        error.message?.includes('health factor');

            logger.error(`Liquidation failed: ${error.message}`);

            metrics.recordLiquidationAttempt(
                false,
                isLostToCompetitor,
                0,
                0,
                executionTime,
                { userAddress: user.address, error: error.message }
            );

            await this.telegram.notifyLiquidationFailed({
                userAddress: user.address,
                reason: error.message,
                lostToCompetitor: isLostToCompetitor
            });

        } finally {
            this.pendingLiquidations.delete(userKey);
        }
    }

    /**
     * Simula liquidação (dry run)
     */
    private async simulateLiquidation(
        user: PrioritizedUser,
        params: any,
        gasEstimate: any
    ): Promise<void> {
        logger.info('🧪 SIMULATION MODE - Would execute liquidation:');
        logger.info(`  Collateral: ${params.collateralAsset}`);
        logger.info(`  Debt: ${params.debtAsset}`);
        logger.info(`  Amount: ${formatUnits(params.debtToCover, 18)}`);
        logger.info(`  Gas: $${gasEstimate.estimatedCostUsd.toFixed(4)}`);

        // Simula chamada
        const simulation = await this.aave.simulateLiquidation(params);

        if (simulation.success) {
            logger.info(`✅ Simulation successful! Gas: ${simulation.estimatedGas}`);

            metrics.recordLiquidationAttempt(
                true,
                false,
                user.estimatedProfit,
                gasEstimate.estimatedCostUsd,
                0,
                { userAddress: user.address, txHash: 'SIMULATION' }
            );
        } else {
            logger.warn(`❌ Simulation failed: ${simulation.error}`);
        }
    }

    /**
     * Executa liquidação real
     */
    private async executeLiquidation(
        user: PrioritizedUser,
        params: any,
        gasEstimate: any
    ): Promise<void> {
        const startTime = Date.now();

        try {
            logger.info('🔴 EXECUTING REAL LIQUIDATION...');

            const txHash = await this.aave.executeLiquidation(params);
            const executionTime = Date.now() - startTime;

            logger.info(`✅ Liquidation executed! TX: ${txHash}`);

            metrics.recordLiquidationAttempt(
                true,
                false,
                user.estimatedProfit,
                gasEstimate.estimatedCostUsd,
                executionTime,
                {
                    userAddress: user.address,
                    txHash,
                    collateralAsset: params.collateralAsset,
                    debtAsset: params.debtAsset
                }
            );

            await this.telegram.notifyLiquidationSuccess({
                userAddress: user.address,
                txHash,
                debtRepaid: user.totalDebtUsd * 0.5,
                collateralReceived: user.totalDebtUsd * 0.5 * 1.05,
                profitUsd: user.estimatedProfit,
                gasCostUsd: gasEstimate.estimatedCostUsd
            });

        } catch (error: any) {
            throw error;
        }
    }

    // ========================================================================
    // STATUS & METRICS
    // ========================================================================

    /**
     * Retorna status do bot
     */
    getStatus(): {
        isRunning: boolean;
        isPaused: boolean;
        simulationMode: boolean;
        optimizationPreset: string;
        usersMonitored: number;
        pendingLiquidations: number;
        lastBlock: number;
        rpcStatus: any;
        monitorStatus: any;
        cuUsage: any;
        cacheStats: any;
    } {
        return {
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            simulationMode: this.config.simulationMode,
            optimizationPreset: this.config.optimizationPreset,
            usersMonitored: this.monitoredUsers.size,
            pendingLiquidations: this.pendingLiquidations.size,
            lastBlock: this.lastBlockProcessed,
            rpcStatus: this.rpcManager.getStatus(),
            monitorStatus: this.monitor.getStatus(),
            cuUsage: cuTracker.getStats(),
            cacheStats: this.cacheService.getStats()
        };
    }

    /**
     * Retorna métricas
     */
    getMetrics(): any {
        return {
            ...metrics.getMetrics(),
            userDistribution: this.prioritizer.getStats(),
            optimization: this.aave.getOptimizationStats(),
            cuUsage: cuTracker.getStats(),
            cache: this.cacheService.getStats(),
            rateLimiter: this.rateLimiterService.getStats()
        };
    }

    /**
     * Retorna resumo para Telegram
     */
    getSummary(): string {
        return metrics.getSummary() + '\n\n' + this.aave.getOptimizationSummary();
    }

    /**
     * Retorna resumo de otimização
     */
    getOptimizationSummary(): string {
        return this.aave.getOptimizationSummary();
    }
}

// ============================================================================
// FACTORY & MAIN
// ============================================================================

export function createLiquidationBot(
    config: Partial<LiquidationBotConfig> = {}
): LiquidationBot {
    // Determina preset de otimização
    const presetEnv = process.env.OPTIMIZATION_PRESET as 'free' | 'paid' | 'economy' | undefined;
    const optimizationPreset = presetEnv || 'free';

    return new LiquidationBot({
        simulationMode: process.env.SIMULATION_MODE !== 'false',
        minProfitUsd: parseFloat(process.env.MIN_PROFIT_USD || '5'),
        optimizationPreset,
        enableCUTracking: process.env.ENABLE_CU_TRACKING !== 'false',
        ...config
    });
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
    const bot = createLiquidationBot();

    // Graceful shutdown
    process.on('SIGINT', async () => {
        await bot.stop('SIGINT received');
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await bot.stop('SIGTERM received');
        process.exit(0);
    });

    await bot.start();
}

// Run if called directly
if (require.main === module) {
    main().catch(error => {
        logger.error('Fatal error:', error);
        process.exit(1);
    });
}
