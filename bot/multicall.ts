/**
 * ============================================================================
 * MULTICALL SERVICE - AGRUPA CHAMADAS RPC
 * ============================================================================
 *
 * Usa Multicall3 para executar múltiplas chamadas em uma única request.
 * Reduz latência de 500ms+ para ~50ms.
 *
 * Multicall3 na Arbitrum: 0xcA11bde05977b3631167028862bE2a173976CA11
 */

import { Contract, JsonRpcProvider, Interface, formatUnits } from 'ethers';
import { logger } from './logger';

// ============================================================================
// CONSTANTES
// ============================================================================

// Multicall3 - Mesmo endereço em todas as chains EVM
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])',
    'function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
];

// ABIs das DEXs para encoding
const UNISWAP_QUOTER_ABI = [
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const SUSHISWAP_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
];

const CAMELOT_ROUTER_ABI = [
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
];

// ============================================================================
// INTERFACES
// ============================================================================

interface Call {
    target: string;
    allowFailure: boolean;
    callData: string;
}

interface CallResult {
    success: boolean;
    returnData: string;
}

interface QuoteRequest {
    dex: 'uniswap' | 'sushiswap' | 'camelot';
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    fee?: number; // Apenas para Uniswap
}

interface QuoteResult {
    dex: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOut: bigint | null;
    success: boolean;
    fee?: number;
}

// ============================================================================
// ENDEREÇOS
// ============================================================================

const DEX_ADDRESSES = {
    uniswapQuoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    sushiRouter: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
    camelotRouter: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
};

// ============================================================================
// CLASSE PRINCIPAL
// ============================================================================

export class MulticallService {
    private provider: JsonRpcProvider;
    private multicall: Contract;
    private uniswapInterface: Interface;
    private sushiInterface: Interface;
    private camelotInterface: Interface;

    constructor(provider: JsonRpcProvider) {
        this.provider = provider;
        this.multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
        this.uniswapInterface = new Interface(UNISWAP_QUOTER_ABI);
        this.sushiInterface = new Interface(SUSHISWAP_ROUTER_ABI);
        this.camelotInterface = new Interface(CAMELOT_ROUTER_ABI);
    }

    /**
     * Executa múltiplas chamadas em uma única request
     */
    async aggregate(calls: Call[]): Promise<CallResult[]> {
        try {
            const results = await this.multicall.aggregate3(calls);
            return results.map((r: any) => ({
                success: r.success,
                returnData: r.returnData,
            }));
        } catch (error) {
            logger.error('Erro no Multicall:', error);
            throw error;
        }
    }

    /**
     * Obtém múltiplas cotações de uma vez
     */
    async getQuotes(requests: QuoteRequest[]): Promise<QuoteResult[]> {
        const calls: Call[] = [];
        const requestMap: Map<number, QuoteRequest> = new Map();

        // Prepara as chamadas
        for (let i = 0; i < requests.length; i++) {
            const req = requests[i];
            requestMap.set(i, req);

            let callData: string;
            let target: string;

            switch (req.dex) {
                case 'uniswap':
                    target = DEX_ADDRESSES.uniswapQuoter;
                    callData = this.uniswapInterface.encodeFunctionData('quoteExactInputSingle', [{
                        tokenIn: req.tokenIn,
                        tokenOut: req.tokenOut,
                        amountIn: req.amountIn,
                        fee: req.fee || 3000,
                        sqrtPriceLimitX96: 0n,
                    }]);
                    break;

                case 'sushiswap':
                    target = DEX_ADDRESSES.sushiRouter;
                    callData = this.sushiInterface.encodeFunctionData('getAmountsOut', [
                        req.amountIn,
                        [req.tokenIn, req.tokenOut],
                    ]);
                    break;

                case 'camelot':
                    target = DEX_ADDRESSES.camelotRouter;
                    callData = this.camelotInterface.encodeFunctionData('getAmountsOut', [
                        req.amountIn,
                        [req.tokenIn, req.tokenOut],
                    ]);
                    break;

                default:
                    continue;
            }

            calls.push({
                target,
                allowFailure: true, // Permite falhas individuais
                callData,
            });
        }

        // Executa multicall
        const results = await this.aggregate(calls);

        // Processa resultados
        const quotes: QuoteResult[] = [];

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const req = requestMap.get(i)!;

            if (!result.success) {
                quotes.push({
                    dex: req.dex,
                    tokenIn: req.tokenIn,
                    tokenOut: req.tokenOut,
                    amountIn: req.amountIn,
                    amountOut: null,
                    success: false,
                    fee: req.fee,
                });
                continue;
            }

            try {
                let amountOut: bigint;

                switch (req.dex) {
                    case 'uniswap':
                        const uniResult = this.uniswapInterface.decodeFunctionResult(
                            'quoteExactInputSingle',
                            result.returnData
                        );
                        amountOut = uniResult[0];
                        break;

                    case 'sushiswap':
                        const sushiResult = this.sushiInterface.decodeFunctionResult(
                            'getAmountsOut',
                            result.returnData
                        );
                        amountOut = sushiResult[0][1];
                        break;

                    case 'camelot':
                        const camelotResult = this.camelotInterface.decodeFunctionResult(
                            'getAmountsOut',
                            result.returnData
                        );
                        amountOut = camelotResult[0][1];
                        break;

                    default:
                        amountOut = 0n;
                }

                quotes.push({
                    dex: req.dex,
                    tokenIn: req.tokenIn,
                    tokenOut: req.tokenOut,
                    amountIn: req.amountIn,
                    amountOut,
                    success: true,
                    fee: req.fee,
                });
            } catch (error) {
                quotes.push({
                    dex: req.dex,
                    tokenIn: req.tokenIn,
                    tokenOut: req.tokenOut,
                    amountIn: req.amountIn,
                    amountOut: null,
                    success: false,
                    fee: req.fee,
                });
            }
        }

        return quotes;
    }

    /**
     * Busca cotações para um par em todas as DEXs
     */
    async getAllQuotesForPair(
        tokenIn: string,
        tokenOut: string,
        amountIn: bigint,
        uniswapFees: number[] = [500, 3000, 10000]
    ): Promise<QuoteResult[]> {
        const requests: QuoteRequest[] = [];

        // Uniswap com diferentes fees
        for (const fee of uniswapFees) {
            requests.push({
                dex: 'uniswap',
                tokenIn,
                tokenOut,
                amountIn,
                fee,
            });
        }

        // SushiSwap
        requests.push({
            dex: 'sushiswap',
            tokenIn,
            tokenOut,
            amountIn,
        });

        // Camelot
        requests.push({
            dex: 'camelot',
            tokenIn,
            tokenOut,
            amountIn,
        });

        return this.getQuotes(requests);
    }

    /**
     * Encontra a melhor cotação entre todas as DEXs
     */
    async getBestQuote(
        tokenIn: string,
        tokenOut: string,
        amountIn: bigint
    ): Promise<QuoteResult | null> {
        const quotes = await this.getAllQuotesForPair(tokenIn, tokenOut, amountIn);

        const validQuotes = quotes.filter(q => q.success && q.amountOut !== null);

        if (validQuotes.length === 0) {
            return null;
        }

        // Retorna a que dá mais tokens de saída
        return validQuotes.reduce((best, current) =>
            current.amountOut! > best.amountOut! ? current : best
        );
    }

    /**
     * Busca oportunidade de arbitragem para um par
     */
    async findArbitrageOpportunity(
        tokenA: string,
        tokenB: string,
        amountIn: bigint
    ): Promise<{
        profitable: boolean;
        profit: bigint;
        buyDex: string;
        sellDex: string;
        buyFee?: number;
        sellFee?: number;
    } | null> {
        // Busca preços em todas as DEXs (compra: A -> B)
        const buyQuotes = await this.getAllQuotesForPair(tokenA, tokenB, amountIn);
        const validBuyQuotes = buyQuotes.filter(q => q.success && q.amountOut !== null);

        if (validBuyQuotes.length < 2) {
            return null;
        }

        // Ordena por melhor preço (mais B por A)
        validBuyQuotes.sort((a, b) => Number(b.amountOut! - a.amountOut!));

        const bestBuy = validBuyQuotes[0];
        const amountB = bestBuy.amountOut!;

        // Busca preços para venda (B -> A)
        const sellQuotes = await this.getAllQuotesForPair(tokenB, tokenA, amountB);
        const validSellQuotes = sellQuotes.filter(q => q.success && q.amountOut !== null);

        if (validSellQuotes.length === 0) {
            return null;
        }

        // Encontra melhor preço de venda (mais A por B)
        const bestSell = validSellQuotes.reduce((best, current) =>
            current.amountOut! > best.amountOut! ? current : best
        );

        const amountFinal = bestSell.amountOut!;

        // Calcula lucro (desconta taxa do flash loan 0.05%)
        const flashLoanFee = (amountIn * 5n) / 10000n;
        const amountOwed = amountIn + flashLoanFee;
        const profit = amountFinal > amountOwed ? amountFinal - amountOwed : 0n;

        return {
            profitable: profit > 0n,
            profit,
            buyDex: bestBuy.dex,
            sellDex: bestSell.dex,
            buyFee: bestBuy.fee,
            sellFee: bestSell.fee,
        };
    }
}

// ============================================================================
// SINGLETON
// ============================================================================

let multicallInstance: MulticallService | null = null;

export function getMulticallService(provider: JsonRpcProvider): MulticallService {
    if (!multicallInstance) {
        multicallInstance = new MulticallService(provider);
    }
    return multicallInstance;
}

export default MulticallService;
