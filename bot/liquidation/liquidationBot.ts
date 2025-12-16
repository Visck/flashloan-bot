import dotenv from 'dotenv';
dotenv.config(); // DEVE ser chamado ANTES de qualquer import que use process.env

import { ethers, JsonRpcProvider, Wallet } from 'ethers';
import { logger, logOpportunity, logExecution } from '../services/logger';
import { MultiRpcProvider } from '../services/rpcProvider';
import { telegram } from '../services/telegram';
import { CHAINS, BOT_CONFIG, ChainConfig } from './liquidationConfig';
import { AaveService, LiquidationOpportunity } from './aaveService';
import { createLendingService } from './radiantService';
import { UserDiscovery } from './userDiscovery';

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
    private stats = {
        cyclesRun: 0,
        usersChecked: 0,
        opportunitiesFound: 0,
        liquidationsExecuted: 0,
        totalProfitUsd: 0,
        startTime: Date.now(),
        rpcFailovers: 0,
    };

    constructor(chain: string = 'arbitrum') {
        const config = CHAINS[chain];
        if (!config) {
            throw new Error(`Chain ${chain} not supported`);
        }

        this.chainConfig = config;
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
    }

    async discoverUsers(): Promise<void> {
        logger.info('Discovering users with active positions...');

        for (const protocol of this.protocols) {
            try {
                await protocol.discovery.discoverFromRecentBlocks(5000);
                logger.info(`${protocol.name}: ${protocol.discovery.getUserCount()} users discovered`);
            } catch (error) {
                logger.error(`Failed to discover users for ${protocol.name}: ${error}`);
            }
        }
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

            // Processa batches em PARALELO (max 10 simultâneos para não sobrecarregar RPC)
            const PARALLEL_BATCHES = 10;
            for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
                const parallelBatches = batches.slice(i, i + PARALLEL_BATCHES);

                const results = await Promise.allSettled(
                    parallelBatches.map(async (batch) => {
                        try {
                            return await protocol.service.getBatchUserAccountData(batch);
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

        // Descoberta periódica de novos usuários a cada 15 minutos
        const discoveryInterval = setInterval(async () => {
            if (this.isRunning) {
                logger.info('🔄 Running periodic user discovery...');
                const beforeCount = this.protocols.reduce(
                    (sum, p) => sum + p.discovery.getUserCount(), 0
                );

                for (const protocol of this.protocols) {
                    try {
                        // Busca usuários dos últimos 10000 blocos (~40 min em Arbitrum)
                        await protocol.discovery.discoverFromRecentBlocks(10000);
                    } catch (error) {
                        logger.debug(`Periodic discovery error: ${error}`);
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
        }, 15 * 60 * 1000); // 15 minutos

        // Loop principal
        while (this.isRunning) {
            await this.runCycle();
            await this.sleep(BOT_CONFIG.pollingIntervalMs);
        }

        clearInterval(statsInterval);
        clearInterval(discoveryInterval);
    }

    async stop(): Promise<void> {
        logger.info('Stopping liquidation bot...');
        this.isRunning = false;

        for (const protocol of this.protocols) {
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
