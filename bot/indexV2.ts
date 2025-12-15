/**
 * ============================================================================
 * BOT DE ARBITRAGEM V2 - VERSÃO COMPETITIVA
 * ============================================================================
 *
 * Versão 2.0 com melhorias competitivas:
 * - Múltiplas DEXs (Uniswap V3, SushiSwap, Camelot)
 * - Arbitragem triangular
 * - WebSocket para tempo real
 * - Múltiplos RPCs com failover
 * - Flashbots para proteção MEV
 *
 * COMO EXECUTAR:
 * ```bash
 * npm run dev:v2
 * ```
 */

import {
    JsonRpcProvider,
    Wallet,
    Contract,
    formatUnits,
    parseUnits,
    formatEther,
} from 'ethers';
import { config } from 'dotenv';
import { logger } from './logger';
import { WebSocketService, MultiRpcService, BlockData } from './websocketService';
import {
    DEX,
    DEX_INFO,
    TOKENS,
    TokenInfo,
    ARBITRAGE_PAIRS,
    ArbitragePair,
    TRIANGULAR_ROUTES,
    TriangularRoute,
    BOT_CONFIG_V2,
    RPC_ENDPOINTS,
    CAMELOT_ROUTER_ABI,
} from './configV2';
import {
    ERC20_ABI,
    UNISWAP_QUOTER_ABI,
    SUSHISWAP_ROUTER_ABI,
    FLASH_LOAN_ARBITRAGE_ABI,
} from './config';

config();

// ============================================================================
// TIPOS
// ============================================================================

interface PriceQuote {
    dex: DEX;
    dexName: string;
    amountIn: bigint;
    amountOut: bigint;
    fee?: number;
    pricePerToken: number;
}

interface ArbitrageOpportunity {
    type: 'simple' | 'triangular';
    buyDex: DEX;
    sellDex: DEX;
    tokenBorrow: TokenInfo;
    tokenTarget: TokenInfo;
    tokenMiddle?: TokenInfo;
    amountBorrow: bigint;
    expectedProfit: bigint;
    expectedProfitUsd: number;
    profitPercentage: number;
    buyFee?: number;
    sellFee?: number;
    timestamp: number;
}

interface BotStats {
    startTime: number;
    blocksProcessed: number;
    opportunitiesFound: number;
    opportunitiesExecuted: number;
    totalProfitUsd: number;
    errorsCount: number;
    lastBlockNumber: number;
}

// ============================================================================
// CLASSE PRINCIPAL - BOT V2
// ============================================================================

class ArbitrageBotV2 {
    private multiRpc: MultiRpcService;
    private wsService: WebSocketService | null = null;
    private wallet: Wallet;
    private flashLoanContract: Contract | null = null;

    // Contracts das DEXs
    private uniswapQuoter: Contract;
    private sushiRouter: Contract;
    private camelotRouter: Contract;

    // Estado
    private isRunning: boolean = false;
    private stats: BotStats;
    private lastPrices: Map<string, Map<DEX, PriceQuote>> = new Map();

    constructor() {
        logger.info('='.repeat(60));
        logger.info('BOT DE ARBITRAGEM V2 - INICIALIZANDO');
        logger.info('='.repeat(60));

        // Inicializa multi-RPC
        this.multiRpc = new MultiRpcService();
        const provider = this.multiRpc.getProvider();

        // Carteira
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error('PRIVATE_KEY não configurada no .env');
        }
        this.wallet = new Wallet(privateKey, provider);

        // Contracts das DEXs
        this.uniswapQuoter = new Contract(
            DEX_INFO[DEX.UNISWAP_V3].quoter,
            UNISWAP_QUOTER_ABI,
            provider
        );

        this.sushiRouter = new Contract(
            DEX_INFO[DEX.SUSHISWAP].router,
            SUSHISWAP_ROUTER_ABI,
            provider
        );

        this.camelotRouter = new Contract(
            DEX_INFO[DEX.CAMELOT].router,
            CAMELOT_ROUTER_ABI,
            provider
        );

        // Contract do Flash Loan (se deployado)
        const flashLoanAddress = process.env.FLASH_LOAN_CONTRACT_ADDRESS;
        if (flashLoanAddress) {
            this.flashLoanContract = new Contract(
                flashLoanAddress,
                FLASH_LOAN_ARBITRAGE_ABI,
                this.wallet
            );
        }

        // Estatísticas
        this.stats = {
            startTime: Date.now(),
            blocksProcessed: 0,
            opportunitiesFound: 0,
            opportunitiesExecuted: 0,
            totalProfitUsd: 0,
            errorsCount: 0,
            lastBlockNumber: 0,
        };

        logger.info(`Carteira: ${this.wallet.address}`);
        logger.info(`Modo: ${BOT_CONFIG_V2.simulationMode ? 'SIMULAÇÃO' : 'PRODUÇÃO'}`);
        logger.info(`Lucro mínimo: $${BOT_CONFIG_V2.minProfitUsd}`);
        logger.info(`WebSocket: ${BOT_CONFIG_V2.useWebSocket ? 'ATIVO' : 'POLLING'}`);
        logger.info(`Triangular: ${BOT_CONFIG_V2.enableTriangular ? 'ATIVO' : 'DESATIVO'}`);
    }

    /**
     * Inicia o bot
     */
    async start(): Promise<void> {
        logger.info('Iniciando bot V2...');

        // Verifica saldo
        await this.checkBalance();

        // Marca como rodando ANTES de iniciar polling
        this.isRunning = true;

        // Tenta conectar via WebSocket
        if (BOT_CONFIG_V2.useWebSocket) {
            await this.startWebSocket();
        } else {
            await this.startPolling();
        }

        logger.info('Bot V2 iniciado com sucesso!');
    }

    /**
     * Inicia modo WebSocket
     */
    private async startWebSocket(): Promise<void> {
        const provider = this.multiRpc.getProvider();
        this.wsService = new WebSocketService(provider);

        try {
            const connected = await this.wsService.connect();

            if (connected) {
                // Listener de novos blocos
                this.wsService.on('newBlock', async (block: BlockData) => {
                    await this.processBlock(block.number);
                });

                // Listener de desconexão
                this.wsService.on('disconnected', () => {
                    logger.warn('WebSocket desconectado, alternando para polling...');
                    this.startPolling();
                });

                // Listener de erro de rate limit
                this.wsService.on('maxReconnectAttempts', () => {
                    logger.warn('Máximo de reconexões atingido, alternando para polling...');
                    this.startPolling();
                });

                logger.info('Modo WebSocket ativado');
            } else {
                logger.warn('Falha no WebSocket, usando polling');
                await this.startPolling();
            }
        } catch (error: any) {
            // Captura erros de rate limit do Infura
            if (error.message?.includes('Too Many Requests') || error.code === -32005) {
                logger.warn('Rate limit do WebSocket, alternando para polling...');
            } else {
                logger.error('Erro no WebSocket:', error.message);
            }
            await this.startPolling();
        }
    }

    /**
     * Inicia modo polling
     */
    private async startPolling(): Promise<void> {
        logger.info(`Modo polling ativado (intervalo: ${BOT_CONFIG_V2.monitoringIntervalMs}ms)`);

        const poll = async () => {
            if (!this.isRunning) return;

            try {
                const provider = this.multiRpc.getProvider();
                const blockNumber = await provider.getBlockNumber();

                if (blockNumber > this.stats.lastBlockNumber) {
                    await this.processBlock(blockNumber);
                }
            } catch (error: any) {
                logger.error('Erro no polling:', error.message);
                this.stats.errorsCount++;
            }

            setTimeout(poll, BOT_CONFIG_V2.monitoringIntervalMs);
        };

        poll();
    }

    /**
     * Processa um novo bloco
     */
    private async processBlock(blockNumber: number): Promise<void> {
        this.stats.lastBlockNumber = blockNumber;
        this.stats.blocksProcessed++;

        logger.debug(`Processando bloco ${blockNumber}`);

        try {
            // Verifica gas price
            const provider = this.multiRpc.getProvider();
            const feeData = await provider.getFeeData();
            const gasPriceGwei = feeData.gasPrice
                ? parseFloat(formatUnits(feeData.gasPrice, 'gwei'))
                : 0;

            if (gasPriceGwei > BOT_CONFIG_V2.maxGasPriceGwei) {
                logger.debug(`Gas muito alto: ${gasPriceGwei.toFixed(4)} Gwei`);
                return;
            }

            // Busca oportunidades em paralelo
            const opportunities: ArbitrageOpportunity[] = [];

            // Arbitragem simples
            const simpleOpps = await this.findSimpleArbitrageOpportunities();
            opportunities.push(...simpleOpps);

            // Arbitragem triangular
            if (BOT_CONFIG_V2.enableTriangular) {
                const triangularOpps = await this.findTriangularArbitrageOpportunities();
                opportunities.push(...triangularOpps);
            }

            // Processa oportunidades lucrativas
            for (const opp of opportunities) {
                if (opp.expectedProfitUsd >= BOT_CONFIG_V2.minProfitUsd) {
                    this.stats.opportunitiesFound++;
                    await this.handleOpportunity(opp);
                }
            }

        } catch (error: any) {
            logger.error(`Erro no bloco ${blockNumber}:`, error.message);
            this.stats.errorsCount++;
        }
    }

    /**
     * Busca oportunidades de arbitragem simples (2 swaps)
     */
    private async findSimpleArbitrageOpportunities(): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];

        // Processa pares por prioridade
        const sortedPairs = [...ARBITRAGE_PAIRS].sort((a, b) => a.priority - b.priority);

        // Limita pares processados por ciclo
        const pairsToProcess = sortedPairs.slice(0, BOT_CONFIG_V2.maxConcurrentChecks);

        await Promise.all(
            pairsToProcess.map(async (pair) => {
                try {
                    const opp = await this.checkPairArbitrage(pair);
                    if (opp) {
                        opportunities.push(opp);
                    }
                } catch (error: any) {
                    logger.debug(`Erro no par ${pair.tokenA.symbol}/${pair.tokenB.symbol}: ${error.message}`);
                }
            })
        );

        return opportunities;
    }

    /**
     * Verifica arbitragem para um par específico
     */
    private async checkPairArbitrage(pair: ArbitragePair): Promise<ArbitrageOpportunity | null> {
        // Quantidade de teste baseada no maxAmountUsd
        const testAmountUsd = Math.min(pair.maxAmountUsd, 10000);
        const testAmount = this.usdToTokenAmount(testAmountUsd, pair.tokenA);

        // Busca preços em todas as DEXs
        const quotes: PriceQuote[] = [];

        for (const dex of pair.dexes) {
            try {
                let quote: PriceQuote | null = null;

                if (dex === DEX.UNISWAP_V3) {
                    // Testa diferentes fees
                    for (const fee of pair.uniswapFees) {
                        const uniQuote = await this.getUniswapV3Quote(
                            pair.tokenA.address,
                            pair.tokenB.address,
                            testAmount,
                            fee
                        );
                        if (uniQuote && (!quote || uniQuote.amountOut > quote.amountOut)) {
                            quote = uniQuote;
                        }
                    }
                } else if (dex === DEX.SUSHISWAP) {
                    quote = await this.getSushiSwapQuote(
                        pair.tokenA.address,
                        pair.tokenB.address,
                        testAmount
                    );
                } else if (dex === DEX.CAMELOT) {
                    quote = await this.getCamelotQuote(
                        pair.tokenA.address,
                        pair.tokenB.address,
                        testAmount
                    );
                }

                if (quote) {
                    quotes.push(quote);
                }
            } catch (error) {
                // Pool pode não existir
            }
        }

        if (quotes.length < 2) return null;

        // Encontra melhor compra e venda
        const sortedByPrice = [...quotes].sort((a, b) =>
            Number(b.amountOut - a.amountOut)
        );

        const buyDex = sortedByPrice[0]; // Mais tokenB por tokenA
        const sellDex = sortedByPrice[sortedByPrice.length - 1]; // Menos tokenB por tokenA

        // Verifica se há diferença de preço
        if (buyDex.amountOut <= sellDex.amountOut) return null;

        // Simula arbitragem completa
        const sellQuote = await this.getQuoteForDex(
            sellDex.dex,
            pair.tokenB.address,
            pair.tokenA.address,
            buyDex.amountOut,
            pair.uniswapFees[0] || 3000
        );

        if (!sellQuote) return null;

        // Calcula lucro
        const flashLoanFee = (testAmount * 5n) / 10000n; // 0.05%
        const amountOwed = testAmount + flashLoanFee;
        const profit = sellQuote.amountOut - amountOwed;

        if (profit <= 0n) return null;

        // Calcula lucro em USD
        const profitUsd = this.tokenAmountToUsd(profit, pair.tokenA);
        const profitPercentage = (Number(profit) / Number(testAmount)) * 100;

        if (profitPercentage < pair.minProfitBps / 100) return null;

        return {
            type: 'simple',
            buyDex: buyDex.dex,
            sellDex: sellDex.dex,
            tokenBorrow: pair.tokenA,
            tokenTarget: pair.tokenB,
            amountBorrow: testAmount,
            expectedProfit: profit,
            expectedProfitUsd: profitUsd,
            profitPercentage,
            buyFee: buyDex.fee,
            sellFee: sellDex.fee,
            timestamp: Date.now(),
        };
    }

    /**
     * Busca oportunidades de arbitragem triangular (3 swaps)
     */
    private async findTriangularArbitrageOpportunities(): Promise<ArbitrageOpportunity[]> {
        const opportunities: ArbitrageOpportunity[] = [];

        const sortedRoutes = [...TRIANGULAR_ROUTES].sort((a, b) => a.priority - b.priority);
        const routesToProcess = sortedRoutes.slice(0, 3); // Limita a 3 rotas por ciclo

        await Promise.all(
            routesToProcess.map(async (route) => {
                try {
                    const opp = await this.checkTriangularArbitrage(route);
                    if (opp) {
                        opportunities.push(opp);
                    }
                } catch (error: any) {
                    logger.debug(`Erro na rota ${route.name}: ${error.message}`);
                }
            })
        );

        return opportunities;
    }

    /**
     * Verifica arbitragem triangular para uma rota
     */
    private async checkTriangularArbitrage(route: TriangularRoute): Promise<ArbitrageOpportunity | null> {
        const testAmountUsd = 5000; // Começa com $5k
        const testAmount = this.usdToTokenAmount(testAmountUsd, route.tokenBorrow);

        // Swap 1: tokenBorrow -> tokenMiddle
        const swap1 = await this.getBestQuote(
            route.tokenBorrow.address,
            route.tokenMiddle.address,
            testAmount
        );
        if (!swap1) return null;

        // Swap 2: tokenMiddle -> tokenTarget
        const swap2 = await this.getBestQuote(
            route.tokenMiddle.address,
            route.tokenTarget.address,
            swap1.amountOut
        );
        if (!swap2) return null;

        // Swap 3: tokenTarget -> tokenBorrow
        const swap3 = await this.getBestQuote(
            route.tokenTarget.address,
            route.tokenBorrow.address,
            swap2.amountOut
        );
        if (!swap3) return null;

        // Calcula lucro
        const flashLoanFee = (testAmount * 5n) / 10000n;
        const amountOwed = testAmount + flashLoanFee;
        const profit = swap3.amountOut - amountOwed;

        if (profit <= 0n) return null;

        const profitUsd = this.tokenAmountToUsd(profit, route.tokenBorrow);
        const profitPercentage = (Number(profit) / Number(testAmount)) * 100;

        if (profitPercentage < 0.1) return null; // Mínimo 0.1%

        return {
            type: 'triangular',
            buyDex: swap1.dex,
            sellDex: swap3.dex,
            tokenBorrow: route.tokenBorrow,
            tokenTarget: route.tokenTarget,
            tokenMiddle: route.tokenMiddle,
            amountBorrow: testAmount,
            expectedProfit: profit,
            expectedProfitUsd: profitUsd,
            profitPercentage,
            timestamp: Date.now(),
        };
    }

    /**
     * Obtém a melhor cotação entre todas as DEXs
     */
    private async getBestQuote(
        tokenIn: string,
        tokenOut: string,
        amountIn: bigint
    ): Promise<PriceQuote | null> {
        const quotes: PriceQuote[] = [];

        // Uniswap V3 (testa várias fees)
        for (const fee of [500, 3000, 10000]) {
            try {
                const quote = await this.getUniswapV3Quote(tokenIn, tokenOut, amountIn, fee);
                if (quote) quotes.push(quote);
            } catch {}
        }

        // SushiSwap
        try {
            const quote = await this.getSushiSwapQuote(tokenIn, tokenOut, amountIn);
            if (quote) quotes.push(quote);
        } catch {}

        // Camelot
        try {
            const quote = await this.getCamelotQuote(tokenIn, tokenOut, amountIn);
            if (quote) quotes.push(quote);
        } catch {}

        if (quotes.length === 0) return null;

        // Retorna melhor cotação
        return quotes.reduce((best, current) =>
            current.amountOut > best.amountOut ? current : best
        );
    }

    /**
     * Obtém cotação do Uniswap V3
     */
    private async getUniswapV3Quote(
        tokenIn: string,
        tokenOut: string,
        amountIn: bigint,
        fee: number
    ): Promise<PriceQuote | null> {
        try {
            const amountOut = await this.multiRpc.executeWithRetry(async (provider) => {
                const quoter = new Contract(
                    DEX_INFO[DEX.UNISWAP_V3].quoter,
                    UNISWAP_QUOTER_ABI,
                    provider
                );

                // QuoterV2 expects a struct parameter
                const result = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn,
                    tokenOut,
                    amountIn,
                    fee,
                    sqrtPriceLimitX96: 0n
                });
                // Returns tuple: (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
                return result[0];
            });

            return {
                dex: DEX.UNISWAP_V3,
                dexName: 'Uniswap V3',
                amountIn,
                amountOut,
                fee,
                pricePerToken: Number(amountOut) / Number(amountIn),
            };
        } catch {
            return null;
        }
    }

    /**
     * Obtém cotação do SushiSwap
     */
    private async getSushiSwapQuote(
        tokenIn: string,
        tokenOut: string,
        amountIn: bigint
    ): Promise<PriceQuote | null> {
        try {
            const amounts = await this.multiRpc.executeWithRetry(async (provider) => {
                const router = new Contract(
                    DEX_INFO[DEX.SUSHISWAP].router,
                    SUSHISWAP_ROUTER_ABI,
                    provider
                );

                return await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
            });

            return {
                dex: DEX.SUSHISWAP,
                dexName: 'SushiSwap',
                amountIn,
                amountOut: amounts[1],
                pricePerToken: Number(amounts[1]) / Number(amountIn),
            };
        } catch {
            return null;
        }
    }

    /**
     * Obtém cotação do Camelot
     */
    private async getCamelotQuote(
        tokenIn: string,
        tokenOut: string,
        amountIn: bigint
    ): Promise<PriceQuote | null> {
        try {
            const amounts = await this.multiRpc.executeWithRetry(async (provider) => {
                const router = new Contract(
                    DEX_INFO[DEX.CAMELOT].router,
                    CAMELOT_ROUTER_ABI,
                    provider
                );

                return await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
            });

            return {
                dex: DEX.CAMELOT,
                dexName: 'Camelot',
                amountIn,
                amountOut: amounts[1],
                pricePerToken: Number(amounts[1]) / Number(amountIn),
            };
        } catch {
            return null;
        }
    }

    /**
     * Obtém cotação genérica para uma DEX
     */
    private async getQuoteForDex(
        dex: DEX,
        tokenIn: string,
        tokenOut: string,
        amountIn: bigint,
        fee: number
    ): Promise<PriceQuote | null> {
        switch (dex) {
            case DEX.UNISWAP_V3:
                return this.getUniswapV3Quote(tokenIn, tokenOut, amountIn, fee);
            case DEX.SUSHISWAP:
                return this.getSushiSwapQuote(tokenIn, tokenOut, amountIn);
            case DEX.CAMELOT:
                return this.getCamelotQuote(tokenIn, tokenOut, amountIn);
            default:
                return null;
        }
    }

    /**
     * Processa uma oportunidade de arbitragem
     */
    private async handleOpportunity(opp: ArbitrageOpportunity): Promise<void> {
        const dexNames: Record<DEX, string> = {
            [DEX.UNISWAP_V3]: 'Uniswap',
            [DEX.SUSHISWAP]: 'SushiSwap',
            [DEX.CAMELOT]: 'Camelot',
            [DEX.BALANCER]: 'Balancer',
            [DEX.CURVE_2POOL]: 'Curve 2pool',
            [DEX.CURVE_TRICRYPTO]: 'Curve Tricrypto',
        };

        logger.info('='.repeat(60));
        logger.info(`OPORTUNIDADE ENCONTRADA! (${opp.type})`);
        logger.info('='.repeat(60));

        if (opp.type === 'simple') {
            logger.info(`Par: ${opp.tokenBorrow.symbol} / ${opp.tokenTarget.symbol}`);
            logger.info(`Comprar em: ${dexNames[opp.buyDex]}`);
            logger.info(`Vender em: ${dexNames[opp.sellDex]}`);
        } else {
            logger.info(`Rota: ${opp.tokenBorrow.symbol} -> ${opp.tokenMiddle?.symbol} -> ${opp.tokenTarget.symbol}`);
        }

        logger.info(`Valor: ${formatUnits(opp.amountBorrow, opp.tokenBorrow.decimals)} ${opp.tokenBorrow.symbol}`);
        logger.info(`Lucro esperado: $${opp.expectedProfitUsd.toFixed(2)} (${opp.profitPercentage.toFixed(3)}%)`);

        if (BOT_CONFIG_V2.simulationMode) {
            logger.info('[SIMULAÇÃO] Transação não executada');
            return;
        }

        // Executa arbitragem real
        if (this.flashLoanContract) {
            try {
                await this.executeArbitrage(opp);
                this.stats.opportunitiesExecuted++;
                this.stats.totalProfitUsd += opp.expectedProfitUsd;
            } catch (error: any) {
                logger.error('Erro ao executar arbitragem:', error.message);
                this.stats.errorsCount++;
            }
        } else {
            logger.warn('Contrato de flash loan não configurado');
        }
    }

    /**
     * Executa a arbitragem via smart contract
     */
    private async executeArbitrage(opp: ArbitrageOpportunity): Promise<void> {
        if (!this.flashLoanContract) return;

        logger.info('Executando arbitragem...');

        if (opp.type === 'simple') {
            const params = {
                tokenBorrow: opp.tokenBorrow.address,
                tokenTarget: opp.tokenTarget.address,
                amountBorrow: opp.amountBorrow,
                dexBuy: opp.buyDex,
                dexSell: opp.sellDex,
                uniswapFeeBuy: opp.buyFee || 3000,
                uniswapFeeSell: opp.sellFee || 3000,
                minProfit: opp.expectedProfit / 2n, // 50% do esperado como mínimo
            };

            const tx = await this.flashLoanContract.executeArbitrage(params);
            logger.info(`Transação enviada: ${tx.hash}`);

            const receipt = await tx.wait();
            logger.info(`Transação confirmada! Gas usado: ${receipt.gasUsed.toString()}`);
        } else if (opp.type === 'triangular' && opp.tokenMiddle) {
            const params = {
                tokenBorrow: opp.tokenBorrow.address,
                tokenMiddle: opp.tokenMiddle.address,
                tokenTarget: opp.tokenTarget.address,
                amountBorrow: opp.amountBorrow,
                dex1: opp.buyDex,
                dex2: DEX.UNISWAP_V3, // Usar melhor DEX para cada leg
                dex3: opp.sellDex,
                fee1: 3000,
                fee2: 3000,
                fee3: 3000,
                minProfit: opp.expectedProfit / 2n,
            };

            const tx = await this.flashLoanContract.executeTriangularArbitrage(params);
            logger.info(`Transação enviada: ${tx.hash}`);

            const receipt = await tx.wait();
            logger.info(`Transação confirmada! Gas usado: ${receipt.gasUsed.toString()}`);
        }
    }

    /**
     * Verifica saldo da carteira
     */
    private async checkBalance(): Promise<void> {
        const provider = this.multiRpc.getProvider();
        const balance = await provider.getBalance(this.wallet.address);

        logger.info(`Saldo ETH: ${formatEther(balance)} ETH`);

        if (balance < parseUnits('0.01', 18)) {
            logger.warn('Saldo ETH baixo! Recomendado mínimo 0.01 ETH para gas');
        }
    }

    /**
     * Converte USD para quantidade de token
     */
    private usdToTokenAmount(usd: number, token: TokenInfo): bigint {
        // Preços aproximados (em produção, buscar de oracle)
        const prices: Record<string, number> = {
            'WETH': 2000,
            'USDC': 1,
            'USDC.e': 1,
            'USDT': 1,
            'DAI': 1,
            'ARB': 1,
            'WBTC': 40000,
            'GMX': 30,
            'MAGIC': 0.5,
            'RDNT': 0.1,
            'PENDLE': 3,
            'GRAIL': 1000,
            'LINK': 15,
            'UNI': 8,
            'wstETH': 2200,
            'rETH': 2100,
            'FRAX': 1,
            'MIM': 1,
            'LUSD': 1,
        };

        const price = prices[token.symbol] || 1;
        const amount = usd / price;

        return parseUnits(amount.toFixed(token.decimals), token.decimals);
    }

    /**
     * Converte quantidade de token para USD
     */
    private tokenAmountToUsd(amount: bigint, token: TokenInfo): number {
        const prices: Record<string, number> = {
            'WETH': 2000,
            'USDC': 1,
            'USDC.e': 1,
            'USDT': 1,
            'DAI': 1,
            'ARB': 1,
            'WBTC': 40000,
            'GMX': 30,
            'MAGIC': 0.5,
            'RDNT': 0.1,
            'PENDLE': 3,
            'GRAIL': 1000,
            'LINK': 15,
            'UNI': 8,
            'wstETH': 2200,
            'rETH': 2100,
            'FRAX': 1,
            'MIM': 1,
            'LUSD': 1,
        };

        const price = prices[token.symbol] || 1;
        const amountFormatted = parseFloat(formatUnits(amount, token.decimals));

        return amountFormatted * price;
    }

    /**
     * Exibe estatísticas
     */
    printStats(): void {
        const runtime = (Date.now() - this.stats.startTime) / 1000 / 60;
        const rpcStatus = this.multiRpc.getStatus();

        logger.info('='.repeat(60));
        logger.info('ESTATÍSTICAS DO BOT V2');
        logger.info('='.repeat(60));
        logger.info(`Tempo de execução: ${runtime.toFixed(1)} minutos`);
        logger.info(`Blocos processados: ${this.stats.blocksProcessed}`);
        logger.info(`Oportunidades encontradas: ${this.stats.opportunitiesFound}`);
        logger.info(`Oportunidades executadas: ${this.stats.opportunitiesExecuted}`);
        logger.info(`Lucro total: $${this.stats.totalProfitUsd.toFixed(2)}`);
        logger.info(`Erros: ${this.stats.errorsCount}`);
        logger.info(`RPCs: ${rpcStatus.healthy}/${rpcStatus.total} saudáveis`);
        logger.info('='.repeat(60));
    }

    /**
     * Para o bot
     */
    async stop(): Promise<void> {
        this.isRunning = false;

        if (this.wsService) {
            await this.wsService.disconnect();
        }

        this.printStats();
        logger.info('Bot V2 parado');
    }
}

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================

async function main() {
    let bot: ArbitrageBotV2 | null = null;
    let usePollingFallback = false;

    // Handler global para erros não tratados (WebSocket rate limit, etc)
    process.on('unhandledRejection', async (reason: any) => {
        // Verifica se é rate limit do WebSocket
        if (reason?.message?.includes('Too Many Requests') || reason?.error?.code === -32005) {
            logger.warn('Rate limit detectado, alternando para polling...');
            if (!usePollingFallback) {
                usePollingFallback = true;
                // Desativa WebSocket no config para este ciclo
                BOT_CONFIG_V2.useWebSocket = false;
            }
        } else {
            logger.error('Erro não tratado:', reason?.message || reason);
        }
    });

    bot = new ArbitrageBotV2();

    // Handlers de sinal
    process.on('SIGINT', async () => {
        logger.info('Recebido SIGINT, parando bot...');
        if (bot) await bot.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Recebido SIGTERM, parando bot...');
        if (bot) await bot.stop();
        process.exit(0);
    });

    // Exibe estatísticas periodicamente
    setInterval(() => {
        if (bot) bot.printStats();
    }, 60000); // A cada 1 minuto

    // Inicia o bot
    await bot.start();
}

main().catch((error) => {
    logger.error('Erro fatal:', error);
    process.exit(1);
});

export { ArbitrageBotV2 };
