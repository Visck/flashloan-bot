/**
 * ============================================================================
 * SERVIÇO DE PREÇOS - BOT DE ARBITRAGEM
 * ============================================================================
 *
 * Este módulo é responsável por:
 * - Obter preços dos tokens em diferentes DEXs
 * - Calcular oportunidades de arbitragem
 * - Estimar custos de gas
 * - Simular lucratividade
 *
 * FLUXO DE OPERAÇÃO:
 * 1. Consulta preço no Uniswap V3 (usando Quoter)
 * 2. Consulta preço no SushiSwap (usando getAmountsOut)
 * 3. Compara os preços
 * 4. Calcula lucro potencial
 * 5. Desconta custos de gas e taxas
 * 6. Retorna oportunidade se lucrativa
 */

import { ethers, Contract, Provider, formatUnits, parseUnits } from 'ethers';
import {
    CONTRACTS,
    TOKENS,
    TokenInfo,
    DEX,
    BOT_CONFIG,
    UNISWAP_QUOTER_ABI,
    SUSHISWAP_ROUTER_ABI,
    UNISWAP_FACTORY_ABI,
    UNISWAP_POOL_ABI,
    ERC20_ABI,
} from './config';
import { logger } from './logger';

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Resultado de uma cotação de preço
 */
export interface PriceQuote {
    dex: DEX;                    // DEX consultada
    tokenIn: TokenInfo;          // Token de entrada
    tokenOut: TokenInfo;         // Token de saída
    amountIn: bigint;            // Quantidade de entrada (em wei)
    amountOut: bigint;           // Quantidade de saída (em wei)
    price: number;               // Preço (tokenOut/tokenIn)
    priceImpact: number;         // Impacto no preço (%)
    fee: number;                 // Taxa da DEX
    timestamp: number;           // Timestamp da cotação
}

/**
 * Oportunidade de arbitragem identificada
 */
export interface ArbitrageOpportunity {
    id: string;                  // ID único da oportunidade
    tokenBorrow: TokenInfo;      // Token a emprestar via flash loan
    tokenTarget: TokenInfo;      // Token intermediário
    amountBorrow: bigint;        // Quantidade a emprestar
    dexBuy: DEX;                 // DEX para comprar (preço mais baixo)
    dexSell: DEX;                // DEX para vender (preço mais alto)
    buyQuote: PriceQuote;        // Cotação de compra
    sellQuote: PriceQuote;       // Cotação de venda
    uniswapFeeBuy: number;       // Taxa Uniswap para compra
    uniswapFeeSell: number;      // Taxa Uniswap para venda
    expectedProfit: bigint;      // Lucro esperado (em wei do tokenBorrow)
    expectedProfitUsd: number;   // Lucro esperado em USD
    profitPercentage: number;    // Lucro em porcentagem
    estimatedGasCost: bigint;    // Custo de gas estimado (em ETH)
    estimatedGasCostUsd: number; // Custo de gas em USD
    netProfitUsd: number;        // Lucro líquido após gas
    timestamp: number;           // Timestamp da oportunidade
}

// ============================================================================
// CLASSE PRINCIPAL
// ============================================================================

/**
 * Serviço de preços para monitoramento e cálculo de arbitragem
 */
export class PriceService {
    private provider: Provider;
    private uniswapQuoter: Contract;
    private uniswapFactory: Contract;
    private sushiRouter: Contract;

    // Cache de preços para evitar chamadas repetidas
    private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
    private readonly CACHE_TTL_MS = 2000; // 2 segundos

    constructor(provider: Provider) {
        this.provider = provider;

        // Inicializa contratos
        this.uniswapQuoter = new Contract(
            CONTRACTS.uniswap.quoterV2,
            UNISWAP_QUOTER_ABI,
            provider
        );

        this.uniswapFactory = new Contract(
            CONTRACTS.uniswap.factory,
            UNISWAP_FACTORY_ABI,
            provider
        );

        this.sushiRouter = new Contract(
            CONTRACTS.sushiswap.router,
            SUSHISWAP_ROUTER_ABI,
            provider
        );
    }

    // ============================================================================
    // MÉTODOS PÚBLICOS
    // ============================================================================

    /**
     * Obtém cotação de preço no Uniswap V3
     *
     * @param tokenIn Token de entrada
     * @param tokenOut Token de saída
     * @param amountIn Quantidade de entrada
     * @param fee Taxa do pool (500, 3000, 10000)
     * @returns Cotação de preço ou null se falhar
     *
     * COMO FUNCIONA:
     * - Usa o QuoterV2 para simular o swap
     * - QuoterV2 executa o swap internamente e reverte
     * - A reversão retorna os valores calculados
     * - Tudo via eth_call, sem gastar gas
     */
    async getUniswapV3Quote(
        tokenIn: TokenInfo,
        tokenOut: TokenInfo,
        amountIn: bigint,
        fee: number = 3000
    ): Promise<PriceQuote | null> {
        try {
            // Parâmetros para o Quoter
            const params = {
                tokenIn: tokenIn.address,
                tokenOut: tokenOut.address,
                amountIn: amountIn,
                fee: fee,
                sqrtPriceLimitX96: 0n, // Sem limite de preço
            };

            // Chama o Quoter (simula o swap)
            const result = await this.uniswapQuoter.quoteExactInputSingle.staticCall(params);

            const amountOut = result[0] as bigint;

            // Calcula o preço
            const amountInFormatted = parseFloat(formatUnits(amountIn, tokenIn.decimals));
            const amountOutFormatted = parseFloat(formatUnits(amountOut, tokenOut.decimals));
            const price = amountOutFormatted / amountInFormatted;

            // Calcula o impacto no preço (aproximado)
            // Para uma estimativa real, seria necessário comparar com o preço spot
            const priceImpact = this.estimatePriceImpact(amountIn, tokenIn);

            return {
                dex: DEX.UNISWAP_V3,
                tokenIn,
                tokenOut,
                amountIn,
                amountOut,
                price,
                priceImpact,
                fee: fee / 10000, // Converte para porcentagem
                timestamp: Date.now(),
            };
        } catch (error) {
            logger.debug(`Erro ao obter cotação Uniswap V3: ${error}`);
            return null;
        }
    }

    /**
     * Obtém cotação de preço no SushiSwap
     *
     * @param tokenIn Token de entrada
     * @param tokenOut Token de saída
     * @param amountIn Quantidade de entrada
     * @returns Cotação de preço ou null se falhar
     *
     * COMO FUNCIONA:
     * - Usa getAmountsOut do router
     * - Calcula usando a fórmula x*y=k
     * - Considera a taxa de 0.3%
     */
    async getSushiSwapQuote(
        tokenIn: TokenInfo,
        tokenOut: TokenInfo,
        amountIn: bigint
    ): Promise<PriceQuote | null> {
        try {
            // Define a rota (swap direto)
            const path = [tokenIn.address, tokenOut.address];

            // Obtém os valores de saída
            const amounts = await this.sushiRouter.getAmountsOut(amountIn, path);

            const amountOut = amounts[1] as bigint;

            // Calcula o preço
            const amountInFormatted = parseFloat(formatUnits(amountIn, tokenIn.decimals));
            const amountOutFormatted = parseFloat(formatUnits(amountOut, tokenOut.decimals));
            const price = amountOutFormatted / amountInFormatted;

            // Calcula o impacto no preço
            const priceImpact = this.estimatePriceImpact(amountIn, tokenIn);

            return {
                dex: DEX.SUSHISWAP,
                tokenIn,
                tokenOut,
                amountIn,
                amountOut,
                price,
                priceImpact,
                fee: 0.003, // 0.3% fixo no SushiSwap
                timestamp: Date.now(),
            };
        } catch (error) {
            logger.debug(`Erro ao obter cotação SushiSwap: ${error}`);
            return null;
        }
    }

    /**
     * Busca oportunidade de arbitragem entre duas DEXs
     *
     * @param tokenBorrow Token a ser emprestado via flash loan
     * @param tokenTarget Token intermediário para arbitragem
     * @param amountBorrow Quantidade a emprestar
     * @param uniswapFee Taxa do pool Uniswap
     * @returns Oportunidade de arbitragem ou null se não houver
     *
     * ESTRATÉGIA:
     * 1. Obtém preço de compra em ambas as DEXs
     * 2. Identifica onde está mais barato
     * 3. Calcula lucro potencial
     * 4. Retorna se lucrativo após custos
     */
    async findArbitrageOpportunity(
        tokenBorrow: TokenInfo,
        tokenTarget: TokenInfo,
        amountBorrow: bigint,
        uniswapFee: number = 3000
    ): Promise<ArbitrageOpportunity | null> {
        try {
            // ========== PASSO 1: OBTER COTAÇÕES ==========

            // Cotação Uniswap V3: tokenBorrow -> tokenTarget
            const uniswapBuyQuote = await this.getUniswapV3Quote(
                tokenBorrow,
                tokenTarget,
                amountBorrow,
                uniswapFee
            );

            // Cotação SushiSwap: tokenBorrow -> tokenTarget
            const sushiBuyQuote = await this.getSushiSwapQuote(
                tokenBorrow,
                tokenTarget,
                amountBorrow
            );

            // Verifica se obteve ambas as cotações
            if (!uniswapBuyQuote || !sushiBuyQuote) {
                logger.debug('Não foi possível obter cotações para ambas as DEXs');
                return null;
            }

            // ========== PASSO 2: IDENTIFICAR DIREÇÃO ==========

            // Determina onde comprar (preço mais alto = mais tokenTarget por tokenBorrow)
            // e onde vender (preço mais baixo = precisa de menos tokenTarget para receber tokenBorrow)
            let dexBuy: DEX;
            let dexSell: DEX;
            let buyQuote: PriceQuote;
            let sellQuote: PriceQuote;
            let amountAfterBuy: bigint;

            // Se Uniswap dá mais tokenTarget, compra no Uniswap e vende no Sushi
            if (uniswapBuyQuote.amountOut > sushiBuyQuote.amountOut) {
                dexBuy = DEX.UNISWAP_V3;
                dexSell = DEX.SUSHISWAP;
                buyQuote = uniswapBuyQuote;
                amountAfterBuy = uniswapBuyQuote.amountOut;
            } else {
                dexBuy = DEX.SUSHISWAP;
                dexSell = DEX.UNISWAP_V3;
                buyQuote = sushiBuyQuote;
                amountAfterBuy = sushiBuyQuote.amountOut;
            }

            // ========== PASSO 3: SIMULAR VENDA ==========

            // Agora simula vender o tokenTarget de volta para tokenBorrow na outra DEX
            let sellQuoteResult: PriceQuote | null;

            if (dexSell === DEX.UNISWAP_V3) {
                sellQuoteResult = await this.getUniswapV3Quote(
                    tokenTarget,
                    tokenBorrow,
                    amountAfterBuy,
                    uniswapFee
                );
            } else {
                sellQuoteResult = await this.getSushiSwapQuote(
                    tokenTarget,
                    tokenBorrow,
                    amountAfterBuy
                );
            }

            if (!sellQuoteResult) {
                logger.debug('Não foi possível obter cotação de venda');
                return null;
            }

            sellQuote = sellQuoteResult;

            // ========== PASSO 4: CALCULAR LUCRO ==========

            // Quantidade recebida após vender
            const amountReceived = sellQuote.amountOut;

            // Taxa do flash loan (0.05% no Aave V3)
            const flashLoanFee = (amountBorrow * 5n) / 10000n;

            // Quantidade total a devolver ao Aave
            const amountOwed = amountBorrow + flashLoanFee;

            // Lucro bruto
            let profit = 0n;
            if (amountReceived > amountOwed) {
                profit = amountReceived - amountOwed;
            }

            // Lucro em porcentagem
            const profitPercentage = Number(profit * 10000n / amountBorrow) / 100;

            // ========== PASSO 5: ESTIMAR GAS ==========

            // Estimativa de gas para a operação completa
            // Flash loan + 2 swaps ~ 500k gas
            const estimatedGas = 500000n;
            const gasPrice = await this.getGasPrice();
            const estimatedGasCost = estimatedGas * gasPrice;

            // ========== PASSO 6: CONVERTER PARA USD ==========

            // Obtém preço de ETH em USD (para calcular custo de gas)
            const ethPriceUsd = await this.getEthPriceUsd();

            // Obtém preço do tokenBorrow em USD
            const tokenPriceUsd = await this.getTokenPriceUsd(tokenBorrow);

            // Lucro em USD
            const profitFormatted = parseFloat(formatUnits(profit, tokenBorrow.decimals));
            const expectedProfitUsd = profitFormatted * tokenPriceUsd;

            // Custo de gas em USD
            const gasCostEth = parseFloat(formatUnits(estimatedGasCost, 18));
            const estimatedGasCostUsd = gasCostEth * ethPriceUsd;

            // Lucro líquido
            const netProfitUsd = expectedProfitUsd - estimatedGasCostUsd;

            // ========== PASSO 7: CRIAR OPORTUNIDADE ==========

            const opportunity: ArbitrageOpportunity = {
                id: `${tokenBorrow.symbol}-${tokenTarget.symbol}-${Date.now()}`,
                tokenBorrow,
                tokenTarget,
                amountBorrow,
                dexBuy,
                dexSell,
                buyQuote,
                sellQuote,
                uniswapFeeBuy: dexBuy === DEX.UNISWAP_V3 ? uniswapFee : 0,
                uniswapFeeSell: dexSell === DEX.UNISWAP_V3 ? uniswapFee : 0,
                expectedProfit: profit,
                expectedProfitUsd,
                profitPercentage,
                estimatedGasCost,
                estimatedGasCostUsd,
                netProfitUsd,
                timestamp: Date.now(),
            };

            // Verifica se é lucrativo
            if (netProfitUsd < BOT_CONFIG.minProfitUsd) {
                logger.debug(
                    `Oportunidade não lucrativa: $${netProfitUsd.toFixed(2)} < $${BOT_CONFIG.minProfitUsd}`
                );
                return null;
            }

            if (profitPercentage < BOT_CONFIG.minProfitPercentage) {
                logger.debug(
                    `Porcentagem de lucro insuficiente: ${profitPercentage.toFixed(2)}% < ${BOT_CONFIG.minProfitPercentage}%`
                );
                return null;
            }

            return opportunity;
        } catch (error) {
            logger.error(`Erro ao buscar oportunidade de arbitragem: ${error}`);
            return null;
        }
    }

    /**
     * Obtém o preço atual do gas
     * @returns Gas price em wei
     */
    async getGasPrice(): Promise<bigint> {
        try {
            const feeData = await this.provider.getFeeData();
            return feeData.gasPrice || parseUnits('0.1', 'gwei'); // Default 0.1 Gwei na Arbitrum
        } catch {
            return parseUnits('0.1', 'gwei');
        }
    }

    /**
     * Obtém o preço do ETH em USD
     * @returns Preço em USD
     *
     * NOTA: Em produção, use um oracle como Chainlink
     * Esta é uma estimativa simplificada
     */
    async getEthPriceUsd(): Promise<number> {
        try {
            // Usa o par WETH/USDC para estimar
            const quote = await this.getUniswapV3Quote(
                TOKENS.WETH,
                TOKENS.USDC_E,
                parseUnits('1', 18), // 1 ETH
                500 // Pool de 0.05%
            );

            if (quote) {
                return quote.price;
            }

            return 2000; // Fallback
        } catch {
            return 2000; // Fallback
        }
    }

    /**
     * Obtém o preço de um token em USD
     * @param token Token para consultar
     * @returns Preço em USD
     */
    async getTokenPriceUsd(token: TokenInfo): Promise<number> {
        // Se é USDC ou USDT, retorna 1
        if (token.symbol.includes('USD')) {
            return 1;
        }

        // Se é WETH, obtém preço do ETH
        if (token.symbol === 'WETH') {
            return this.getEthPriceUsd();
        }

        try {
            // Para outros tokens, usa par com USDC
            const quote = await this.getUniswapV3Quote(
                token,
                TOKENS.USDC_E,
                parseUnits('1', token.decimals),
                3000
            );

            if (quote) {
                return quote.price;
            }

            return 0;
        } catch {
            return 0;
        }
    }

    // ============================================================================
    // MÉTODOS PRIVADOS
    // ============================================================================

    /**
     * Estima o impacto no preço de um swap
     * @param amountIn Quantidade de entrada
     * @param token Token de entrada
     * @returns Impacto estimado em porcentagem
     */
    private estimatePriceImpact(amountIn: bigint, token: TokenInfo): number {
        // Estimativa simplificada baseada no tamanho do swap
        // Em produção, compare com o preço spot do pool
        const amountUsd = parseFloat(formatUnits(amountIn, token.decimals));

        // Assume ~0.1% de impacto para cada $10k
        return (amountUsd / 10000) * 0.1;
    }
}
