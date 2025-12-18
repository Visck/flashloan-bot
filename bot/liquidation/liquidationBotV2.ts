/**
 * Liquidation Bot V2 - Versão Otimizada
 *
 * Melhorias:
 * - Multi-chain (Arbitrum, Base, Optimism)
 * - WebSocket nativo para eventos em tempo real
 * - Polling reduzido (200-500ms)
 * - Flashbots/MEV Protection
 * - Suporte a nó próprio
 * - Paralelismo otimizado
 */

import dotenv from 'dotenv';
dotenv.config();

import { ethers, JsonRpcProvider, Wallet, Contract } from 'ethers';
import { logger, logOpportunity, logExecution } from '../services/logger';
import { MultiRpcProvider } from '../services/rpcProvider';
import { WebSocketManager, getWebSocketManager } from '../services/websocketManager';
import { FlashbotsService, encodeLiquidationCall } from '../services/flashbotsService';
import { telegram } from '../services/telegram';
import {
    CHAINS,
    BOT_CONFIG,
    ChainConfig,
    ProtocolConfig,
    getEnabledChains,
    getEnabledProtocols,
    AAVE_POOL_ABI,
} from './liquidationConfigV2';
import { AaveService, LiquidationOpportunity } from './aaveService';
import { createLendingService } from './radiantService';
import { UserDiscovery } from './userDiscovery';

interface ProtocolContext {
    service: AaveService;
    discovery: UserDiscovery;
    name: string;
    chain: string;
}

interface ChainContext {
    config: ChainConfig;
    provider: JsonRpcProvider;
    multiRpc: MultiRpcProvider;
    wallet: Wallet | null;
    protocols: ProtocolContext[];
    flashbots: FlashbotsService | null;
}

class LiquidationBotV2 {
    private chains: Map<string, ChainContext> = new Map();
    private wsManager: WebSocketManager | null = null;
    private isRunning: boolean = false;
    private stats = {
        cyclesRun: 0,
        usersChecked: 0,
        opportunitiesFound: 0,
        liquidationsExecuted: 0,
        totalProfitUsd: 0,
        startTime: Date.now(),
        chainStats: new Map<string, { checked: number; found: number; executed: number }>(),
    };

    constructor() {
        logger.info('LiquidationBot V2 - Multi-Chain Edition');
    }

    async initialize(): Promise<void> {
        this.printBanner();

        const enabledChains = getEnabledChains();
        logger.info(`Initializing ${enabledChains.length} chains...`);

        // Inicializa cada chain em paralelo
        const initPromises = enabledChains.map(async (chainConfig) => {
            try {
                await this.initializeChain(chainConfig);
                logger.info(`✅ ${chainConfig.name} initialized`);
            } catch (error) {
                logger.error(`❌ Failed to initialize ${chainConfig.name}: ${error}`);
            }
        });

        await Promise.all(initPromises);

        if (this.chains.size === 0) {
            throw new Error('No chains initialized successfully');
        }

        // Inicializa WebSocket se habilitado
        if (BOT_CONFIG.useWebSocket) {
            try {
                await this.initializeWebSocket();
            } catch (error) {
                logger.warn(`WebSocket initialization failed, continuing without it: ${error}`);
            }
        }

        logger.info(`\n✅ Bot initialized with ${this.chains.size} chains`);
    }

    private async initializeChain(chainConfig: ChainConfig): Promise<void> {
        logger.info(`Initializing ${chainConfig.name}...`);

        // Inicializa Multi-RPC
        const multiRpc = new MultiRpcProvider(
            chainConfig.rpcUrls.map((url, i) => ({
                name: `RPC-${i + 1}`,
                url,
                wssUrl: chainConfig.wssUrls?.[i],
                priority: i + 1,
            }))
        );

        const provider = await multiRpc.initialize();

        // Verifica conexão
        const blockNumber = await provider.getBlockNumber();
        logger.info(`${chainConfig.name}: Connected at block ${blockNumber}`);

        // Inicializa wallet
        let wallet: Wallet | null = null;
        let flashbots: FlashbotsService | null = null;

        if (!BOT_CONFIG.simulationMode && process.env.PRIVATE_KEY) {
            wallet = new Wallet(process.env.PRIVATE_KEY, provider);
            logger.info(`${chainConfig.name}: Wallet ${wallet.address}`);

            // Inicializa Flashbots se habilitado
            if (BOT_CONFIG.useMevProtection) {
                flashbots = new FlashbotsService(provider, wallet, true);
                logger.info(`${chainConfig.name}: MEV Protection enabled`);
            }
        }

        // Inicializa protocolos
        const protocols: ProtocolContext[] = [];
        const enabledProtocols = getEnabledProtocols(chainConfig);

        for (const protocolConfig of enabledProtocols) {
            try {
                const service = createLendingService(provider, protocolConfig);
                await service.initialize();

                const discovery = new UserDiscovery(
                    provider,
                    protocolConfig.poolAddress,
                    `${chainConfig.name}-${protocolConfig.name}`,
                    chainConfig.wssUrls?.[0]
                );

                protocols.push({
                    service,
                    discovery,
                    name: protocolConfig.name,
                    chain: chainConfig.name,
                });

                logger.info(`  ✅ ${protocolConfig.name} initialized`);
            } catch (error) {
                logger.error(`  ❌ Failed to initialize ${protocolConfig.name}: ${error}`);
            }
        }

        // Inicializa stats para esta chain
        this.stats.chainStats.set(chainConfig.name, {
            checked: 0,
            found: 0,
            executed: 0,
        });

        this.chains.set(chainConfig.name, {
            config: chainConfig,
            provider,
            multiRpc,
            wallet,
            protocols,
            flashbots,
        });
    }

    private async initializeWebSocket(): Promise<void> {
        logger.info('Initializing WebSocket connections...');

        this.wsManager = getWebSocketManager();
        const wssProvider = await this.wsManager.connect();

        if (wssProvider) {
            // Subscreve a novos blocos
            await this.wsManager.subscribeToBlocks((blockNumber) => {
                logger.debug(`New block: ${blockNumber}`);
            });

            // Subscreve a eventos de liquidação em cada chain
            for (const [chainName, chainCtx] of this.chains) {
                for (const protocol of chainCtx.protocols) {
                    try {
                        await this.wsManager.subscribeToContract(
                            protocol.service.getPoolAddress(),
                            AAVE_POOL_ABI,
                            [
                                {
                                    event: 'Borrow',
                                    callback: (reserve: string, user: string, onBehalfOf: string) => {
                                        protocol.discovery.addUser(onBehalfOf);
                                        logger.debug(`[${chainName}] New borrower: ${onBehalfOf.slice(0, 10)}...`);
                                    },
                                },
                                {
                                    event: 'Supply',
                                    callback: (reserve: string, user: string, onBehalfOf: string) => {
                                        protocol.discovery.addUser(onBehalfOf);
                                    },
                                },
                                {
                                    event: 'LiquidationCall',
                                    callback: (collateral: string, debt: string, user: string) => {
                                        logger.info(`[${chainName}] User ${user.slice(0, 10)}... was liquidated`);
                                    },
                                },
                            ]
                        );
                    } catch (error) {
                        logger.warn(`Failed to subscribe to ${protocol.name} events: ${error}`);
                    }
                }
            }

            logger.info('✅ WebSocket subscriptions active');
        } else {
            logger.warn('WebSocket connection failed, using polling only');
        }
    }

    private printBanner(): void {
        console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║     ██╗     ██╗ ██████╗ ██╗   ██╗██╗██████╗  █████╗ ████████╗    ║
║     ██║     ██║██╔═══██╗██║   ██║██║██╔══██╗██╔══██╗╚══██╔══╝    ║
║     ██║     ██║██║   ██║██║   ██║██║██║  ██║███████║   ██║       ║
║     ██║     ██║██║▄▄ ██║██║   ██║██║██║  ██║██╔══██║   ██║       ║
║     ███████╗██║╚██████╔╝╚██████╔╝██║██████╔╝██║  ██║   ██║       ║
║     ╚══════╝╚═╝ ╚══▀▀═╝  ╚═════╝ ╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝       ║
║                                                                   ║
║              LIQUIDATION BOT V2 - MULTI-CHAIN                     ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
`);

        logger.info('='.repeat(60));
        logger.info('CONFIGURATION');
        logger.info('='.repeat(60));
        logger.info(`Mode: ${BOT_CONFIG.simulationMode ? 'SIMULATION' : 'LIVE'}`);
        logger.info(`Min Profit: $${BOT_CONFIG.minProfitUsd}`);
        logger.info(`Polling Interval: ${BOT_CONFIG.pollingIntervalMs}ms`);
        logger.info(`Parallel Batches: ${BOT_CONFIG.parallelBatches}`);
        logger.info(`WebSocket: ${BOT_CONFIG.useWebSocket ? 'Enabled' : 'Disabled'}`);
        logger.info(`MEV Protection: ${BOT_CONFIG.useMevProtection ? 'Enabled' : 'Disabled'}`);
        logger.info(`Local Node: ${BOT_CONFIG.useLocalNode ? 'Enabled' : 'Disabled'}`);
        logger.info('='.repeat(60));
    }

    async discoverUsers(): Promise<void> {
        logger.info('Discovering users across all chains...');

        const discoveryPromises: Promise<void>[] = [];

        for (const [chainName, chainCtx] of this.chains) {
            for (const protocol of chainCtx.protocols) {
                discoveryPromises.push(
                    (async () => {
                        try {
                            await protocol.discovery.discoverFromRecentBlocks(
                                BOT_CONFIG.userDiscoveryBlocksBack
                            );
                            logger.info(
                                `${chainName}/${protocol.name}: ${protocol.discovery.getUserCount()} users`
                            );
                        } catch (error) {
                            logger.error(`Discovery failed for ${chainName}/${protocol.name}: ${error}`);
                        }
                    })()
                );
            }
        }

        await Promise.all(discoveryPromises);

        // Total de usuários
        let totalUsers = 0;
        for (const chainCtx of this.chains.values()) {
            for (const protocol of chainCtx.protocols) {
                totalUsers += protocol.discovery.getUserCount();
            }
        }

        logger.info(`Total users discovered: ${totalUsers}`);
    }

    async checkForOpportunities(): Promise<LiquidationOpportunity[]> {
        const allOpportunities: LiquidationOpportunity[] = [];

        // Processa todas as chains em paralelo
        const chainPromises = Array.from(this.chains.entries()).map(
            async ([chainName, chainCtx]) => {
                const chainOpportunities: LiquidationOpportunity[] = [];

                for (const protocol of chainCtx.protocols) {
                    const users = protocol.discovery.getKnownUsers();
                    if (users.length === 0) continue;

                    // Processa em batches paralelos
                    const batchSize = BOT_CONFIG.maxUsersPerBatch;
                    const batches: string[][] = [];
                    for (let i = 0; i < users.length; i += batchSize) {
                        batches.push(users.slice(i, i + batchSize));
                    }

                    // Processa batches em paralelo
                    for (let i = 0; i < batches.length; i += BOT_CONFIG.parallelBatches) {
                        const parallelBatches = batches.slice(i, i + BOT_CONFIG.parallelBatches);

                        const results = await Promise.allSettled(
                            parallelBatches.map(async (batch) => {
                                try {
                                    return await protocol.service.getBatchUserAccountData(batch);
                                } catch {
                                    return [];
                                }
                            })
                        );

                        for (const result of results) {
                            if (result.status === 'fulfilled' && result.value) {
                                const accountsData = result.value;
                                this.stats.usersChecked += accountsData.length;

                                // Atualiza stats da chain
                                const chainStats = this.stats.chainStats.get(chainName);
                                if (chainStats) {
                                    chainStats.checked += accountsData.length;
                                }

                                for (const accountData of accountsData) {
                                    if (accountData.healthFactorNum < BOT_CONFIG.healthFactorThreshold) {
                                        const opportunity =
                                            await protocol.service.calculateLiquidationOpportunity(
                                                accountData.user,
                                                accountData
                                            );

                                        if (
                                            opportunity &&
                                            opportunity.netProfitUsd >= BOT_CONFIG.minProfitUsd
                                        ) {
                                            // Adiciona info da chain
                                            (opportunity as any).chain = chainName;
                                            chainOpportunities.push(opportunity);

                                            logOpportunity({
                                                protocol: `${chainName}/${opportunity.protocol}`,
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

                return chainOpportunities;
            }
        );

        const results = await Promise.all(chainPromises);
        for (const opportunities of results) {
            allOpportunities.push(...opportunities);
        }

        return allOpportunities;
    }

    async executeOpportunity(opportunity: LiquidationOpportunity): Promise<boolean> {
        const chainName = (opportunity as any).chain || 'arbitrum';
        const chainCtx = this.chains.get(chainName);

        if (!chainCtx) {
            logger.error(`Chain ${chainName} not found`);
            return false;
        }

        const protocol = chainCtx.protocols.find((p) => p.name === opportunity.protocol);
        if (!protocol) {
            logger.error(`Protocol ${opportunity.protocol} not found`);
            return false;
        }

        // Verifica gas price
        const feeData = await chainCtx.provider.getFeeData();
        const gasPriceGwei = Number(feeData.gasPrice || 0n) / 1e9;

        if (gasPriceGwei > BOT_CONFIG.maxGasPriceGwei) {
            logger.warn(
                `Gas price too high: ${gasPriceGwei.toFixed(2)} gwei > ${BOT_CONFIG.maxGasPriceGwei} gwei`
            );
            return false;
        }

        // Simula primeiro
        const canLiquidate = await protocol.service.simulateLiquidation(opportunity);
        if (!canLiquidate) {
            logger.warn(`Simulation failed for ${opportunity.user}`);
            return false;
        }

        if (BOT_CONFIG.simulationMode) {
            logger.info(`[SIMULATION] Would execute liquidation on ${chainName}:`);
            logger.info(`  User: ${opportunity.user}`);
            logger.info(`  Protocol: ${opportunity.protocol}`);
            logger.info(`  Debt: ${opportunity.debtSymbol} ($${opportunity.debtValueUsd.toFixed(2)})`);
            logger.info(
                `  Collateral: ${opportunity.collateralSymbol} ($${opportunity.collateralValueUsd.toFixed(2)})`
            );
            logger.info(`  Expected Profit: $${opportunity.netProfitUsd.toFixed(2)}`);

            await telegram.sendOpportunity({
                protocol: `${chainName}/${opportunity.protocol}`,
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
            const chainStats = this.stats.chainStats.get(chainName);
            if (chainStats) chainStats.found++;

            return true;
        }

        if (!chainCtx.wallet) {
            logger.error('No wallet configured for live execution');
            return false;
        }

        // Executa com MEV Protection se habilitado
        let txHash: string | null = null;

        if (chainCtx.flashbots) {
            const txData = encodeLiquidationCall(
                opportunity.collateralAsset,
                opportunity.debtAsset,
                opportunity.user,
                opportunity.maxLiquidatableDebt
            );

            const txResponse = await chainCtx.flashbots.sendLiquidationTx(
                protocol.service.getPoolAddress(),
                txData
            );

            if (txResponse) {
                const receipt = await txResponse.wait();
                txHash = receipt?.hash || null;
            }
        } else {
            txHash = await protocol.service.executeLiquidation(opportunity, chainCtx.wallet);
        }

        if (txHash) {
            this.stats.liquidationsExecuted++;
            this.stats.totalProfitUsd += opportunity.netProfitUsd;

            const chainStats = this.stats.chainStats.get(chainName);
            if (chainStats) chainStats.executed++;

            logExecution({
                txHash,
                profitUsd: opportunity.netProfitUsd,
                gasUsed: 'N/A',
                success: true,
            });

            await telegram.sendExecution({
                txHash,
                profitUsd: opportunity.netProfitUsd,
                gasUsed: 'N/A',
                success: true,
                blockExplorer: chainCtx.config.blockExplorer,
            });

            return true;
        }

        await telegram.sendError(`Liquidation failed for user ${opportunity.user} on ${chainName}`);
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

                // Tenta executar as melhores oportunidades
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
        const runtime = (Date.now() - this.stats.startTime) / 1000 / 60;

        logger.info('\n' + '='.repeat(60));
        logger.info('BOT STATISTICS');
        logger.info('='.repeat(60));
        logger.info(`Runtime: ${runtime.toFixed(1)} minutes`);
        logger.info(`Cycles: ${this.stats.cyclesRun}`);
        logger.info(`Users Checked: ${this.stats.usersChecked}`);
        logger.info(`Opportunities Found: ${this.stats.opportunitiesFound}`);
        logger.info(`Liquidations Executed: ${this.stats.liquidationsExecuted}`);
        logger.info(`Total Profit: $${this.stats.totalProfitUsd.toFixed(2)}`);
        logger.info('-'.repeat(60));
        logger.info('PER-CHAIN STATS:');

        for (const [chainName, stats] of this.stats.chainStats) {
            const chainCtx = this.chains.get(chainName);
            if (!chainCtx) continue;

            let totalUsers = 0;
            for (const protocol of chainCtx.protocols) {
                totalUsers += protocol.discovery.getUserCount();
            }

            logger.info(
                `  ${chainName}: ${totalUsers} users | ${stats.checked} checked | ${stats.found} found | ${stats.executed} executed`
            );
        }

        // RPC Status
        logger.info('-'.repeat(60));
        logger.info('RPC HEALTH:');
        for (const [chainName, chainCtx] of this.chains) {
            const rpcStatus = chainCtx.multiRpc.getStatus();
            const healthyCount = rpcStatus.filter((r) => r.healthy).length;
            logger.info(`  ${chainName}: ${healthyCount}/${rpcStatus.length} endpoints healthy`);
        }

        // WebSocket Status
        if (this.wsManager) {
            logger.info(`WebSocket: ${this.wsManager.isConnected() ? 'Connected' : 'Disconnected'}`);
        }

        logger.info('='.repeat(60) + '\n');
    }

    async start(): Promise<void> {
        this.isRunning = true;

        logger.info('Starting liquidation bot...');

        // Descoberta inicial de usuários
        await this.discoverUsers();

        // Calcula total de usuários
        let totalUsers = 0;
        for (const chainCtx of this.chains.values()) {
            for (const protocol of chainCtx.protocols) {
                totalUsers += protocol.discovery.getUserCount();
            }
        }

        // Envia notificação de startup
        await telegram.sendStartup({
            chain: `Multi-Chain (${this.chains.size} chains)`,
            mode: BOT_CONFIG.simulationMode ? 'SIMULATION' : 'LIVE',
            protocols: Array.from(this.chains.values()).reduce(
                (sum, ctx) => sum + ctx.protocols.length,
                0
            ),
            users: totalUsers,
            rpcs: Array.from(this.chains.values()).reduce((sum, ctx) => {
                return sum + ctx.multiRpc.getStatus().filter((r) => r.healthy).length;
            }, 0),
        });

        // Print stats a cada 5 minutos
        const statsInterval = setInterval(async () => {
            if (this.isRunning) {
                this.printStats();
                // Envia stats pro Telegram a cada 30 minutos
                if (this.stats.cyclesRun % (30 * 60 * 1000 / BOT_CONFIG.pollingIntervalMs) === 0) {
                    await this.sendTelegramStats();
                }
            }
        }, 5 * 60 * 1000);

        // Descoberta rápida de novos usuários
        const fastDiscoveryInterval = setInterval(async () => {
            if (this.isRunning) {
                for (const chainCtx of this.chains.values()) {
                    for (const protocol of chainCtx.protocols) {
                        try {
                            // Busca últimos 20 blocos
                            await protocol.discovery.discoverFromRecentBlocks(20);
                        } catch {
                            // Silenciosamente ignora erros
                        }
                    }
                }
            }
        }, BOT_CONFIG.fastDiscoveryInterval);

        // Descoberta profunda
        const deepDiscoveryInterval = setInterval(async () => {
            if (this.isRunning) {
                logger.info('Running deep user discovery...');
                await this.discoverUsers();
            }
        }, BOT_CONFIG.deepDiscoveryInterval);

        // Salva usuários periodicamente
        const saveInterval = setInterval(() => {
            if (this.isRunning) {
                for (const chainCtx of this.chains.values()) {
                    for (const protocol of chainCtx.protocols) {
                        protocol.discovery.saveUsersToFile();
                    }
                }
            }
        }, 30 * 60 * 1000);

        // Loop principal
        while (this.isRunning) {
            await this.runCycle();
            await this.sleep(BOT_CONFIG.pollingIntervalMs);
        }

        clearInterval(statsInterval);
        clearInterval(fastDiscoveryInterval);
        clearInterval(deepDiscoveryInterval);
        clearInterval(saveInterval);
    }

    async stop(): Promise<void> {
        logger.info('Stopping liquidation bot...');
        this.isRunning = false;

        // Salva usuários
        for (const chainCtx of this.chains.values()) {
            for (const protocol of chainCtx.protocols) {
                protocol.discovery.saveUsersToFile();
                protocol.discovery.stopRealTimeDiscovery();
            }
            await chainCtx.multiRpc.stop();
        }

        // Para WebSocket
        if (this.wsManager) {
            await this.wsManager.stop();
        }

        this.printStats();
        await telegram.sendShutdown('Manual shutdown or system signal');
    }

    private async sendTelegramStats(): Promise<void> {
        const runtime = (Date.now() - this.stats.startTime) / 1000 / 60;

        let healthyRpcs = 0;
        let totalRpcs = 0;
        for (const chainCtx of this.chains.values()) {
            const status = chainCtx.multiRpc.getStatus();
            healthyRpcs += status.filter((r) => r.healthy).length;
            totalRpcs += status.length;
        }

        await telegram.sendStats({
            runtime: `${runtime.toFixed(1)} minutes`,
            cycles: this.stats.cyclesRun,
            usersChecked: this.stats.usersChecked,
            opportunitiesFound: this.stats.opportunitiesFound,
            liquidationsExecuted: this.stats.liquidationsExecuted,
            totalProfitUsd: this.stats.totalProfitUsd,
            activeRpc: `${this.chains.size} chains`,
            healthyRpcs,
            totalRpcs,
        });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// Entry point
async function main() {
    const bot = new LiquidationBotV2();

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
