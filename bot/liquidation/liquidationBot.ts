import dotenv from 'dotenv';
dotenv.config(); // DEVE ser chamado ANTES de qualquer import que use process.env

import { ethers, JsonRpcProvider, Wallet } from 'ethers';
import { logger, logOpportunity, logExecution } from '../services/logger';
import { MultiRpcProvider } from '../services/rpcProvider';
import { telegram } from '../services/telegram';
import { CHAINS, BOT_CONFIG, ChainConfig, OPTIMIZATION_CONFIG } from './liquidationConfig';
import { AaveService, LiquidationOpportunity } from './aaveService';
import { createLendingService } from './radiantService';
import { UserDiscovery } from './userDiscovery';

// Optimization modules
import { SubgraphService, createSubgraphService } from './subgraphService';
import { cache } from './cacheService';
import { rateLimiter } from './rateLimiter';
import { cuTracker, getConfigForPlan } from './optimizedConfig';

interface ProtocolContext {
    service: AaveService;
    discovery: UserDiscovery;
    name: string;
}

class LiquidationBot {
    private provider!: JsonRpcProvider;
    private multiRpc!: MultiRpcProvider;
    private wallet: Wallet | null = null;
    private chainConfig: ChainConfig;
    private protocols: ProtocolContext[] = [];
    private isRunning: boolean = false;

    // Optimization services
    private subgraphService?: SubgraphService;
    private cuTrackingInterval?: NodeJS.Timeout;
    private useSubgraph: boolean = OPTIMIZATION_CONFIG.useSubgraph;

    // Classified users by risk level
    private classifiedUsers = {
        critical: [] as string[],
        highRisk: [] as string[],
        mediumRisk: [] as string[],
        lowRisk: [] as string[],
    };

    private stats = {
        cyclesRun: 0,
        usersChecked: 0,
        opportunitiesFound: 0,
        liquidationsExecuted: 0,
        totalProfitUsd: 0,
        startTime: Date.now(),
        rpcFailovers: 0,
        // Optimization stats
        cusSaved: 0,
        cacheHits: 0,
        subgraphUsers: 0,
    };

    constructor(chain: string = 'arbitrum') {
        const config = CHAINS[chain];
        if (!config) {
            throw new Error(`Chain ${chain} not supported`);
        }

        this.chainConfig = config;

        // Configure optimization based on preset
        const optimConfig = getConfigForPlan(OPTIMIZATION_CONFIG.preset);
        rateLimiter.updateConfig({
            maxRequestsPerSecond: optimConfig.maxRequestsPerSecond,
            maxRequestsPerMinute: optimConfig.maxRequestsPerMinute,
        });

        logger.info(`Optimization preset: ${OPTIMIZATION_CONFIG.preset}`);
        logger.info(`Using Subgraph for discovery: ${this.useSubgraph}`);
    }

    private async initializeRpc(): Promise<void> {
        // Inicializa sistema de multi-RPC com failover
        this.multiRpc = new MultiRpcProvider();
        this.provider = await this.multiRpc.initialize();

        // Log RPC status
        const rpcStatus = this.multiRpc.getStatus();
        logger.info('RPC Endpoints:');
        rpcStatus.forEach((rpc, i) => {
            const status = rpc.healthy ? '✅' : '❌';
            const latency = rpc.healthy ? `${rpc.latency}ms` : 'DOWN';
            logger.info(`  ${i + 1}. ${rpc.name}: ${status} ${latency}`);
        });
        logger.info(`Active RPC: ${this.multiRpc.getCurrentEndpoint()}`);

        // Inicializa wallet se nao estiver em modo simulacao
        if (!BOT_CONFIG.simulationMode && process.env.PRIVATE_KEY) {
            this.wallet = new Wallet(process.env.PRIVATE_KEY, this.provider);
            logger.info(`Wallet initialized: ${this.wallet.address}`);
        }
    }

    async initialize(): Promise<void> {
        logger.info('='.repeat(60));
        logger.info('LIQUIDATION BOT - INITIALIZING');
        logger.info('='.repeat(60));
        logger.info(`Chain: ${this.chainConfig.name}`);
        logger.info(`Mode: ${BOT_CONFIG.simulationMode ? 'SIMULATION' : 'LIVE'}`);
        logger.info(`Min Profit: $${BOT_CONFIG.minProfitUsd}`);
        logger.info(`Polling Interval: ${BOT_CONFIG.pollingIntervalMs}ms`);
        logger.info('='.repeat(60));

        // Inicializa sistema Multi-RPC
        await this.initializeRpc();

        // Verifica conexao
        const blockNumber = await this.provider.getBlockNumber();
        logger.info(`Connected to ${this.chainConfig.name} at block ${blockNumber}`);

        // Inicializa cada protocolo habilitado
        for (const protocolConfig of this.chainConfig.protocols) {
            if (!protocolConfig.enabled) {
                logger.info(`Skipping disabled protocol: ${protocolConfig.name}`);
                continue;
            }

            try {
                const service = createLendingService(this.provider, protocolConfig);
                await service.initialize();

                // Usa o WebSocket do MultiRPC se disponivel
                const wssProvider = this.multiRpc.getWssProvider();
                const discovery = new UserDiscovery(
                    this.provider,
                    protocolConfig.poolAddress,
                    protocolConfig.name,
                    wssProvider ? undefined : this.chainConfig.wssUrl // Passa URL apenas se nao tiver provider
                );

                this.protocols.push({
                    service,
                    discovery,
                    name: protocolConfig.name,
                });

                logger.info(`Protocol ${protocolConfig.name} initialized successfully`);
            } catch (error) {
                logger.error(`Failed to initialize ${protocolConfig.name}: ${error}`);
            }
        }

        if (this.protocols.length === 0) {
            throw new Error('No protocols initialized successfully');
        }

        logger.info(`Initialized ${this.protocols.length} protocols`);

        // Initialize SubgraphService for FREE user discovery
        if (this.useSubgraph) {
            try {
                this.subgraphService = createSubgraphService();
                logger.info('SubgraphService initialized (FREE user discovery)');
            } catch (error) {
                logger.warn(`Failed to initialize SubgraphService: ${error}`);
                logger.info('Falling back to event-based discovery');
                this.useSubgraph = false;
            }
        }
    }

    async discoverUsers(): Promise<void> {
        logger.info('Discovering users with active positions...');

        // Use SubgraphService if enabled (FREE - no CUs!)
        if (this.useSubgraph && this.subgraphService) {
            try {
                logger.info('📊 Using Subgraph for FREE user discovery...');
                const users = await this.subgraphService.fetchAllUsers();
                this.stats.subgraphUsers = users.length;

                // Add discovered users to all protocols
                for (const protocol of this.protocols) {
                    for (const user of users) {
                        protocol.discovery.addUser(user.id);
                    }
                    logger.info(`${protocol.name}: ${protocol.discovery.getUserCount()} users from Subgraph (0 CUs used!)`);
                }

                // Classify users by risk from subgraph data
                await this.classifyUsersFromSubgraph(users);

                return;
            } catch (error) {
                logger.warn(`Subgraph discovery failed: ${error}`);
                logger.info('Falling back to event-based discovery...');
            }
        }

        // Fallback: Event-based discovery (uses CUs)
        for (const protocol of this.protocols) {
            try {
                await protocol.discovery.discoverFromRecentBlocks(5000);
                logger.info(`${protocol.name}: ${protocol.discovery.getUserCount()} users discovered`);
            } catch (error) {
                logger.error(`Failed to discover users for ${protocol.name}: ${error}`);
            }
        }
    }

    /**
     * Classifica usuários por risco usando dados do Subgraph
     * Isso evita chamadas RPC para classificação inicial
     */
    private async classifyUsersFromSubgraph(users: any[]): Promise<void> {
        this.classifiedUsers = {
            critical: [],
            highRisk: [],
            mediumRisk: [],
            lowRisk: [],
        };

        for (const user of users) {
            // Subgraph não retorna health factor diretamente, então
            // precisamos calcular baseado em totalCollateral e totalDebt
            // ou buscar via RPC apenas para usuários de alto valor
            const hasDebt = user.reserves?.some((r: any) =>
                parseFloat(r.currentTotalDebt || '0') > 0
            );

            if (hasDebt) {
                // Adiciona à lista de alto risco para verificação via RPC
                this.classifiedUsers.highRisk.push(user.id);
            } else {
                this.classifiedUsers.lowRisk.push(user.id);
            }
        }

        logger.info(`Classified from Subgraph: ${this.classifiedUsers.highRisk.length} with debt, ${this.classifiedUsers.lowRisk.length} collateral-only`);
    }

    async startRealTimeDiscovery(): Promise<void> {
        for (const protocol of this.protocols) {
            try {
                await protocol.discovery.startRealTimeDiscovery();
            } catch (error) {
                logger.warn(`Failed to start real-time discovery for ${protocol.name}: ${error}`);
            }
        }
    }

    async checkForOpportunities(): Promise<LiquidationOpportunity[]> {
        const opportunities: LiquidationOpportunity[] = [];

        for (const protocol of this.protocols) {
            const users = protocol.discovery.getKnownUsers();

            if (users.length === 0) {
                continue;
            }

            // Divide em batches
            const batchSize = BOT_CONFIG.maxUsersPerBatch;
            const batches: string[][] = [];
            for (let i = 0; i < users.length; i += batchSize) {
                batches.push(users.slice(i, i + batchSize));
            }

            // Processa batches usando método OTIMIZADO (com cache e rate limiting)
            // Menos batches em paralelo para respeitar rate limits
            const PARALLEL_BATCHES = OPTIMIZATION_CONFIG.preset === 'free' ? 3 : 10;

            for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
                const parallelBatches = batches.slice(i, i + PARALLEL_BATCHES);

                const results = await Promise.allSettled(
                    parallelBatches.map(async (batch) => {
                        try {
                            // Usa método otimizado com cache
                            return await protocol.service.getBatchUserAccountDataOptimized(batch);
                        } catch (error) {
                            return [];
                        }
                    })
                );

                // Processa resultados
                for (const result of results) {
                    if (result.status === 'fulfilled' && result.value) {
                        const accountsData = result.value;
                        this.stats.usersChecked += accountsData.length;

                        for (const accountData of accountsData) {
                            if (accountData.healthFactorNum < BOT_CONFIG.healthFactorThreshold) {
                                const opportunity = await protocol.service.calculateLiquidationOpportunity(
                                    accountData.user,
                                    accountData
                                );

                                if (opportunity && opportunity.netProfitUsd >= BOT_CONFIG.minProfitUsd) {
                                    opportunities.push(opportunity);

                                    logOpportunity({
                                        protocol: opportunity.protocol,
                                        user: opportunity.user,
                                        healthFactor: opportunity.healthFactor,
                                        profitUsd: opportunity.netProfitUsd,
                                        debtAsset: opportunity.debtSymbol,
                                        collateralAsset: opportunity.collateralSymbol,
                                    });
                                }
                            }
                        }
                    }
                }
            }

            // Update optimization stats
            const optStats = protocol.service.getOptimizationStats();
            this.stats.cusSaved += optStats.cusSaved;
            this.stats.cacheHits += optStats.cacheHits;
        }

        return opportunities;
    }

    async executeOpportunity(opportunity: LiquidationOpportunity): Promise<boolean> {
        const protocol = this.protocols.find(p => p.name === opportunity.protocol);
        if (!protocol) {
            logger.error(`Protocol ${opportunity.protocol} not found`);
            return false;
        }

        // Verifica gas price
        const feeData = await this.provider.getFeeData();
        const gasPriceGwei = Number(feeData.gasPrice || 0n) / 1e9;

        if (gasPriceGwei > BOT_CONFIG.maxGasPriceGwei) {
            logger.warn(`Gas price too high: ${gasPriceGwei.toFixed(2)} gwei > ${BOT_CONFIG.maxGasPriceGwei} gwei`);
            return false;
        }

        // Simula primeiro
        const canLiquidate = await protocol.service.simulateLiquidation(opportunity);
        if (!canLiquidate) {
            logger.warn(`Simulation failed for ${opportunity.user}`);
            return false;
        }

        if (BOT_CONFIG.simulationMode) {
            logger.info(`[SIMULATION] Would execute liquidation:`);
            logger.info(`  User: ${opportunity.user}`);
            logger.info(`  Protocol: ${opportunity.protocol}`);
            logger.info(`  Debt: ${opportunity.debtSymbol} ($${opportunity.debtValueUsd.toFixed(2)})`);
            logger.info(`  Collateral: ${opportunity.collateralSymbol} ($${opportunity.collateralValueUsd.toFixed(2)})`);
            logger.info(`  Expected Profit: $${opportunity.netProfitUsd.toFixed(2)}`);

            // Notifica via Telegram
            await telegram.sendOpportunity({
                protocol: opportunity.protocol,
                user: opportunity.user,
                healthFactor: opportunity.healthFactor,
                profitUsd: opportunity.netProfitUsd,
                debtAsset: opportunity.debtSymbol,
                debtValueUsd: opportunity.debtValueUsd,
                collateralAsset: opportunity.collateralSymbol,
                collateralValueUsd: opportunity.collateralValueUsd,
                isSimulation: true,
            });

            this.stats.opportunitiesFound++;
            return true;
        }

        if (!this.wallet) {
            logger.error('No wallet configured for live execution');
            return false;
        }

        // Notifica que vai executar
        await telegram.sendOpportunity({
            protocol: opportunity.protocol,
            user: opportunity.user,
            healthFactor: opportunity.healthFactor,
            profitUsd: opportunity.netProfitUsd,
            debtAsset: opportunity.debtSymbol,
            debtValueUsd: opportunity.debtValueUsd,
            collateralAsset: opportunity.collateralSymbol,
            collateralValueUsd: opportunity.collateralValueUsd,
            isSimulation: false,
        });

        // Executa liquidacao
        const txHash = await protocol.service.executeLiquidation(opportunity, this.wallet);

        if (txHash) {
            this.stats.liquidationsExecuted++;
            this.stats.totalProfitUsd += opportunity.netProfitUsd;

            logExecution({
                txHash,
                profitUsd: opportunity.netProfitUsd,
                gasUsed: 'N/A',
                success: true,
            });

            // Notifica sucesso
            await telegram.sendExecution({
                txHash,
                profitUsd: opportunity.netProfitUsd,
                gasUsed: 'N/A',
                success: true,
                blockExplorer: this.chainConfig.blockExplorer,
            });

            return true;
        }

        // Notifica falha
        await telegram.sendError(`Liquidation failed for user ${opportunity.user}`);
        return false;
    }

    async runCycle(): Promise<void> {
        this.stats.cyclesRun++;

        try {
            const opportunities = await this.checkForOpportunities();

            if (opportunities.length > 0) {
                logger.info(`Found ${opportunities.length} liquidation opportunities`);

                // Ordena por lucro (maior primeiro)
                opportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);

                // Tenta executar a melhor oportunidade
                for (const opportunity of opportunities) {
                    const success = await this.executeOpportunity(opportunity);
                    if (success && !BOT_CONFIG.simulationMode) {
                        break; // Executa apenas uma por ciclo em modo live
                    }
                }
            }
        } catch (error) {
            logger.error(`Cycle error: ${error}`);
        }
    }

    printStats(): void {
        const runtime = (Date.now() - this.stats.startTime) / 1000 / 60; // minutos
        logger.info('='.repeat(60));
        logger.info('BOT STATISTICS');
        logger.info('='.repeat(60));
        logger.info(`Runtime: ${runtime.toFixed(1)} minutes`);
        logger.info(`Active RPC: ${this.multiRpc.getCurrentEndpoint()}`);
        logger.info(`Cycles: ${this.stats.cyclesRun}`);
        logger.info(`Users Checked: ${this.stats.usersChecked}`);
        logger.info(`Opportunities Found: ${this.stats.opportunitiesFound}`);
        logger.info(`Liquidations Executed: ${this.stats.liquidationsExecuted}`);
        logger.info(`Total Profit: $${this.stats.totalProfitUsd.toFixed(2)}`);

        // RPC Status
        const rpcStatus = this.multiRpc.getStatus();
        const healthyCount = rpcStatus.filter(r => r.healthy).length;
        logger.info(`RPC Health: ${healthyCount}/${rpcStatus.length} endpoints healthy`);

        // Optimization Stats
        logger.info('-'.repeat(60));
        logger.info('OPTIMIZATION STATS (CU Savings)');
        logger.info('-'.repeat(60));
        logger.info(`Subgraph Users: ${this.stats.subgraphUsers}`);
        logger.info(`Cache Hits: ${this.stats.cacheHits}`);
        logger.info(`CUs Saved: ~${this.stats.cusSaved.toLocaleString()}`);

        const cuStats = cuTracker.getStats();
        logger.info(`CU Usage: ${cuStats.usedThisHour.toLocaleString()}/h (${cuStats.percentUsedThisHour.toFixed(1)}%)`);
        logger.info(`Daily Budget: ${cuStats.usedToday.toLocaleString()}/${cuStats.remainingToday.toLocaleString() + cuStats.usedToday} (${cuStats.percentUsedToday.toFixed(1)}%)`);

        const cacheStats = cache.getStats();
        logger.info(`Cache: ${cacheStats.entries} entries, ${cacheStats.hitRate.toFixed(1)}% hit rate`);

        const rlStats = rateLimiter.getStats();
        logger.info(`Rate Limiter: ${rlStats.throttleRate.toFixed(1)}% throttled`);
        logger.info('='.repeat(60));
    }

    async start(): Promise<void> {
        this.isRunning = true;

        logger.info('Starting liquidation bot...');

        // Descoberta inicial de usuarios
        await this.discoverUsers();

        // Inicia descoberta em tempo real
        await this.startRealTimeDiscovery();

        // Conta total de usuarios
        const totalUsers = this.protocols.reduce(
            (sum, p) => sum + p.discovery.getUserCount(), 0
        );

        // Envia notificacao de startup
        const rpcStatus = this.multiRpc.getStatus();
        await telegram.sendStartup({
            chain: this.chainConfig.name,
            mode: BOT_CONFIG.simulationMode ? 'SIMULATION' : 'LIVE',
            protocols: this.protocols.length,
            users: totalUsers,
            rpcs: rpcStatus.filter(r => r.healthy).length,
        });

        // Print stats a cada 5 minutos
        const statsInterval = setInterval(async () => {
            if (this.isRunning) {
                this.printStats();
                // Envia stats pro Telegram a cada 30 minutos
                if (this.stats.cyclesRun % 900 === 0) { // ~30 min com 2s interval
                    await this.sendTelegramStats();
                }
            }
        }, 5 * 60 * 1000);

        // Descoberta RÁPIDA de novos usuários a cada 5 segundos (últimos ~20 blocos)
        // APENAS se Subgraph estiver DESABILITADO (para economizar CUs)
        let fastDiscoveryInterval: NodeJS.Timeout | null = null;
        if (!this.useSubgraph) {
            logger.info('Fast discovery enabled (Subgraph disabled)');
            fastDiscoveryInterval = setInterval(async () => {
                if (this.isRunning) {
                    for (const protocol of this.protocols) {
                        try {
                            // Busca usuários dos últimos 20 blocos (~5 segundos em Arbitrum)
                            await protocol.discovery.discoverFromRecentBlocks(20);
                        } catch (error) {
                            // Silenciosamente ignora erros para não poluir logs
                        }
                    }
                }
            }, 5 * 1000); // 5 segundos
        } else {
            logger.info('Fast discovery DISABLED (using Subgraph - saves ~54K CUs/hour)');
        }

        // Descoberta PROFUNDA de novos usuários - usa Subgraph se disponível
        const deepDiscoveryInterval = setInterval(async () => {
            if (this.isRunning) {
                const beforeCount = this.protocols.reduce(
                    (sum, p) => sum + p.discovery.getUserCount(), 0
                );

                // Usa Subgraph se disponível (GRATUITO!)
                if (this.useSubgraph && this.subgraphService) {
                    logger.info('🔄 Refreshing users from Subgraph (FREE)...');
                    try {
                        const users = await this.subgraphService.fetchAllUsers();
                        this.stats.subgraphUsers = users.length;

                        for (const protocol of this.protocols) {
                            for (const user of users) {
                                protocol.discovery.addUser(user.id);
                            }
                        }

                        await this.classifyUsersFromSubgraph(users);
                    } catch (error) {
                        logger.debug(`Subgraph refresh error: ${error}`);
                    }
                } else {
                    // Fallback: Event-based discovery
                    logger.info('🔄 Running deep user discovery...');
                    for (const protocol of this.protocols) {
                        try {
                            await protocol.discovery.discoverFromRecentBlocks(10000);
                        } catch (error) {
                            logger.debug(`Deep discovery error: ${error}`);
                        }
                    }
                }

                const afterCount = this.protocols.reduce(
                    (sum, p) => sum + p.discovery.getUserCount(), 0
                );
                const newUsers = afterCount - beforeCount;

                if (newUsers > 0) {
                    logger.info(`✅ Discovered ${newUsers} new users (total: ${afterCount})`);
                } else {
                    logger.info(`✅ No new users found (total: ${afterCount})`);
                }
            }
        }, OPTIMIZATION_CONFIG.subgraphRefreshMs); // Configurable interval

        // Salva usuários no arquivo a cada 30 minutos
        const saveInterval = setInterval(() => {
            if (this.isRunning) {
                logger.info('💾 Saving discovered users to file...');
                for (const protocol of this.protocols) {
                    protocol.discovery.saveUsersToFile();
                }
            }
        }, 30 * 60 * 1000); // 30 minutos

        // Loop principal
        while (this.isRunning) {
            await this.runCycle();
            await this.sleep(BOT_CONFIG.pollingIntervalMs);
        }

        clearInterval(statsInterval);
        if (fastDiscoveryInterval) clearInterval(fastDiscoveryInterval);
        clearInterval(deepDiscoveryInterval);
        clearInterval(saveInterval);
    }

    async stop(): Promise<void> {
        logger.info('Stopping liquidation bot...');
        this.isRunning = false;

        // Salva usuários descobertos antes de parar
        logger.info('💾 Saving discovered users before shutdown...');
        for (const protocol of this.protocols) {
            protocol.discovery.saveUsersToFile();
            protocol.discovery.stopRealTimeDiscovery();
        }

        // Para o sistema de Multi-RPC
        await this.multiRpc.stop();

        this.printStats();

        // Notifica shutdown
        await telegram.sendShutdown('Manual shutdown or system signal');
    }

    private async sendTelegramStats(): Promise<void> {
        const runtime = (Date.now() - this.stats.startTime) / 1000 / 60;
        const rpcStatus = this.multiRpc.getStatus();

        await telegram.sendStats({
            runtime: `${runtime.toFixed(1)} minutes`,
            cycles: this.stats.cyclesRun,
            usersChecked: this.stats.usersChecked,
            opportunitiesFound: this.stats.opportunitiesFound,
            liquidationsExecuted: this.stats.liquidationsExecuted,
            totalProfitUsd: this.stats.totalProfitUsd,
            activeRpc: this.multiRpc.getCurrentEndpoint(),
            healthyRpcs: rpcStatus.filter(r => r.healthy).length,
            totalRpcs: rpcStatus.length,
        });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Entry point
async function main() {
    const bot = new LiquidationBot('arbitrum');

    // Graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Received SIGINT, shutting down...');
        await bot.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM, shutting down...');
        await bot.stop();
        process.exit(0);
    });

    try {
        await bot.initialize();
        await bot.start();
    } catch (error) {
        logger.error(`Fatal error: ${error}`);
        process.exit(1);
    }
}

main().catch(console.error);
