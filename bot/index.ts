/**
 * ============================================================================
 * BOT DE ARBITRAGEM COM FLASH LOAN - ARBITRUM
 * ============================================================================
 *
 * Bot principal que monitora oportunidades de arbitragem entre Uniswap V3
 * e SushiSwap na rede Arbitrum, executando via Flash Loans do Aave V3.
 *
 * COMO FUNCIONA:
 * 1. Conecta à rede Arbitrum via RPC
 * 2. Monitora pares de tokens configurados
 * 3. Compara preços entre DEXs
 * 4. Identifica oportunidades de arbitragem
 * 5. Executa via flash loan quando lucrativo
 *
 * MODO DE OPERAÇÃO:
 * - Modo Simulação: Apenas identifica oportunidades, não executa
 * - Modo Produção: Executa transações reais (requer fundos para gas)
 *
 * ⚠️ AVISO DE RISCO:
 * - Arbitragem é uma atividade de alto risco
 * - Você pode perder dinheiro com gas fees
 * - Teste exaustivamente antes de usar em produção
 * - Nunca invista mais do que pode perder
 */

import { ethers, Contract, Wallet, formatUnits, parseUnits } from 'ethers';
import {
    NETWORK_CONFIG,
    CONTRACTS,
    ARBITRAGE_PAIRS,
    BOT_CONFIG,
    FLASH_LOAN_ARBITRAGE_ABI,
    DEX,
    validateConfig,
    TokenInfo,
} from './config';
import { PriceService, ArbitrageOpportunity } from './priceService';
import {
    logger,
    logOperationStart,
    logOperationEnd,
    logArbitrageOpportunity,
    logArbitrageExecution,
    logBotStatus,
    logError,
} from './logger';

// ============================================================================
// CLASSE DO BOT
// ============================================================================

/**
 * Bot de Arbitragem com Flash Loan
 *
 * Responsável por:
 * - Gerenciar conexão com a blockchain
 * - Monitorar preços continuamente
 * - Executar arbitragens quando lucrativas
 * - Registrar estatísticas e logs
 */
class ArbitrageBot {
    // Conexão com a blockchain
    private provider: ethers.JsonRpcProvider;
    private wallet: Wallet | null = null;

    // Serviços
    private priceService: PriceService;

    // Contrato de arbitragem
    private arbitrageContract: Contract | null = null;

    // Estado do bot
    private isRunning: boolean = false;
    private startTime: number = 0;

    // Estatísticas
    private stats = {
        opportunitiesFound: 0,
        executedTrades: 0,
        totalProfitUsd: 0,
        failedTrades: 0,
    };

    // Controle de execução
    private lastExecutionTime: number = 0;
    private readonly MIN_EXECUTION_INTERVAL_MS = 5000; // 5 segundos entre execuções

    constructor() {
        // Inicializa provider
        this.provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.rpcUrl);

        // Inicializa serviço de preços
        this.priceService = new PriceService(this.provider);

        // Configura wallet se chave privada disponível
        if (process.env.PRIVATE_KEY) {
            this.wallet = new Wallet(process.env.PRIVATE_KEY, this.provider);
            logger.info(`Wallet configurada: ${this.wallet.address}`);
        }

        // Configura contrato de arbitragem
        if (CONTRACTS.flashLoanArbitrage && this.wallet) {
            this.arbitrageContract = new Contract(
                CONTRACTS.flashLoanArbitrage,
                FLASH_LOAN_ARBITRAGE_ABI,
                this.wallet
            );
            logger.info(`Contrato configurado: ${CONTRACTS.flashLoanArbitrage}`);
        }
    }

    // ============================================================================
    // MÉTODOS PÚBLICOS
    // ============================================================================

    /**
     * Inicia o bot de arbitragem
     *
     * FLUXO:
     * 1. Valida configurações
     * 2. Verifica conexão com a rede
     * 3. Inicia loop de monitoramento
     */
    async start(): Promise<void> {
        logOperationStart('BOT DE ARBITRAGEM');

        // Valida configuração
        validateConfig();

        // Verifica conexão
        await this.checkConnection();

        // Exibe configuração
        this.logConfiguration();

        // Marca início
        this.isRunning = true;
        this.startTime = Date.now();

        // Inicia monitoramento
        logger.info('🔄 Iniciando monitoramento de preços...');
        logger.info(`   Intervalo: ${BOT_CONFIG.monitoringIntervalMs}ms`);
        logger.info(`   Modo: ${BOT_CONFIG.simulationMode ? 'SIMULAÇÃO' : 'PRODUÇÃO'}`);
        logger.info('');

        // Loop principal
        await this.runMonitoringLoop();
    }

    /**
     * Para o bot
     */
    stop(): void {
        logger.info('🛑 Parando bot...');
        this.isRunning = false;

        // Exibe estatísticas finais
        this.logStats();
    }

    // ============================================================================
    // LOOP PRINCIPAL
    // ============================================================================

    /**
     * Loop principal de monitoramento
     *
     * Executa continuamente:
     * 1. Para cada par configurado
     * 2. Busca oportunidade de arbitragem
     * 3. Executa se lucrativo e não em modo simulação
     * 4. Aguarda intervalo configurado
     */
    private async runMonitoringLoop(): Promise<void> {
        while (this.isRunning) {
            try {
                // Verifica gas price antes de procurar oportunidades
                const gasPrice = await this.priceService.getGasPrice();
                const gasPriceGwei = parseFloat(formatUnits(gasPrice, 'gwei'));

                if (gasPriceGwei > BOT_CONFIG.maxGasPriceGwei) {
                    logger.warn(`Gas muito alto: ${gasPriceGwei.toFixed(4)} Gwei > ${BOT_CONFIG.maxGasPriceGwei} Gwei`);
                    await this.sleep(BOT_CONFIG.monitoringIntervalMs * 2);
                    continue;
                }

                // Itera sobre pares configurados
                for (const pair of ARBITRAGE_PAIRS) {
                    if (!this.isRunning) break;

                    await this.checkPair(pair.tokenA, pair.tokenB, pair.uniswapFee, pair.maxAmountUsd);
                }

                // Log de status periódico (a cada 5 minutos)
                const uptime = (Date.now() - this.startTime) / 1000;
                if (uptime % 300 < BOT_CONFIG.monitoringIntervalMs / 1000) {
                    logBotStatus(
                        uptime,
                        this.stats.opportunitiesFound,
                        this.stats.executedTrades,
                        this.stats.totalProfitUsd
                    );
                }
            } catch (error) {
                logError('monitoringLoop', error);
            }

            // Aguarda antes da próxima iteração
            await this.sleep(BOT_CONFIG.monitoringIntervalMs);
        }
    }

    /**
     * Verifica um par específico por oportunidades de arbitragem
     */
    private async checkPair(
        tokenBorrow: TokenInfo,
        tokenTarget: TokenInfo,
        uniswapFee: number,
        maxAmountUsd: number
    ): Promise<void> {
        try {
            // Calcula quantidade a emprestar baseado no máximo em USD
            const tokenPrice = await this.priceService.getTokenPriceUsd(tokenBorrow);
            const maxAmount = maxAmountUsd / tokenPrice;
            const amountBorrow = parseUnits(maxAmount.toFixed(tokenBorrow.decimals), tokenBorrow.decimals);

            logger.debug(`Verificando ${tokenBorrow.symbol}/${tokenTarget.symbol}...`);

            // Busca oportunidade
            const opportunity = await this.priceService.findArbitrageOpportunity(
                tokenBorrow,
                tokenTarget,
                amountBorrow,
                uniswapFee
            );

            // Se encontrou oportunidade lucrativa
            if (opportunity) {
                this.stats.opportunitiesFound++;
                logArbitrageOpportunity(opportunity);

                // Executa se não está em modo simulação
                if (!BOT_CONFIG.simulationMode) {
                    await this.executeArbitrage(opportunity);
                } else {
                    logger.info('📋 Modo simulação - não executando');
                }
            }
        } catch (error) {
            logError(`checkPair ${tokenBorrow.symbol}/${tokenTarget.symbol}`, error);
        }
    }

    // ============================================================================
    // EXECUÇÃO DE ARBITRAGEM
    // ============================================================================

    /**
     * Executa uma oportunidade de arbitragem
     *
     * PASSOS:
     * 1. Verifica se pode executar (intervalo, contrato, etc)
     * 2. Prepara parâmetros do contrato
     * 3. Estima gas
     * 4. Envia transação
     * 5. Aguarda confirmação
     * 6. Registra resultado
     */
    private async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<void> {
        // Verifica intervalo mínimo entre execuções
        const now = Date.now();
        if (now - this.lastExecutionTime < this.MIN_EXECUTION_INTERVAL_MS) {
            logger.warn('Aguardando intervalo mínimo entre execuções');
            return;
        }

        // Verifica se contrato está configurado
        if (!this.arbitrageContract || !this.wallet) {
            logger.error('Contrato ou wallet não configurados');
            return;
        }

        try {
            logger.info('🔄 Executando arbitragem...');

            // Prepara parâmetros
            const params = {
                tokenBorrow: opportunity.tokenBorrow.address,
                tokenTarget: opportunity.tokenTarget.address,
                amountBorrow: opportunity.amountBorrow,
                dexBuy: opportunity.dexBuy,
                dexSell: opportunity.dexSell,
                uniswapFeeBuy: opportunity.uniswapFeeBuy,
                uniswapFeeSell: opportunity.uniswapFeeSell,
                minProfit: opportunity.expectedProfit / 2n, // 50% do lucro esperado como mínimo
            };

            // Estima gas
            const gasEstimate = await this.arbitrageContract.executeArbitrage.estimateGas(params);
            const gasLimit = gasEstimate * 120n / 100n; // 20% extra de margem

            logger.info(`Gas estimado: ${gasEstimate.toString()}`);

            // Obtém gas price atual
            const feeData = await this.provider.getFeeData();

            // Envia transação
            const tx = await this.arbitrageContract.executeArbitrage(params, {
                gasLimit,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            });

            logger.info(`TX enviada: ${tx.hash}`);

            // Aguarda confirmação
            const receipt = await tx.wait(BOT_CONFIG.confirmationBlocks);

            if (receipt && receipt.status === 1) {
                // Sucesso!
                this.stats.executedTrades++;

                // Calcula custo real de gas
                const gasUsed = receipt.gasUsed;
                const gasCost = gasUsed * (receipt.gasPrice || 0n);
                const gasCostEth = parseFloat(formatUnits(gasCost, 18));
                const ethPrice = await this.priceService.getEthPriceUsd();
                const gasCostUsd = gasCostEth * ethPrice;

                // Calcula lucro real (aproximado)
                const realProfit = opportunity.expectedProfitUsd - gasCostUsd;
                this.stats.totalProfitUsd += realProfit;

                logArbitrageExecution(
                    tx.hash,
                    realProfit,
                    gasUsed,
                    gasCostUsd
                );
            } else {
                this.stats.failedTrades++;
                logger.error('Transação falhou ou foi revertida');
            }

            this.lastExecutionTime = Date.now();
        } catch (error) {
            this.stats.failedTrades++;
            logError('executeArbitrage', error);
        }
    }

    // ============================================================================
    // MÉTODOS AUXILIARES
    // ============================================================================

    /**
     * Verifica conexão com a blockchain
     */
    private async checkConnection(): Promise<void> {
        try {
            const network = await this.provider.getNetwork();
            const blockNumber = await this.provider.getBlockNumber();

            logger.info(`✅ Conectado à rede: ${network.name} (Chain ID: ${network.chainId})`);
            logger.info(`   Bloco atual: ${blockNumber}`);

            // Verifica se é a rede correta
            if (Number(network.chainId) !== NETWORK_CONFIG.chainId) {
                throw new Error(
                    `Chain ID incorreto! Esperado: ${NETWORK_CONFIG.chainId}, Recebido: ${network.chainId}`
                );
            }

            // Verifica saldo da wallet
            if (this.wallet) {
                const balance = await this.provider.getBalance(this.wallet.address);
                const balanceEth = formatUnits(balance, 18);
                logger.info(`   Saldo ETH: ${parseFloat(balanceEth).toFixed(6)} ETH`);

                if (balance === 0n && !BOT_CONFIG.simulationMode) {
                    logger.warn('⚠️ Saldo zerado! Você precisa de ETH para pagar gas.');
                }
            }
        } catch (error) {
            logger.error('Falha ao conectar com a rede');
            throw error;
        }
    }

    /**
     * Exibe configuração atual do bot
     */
    private logConfiguration(): void {
        logger.info('');
        logger.info('📋 CONFIGURAÇÃO:');
        logger.info(`   Lucro mínimo: $${BOT_CONFIG.minProfitUsd}`);
        logger.info(`   Lucro mínimo (%): ${BOT_CONFIG.minProfitPercentage}%`);
        logger.info(`   Flash Loan máximo: $${BOT_CONFIG.maxFlashLoanUsd}`);
        logger.info(`   Slippage máximo: ${BOT_CONFIG.maxSlippageBps / 100}%`);
        logger.info(`   Gas máximo: ${BOT_CONFIG.maxGasPriceGwei} Gwei`);
        logger.info('');
        logger.info('📊 PARES MONITORADOS:');
        for (const pair of ARBITRAGE_PAIRS) {
            logger.info(`   - ${pair.tokenA.symbol}/${pair.tokenB.symbol} (max: $${pair.maxAmountUsd})`);
        }
        logger.info('');
    }

    /**
     * Exibe estatísticas do bot
     */
    private logStats(): void {
        const uptime = (Date.now() - this.startTime) / 1000;
        logBotStatus(
            uptime,
            this.stats.opportunitiesFound,
            this.stats.executedTrades,
            this.stats.totalProfitUsd
        );

        logger.info('📈 ESTATÍSTICAS FINAIS:');
        logger.info(`   Oportunidades encontradas: ${this.stats.opportunitiesFound}`);
        logger.info(`   Trades executados: ${this.stats.executedTrades}`);
        logger.info(`   Trades falhos: ${this.stats.failedTrades}`);
        logger.info(`   Lucro total: $${this.stats.totalProfitUsd.toFixed(2)}`);
    }

    /**
     * Sleep helper
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================================
// PONTO DE ENTRADA
// ============================================================================

/**
 * Função principal
 */
async function main(): Promise<void> {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                                                              ║');
    console.log('║   🤖 BOT DE ARBITRAGEM COM FLASH LOAN                        ║');
    console.log('║   Rede: Arbitrum One                                         ║');
    console.log('║   DEXs: Uniswap V3, SushiSwap                                ║');
    console.log('║   Flash Loan: Aave V3                                        ║');
    console.log('║                                                              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');

    // Cria e inicia o bot
    const bot = new ArbitrageBot();

    // Handler para encerramento gracioso
    process.on('SIGINT', () => {
        logger.info('');
        logger.info('Recebido SIGINT, encerrando...');
        bot.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        logger.info('');
        logger.info('Recebido SIGTERM, encerrando...');
        bot.stop();
        process.exit(0);
    });

    // Inicia o bot
    try {
        await bot.start();
    } catch (error) {
        logError('main', error);
        process.exit(1);
    }
}

// Executa
main().catch(console.error);
