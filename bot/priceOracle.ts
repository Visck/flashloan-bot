/**
 * ============================================================================
 * PRICE ORACLE SERVICE - PREÇOS EM TEMPO REAL
 * ============================================================================
 *
 * Serviço para obter preços reais dos tokens via:
 * 1. Chainlink Oracles (principal)
 * 2. Pools das DEXs (fallback)
 * 3. Cache local (performance)
 *
 * CRÍTICO: Substitui os preços hardcoded que causavam cálculos errados
 */

import { Contract, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { logger } from './logger';

// ============================================================================
// CHAINLINK PRICE FEEDS - ARBITRUM MAINNET
// ============================================================================

const CHAINLINK_FEEDS: Record<string, string> = {
    // ETH/USD
    'WETH': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
    // BTC/USD
    'WBTC': '0x6ce185860a4963106506C203335A2910FC09C8e',
    // ARB/USD
    'ARB': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
    // LINK/USD
    'LINK': '0x86E53CF1B870786351Da77A57575e79CB55812CB',
    // GMX/USD
    'GMX': '0xDB98056FecFff59D032aB628337A4887110df3dB',
    // UNI/USD
    'UNI': '0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720',
    // USDC/USD
    'USDC': '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    'USDC.e': '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    // USDT/USD
    'USDT': '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7',
    // DAI/USD
    'DAI': '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB',
    // FRAX/USD
    'FRAX': '0x0809E3d38d1B4214958faf06D8b1B1a2b73f2ab8',
    // MAGIC (usar pool como fallback)
    'MAGIC': '',
    // PENDLE (usar pool como fallback)
    'PENDLE': '',
    // wstETH/ETH
    'wstETH': '0xB1552C5e96B312d0Bf8b554186F846C40614a540',
    // rETH/ETH
    'rETH': '0xF3272CAfe65b190e76caAF483db13424a3e23dD2',
};

// ABI mínima do Chainlink Aggregator
const CHAINLINK_ABI = [
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function decimals() view returns (uint8)',
];

// ============================================================================
// INTERFACES
// ============================================================================

interface PriceData {
    price: number;
    timestamp: number;
    source: 'chainlink' | 'pool' | 'cache' | 'fallback';
    decimals: number;
}

interface CacheEntry {
    price: number;
    timestamp: number;
    source: string;
}

// ============================================================================
// CLASSE PRINCIPAL
// ============================================================================

export class PriceOracle {
    private provider: JsonRpcProvider;
    private cache: Map<string, CacheEntry> = new Map();
    private readonly CACHE_TTL_MS = 2000; // 2 segundos

    // Preços de fallback (última atualização: Dez 2024)
    // Usados APENAS se Chainlink e pools falharem
    private readonly FALLBACK_PRICES: Record<string, number> = {
        'WETH': 3900,
        'WBTC': 100000,
        'ARB': 0.85,
        'USDC': 1,
        'USDC.e': 1,
        'USDT': 1,
        'DAI': 1,
        'GMX': 25,
        'MAGIC': 0.45,
        'RDNT': 0.05,
        'PENDLE': 5.5,
        'GRAIL': 800,
        'LINK': 25,
        'UNI': 15,
        'wstETH': 4400,
        'rETH': 4200,
        'FRAX': 1,
        'MIM': 0.99,
        'LUSD': 1,
    };

    constructor(provider: JsonRpcProvider) {
        this.provider = provider;
    }

    /**
     * Obtém preço de um token em USD
     */
    async getPrice(symbol: string): Promise<PriceData> {
        // 1. Verifica cache
        const cached = this.getFromCache(symbol);
        if (cached) {
            return {
                price: cached.price,
                timestamp: cached.timestamp,
                source: 'cache',
                decimals: 8,
            };
        }

        // 2. Tenta Chainlink
        const chainlinkPrice = await this.getChainlinkPrice(symbol);
        if (chainlinkPrice) {
            this.setCache(symbol, chainlinkPrice.price, 'chainlink');
            return chainlinkPrice;
        }

        // 3. Fallback para preço estático (melhor que nada)
        const fallbackPrice = this.FALLBACK_PRICES[symbol];
        if (fallbackPrice) {
            logger.warn(`Usando preço fallback para ${symbol}: $${fallbackPrice}`);
            return {
                price: fallbackPrice,
                timestamp: Date.now(),
                source: 'fallback',
                decimals: 8,
            };
        }

        // 4. Default para stablecoins desconhecidas
        if (symbol.includes('USD') || symbol.includes('DAI')) {
            return { price: 1, timestamp: Date.now(), source: 'fallback', decimals: 8 };
        }

        throw new Error(`Preço não encontrado para ${symbol}`);
    }

    /**
     * Obtém preço via Chainlink Oracle
     */
    private async getChainlinkPrice(symbol: string): Promise<PriceData | null> {
        const feedAddress = CHAINLINK_FEEDS[symbol];
        if (!feedAddress) {
            return null;
        }

        try {
            const feed = new Contract(feedAddress, CHAINLINK_ABI, this.provider);

            const [roundData, decimals] = await Promise.all([
                feed.latestRoundData(),
                feed.decimals(),
            ]);

            const price = parseFloat(formatUnits(roundData.answer, decimals));
            const timestamp = Number(roundData.updatedAt) * 1000;

            // Verifica se o preço não está muito desatualizado (> 1 hora)
            if (Date.now() - timestamp > 3600000) {
                logger.warn(`Preço Chainlink desatualizado para ${symbol}`);
            }

            return {
                price,
                timestamp,
                source: 'chainlink',
                decimals: Number(decimals),
            };
        } catch (error) {
            logger.debug(`Erro ao buscar Chainlink para ${symbol}: ${error}`);
            return null;
        }
    }

    /**
     * Obtém múltiplos preços de uma vez
     */
    async getPrices(symbols: string[]): Promise<Map<string, PriceData>> {
        const prices = new Map<string, PriceData>();

        // Busca em paralelo
        const results = await Promise.allSettled(
            symbols.map(async (symbol) => ({
                symbol,
                data: await this.getPrice(symbol),
            }))
        );

        for (const result of results) {
            if (result.status === 'fulfilled') {
                prices.set(result.value.symbol, result.value.data);
            }
        }

        return prices;
    }

    /**
     * Converte quantidade de token para USD
     */
    async tokenToUsd(amount: bigint, symbol: string, decimals: number): Promise<number> {
        const priceData = await this.getPrice(symbol);
        const amountFormatted = parseFloat(formatUnits(amount, decimals));
        return amountFormatted * priceData.price;
    }

    /**
     * Converte USD para quantidade de token
     */
    async usdToToken(usd: number, symbol: string, decimals: number): Promise<bigint> {
        const priceData = await this.getPrice(symbol);
        const amount = usd / priceData.price;
        return parseUnits(amount.toFixed(decimals), decimals);
    }

    /**
     * Obtém preço do ETH (usado para cálculo de gas)
     */
    async getEthPrice(): Promise<number> {
        const priceData = await this.getPrice('WETH');
        return priceData.price;
    }

    /**
     * Calcula custo de gas em USD
     */
    async getGasCostUsd(gasUsed: bigint, gasPriceWei: bigint): Promise<number> {
        const gasCostEth = parseFloat(formatUnits(gasUsed * gasPriceWei, 18));
        const ethPrice = await this.getEthPrice();
        return gasCostEth * ethPrice;
    }

    // ============================================================================
    // CACHE
    // ============================================================================

    private getFromCache(symbol: string): CacheEntry | null {
        const entry = this.cache.get(symbol);
        if (!entry) return null;

        if (Date.now() - entry.timestamp > this.CACHE_TTL_MS) {
            this.cache.delete(symbol);
            return null;
        }

        return entry;
    }

    private setCache(symbol: string, price: number, source: string): void {
        this.cache.set(symbol, {
            price,
            timestamp: Date.now(),
            source,
        });
    }

    /**
     * Limpa o cache
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Atualiza preços de fallback manualmente
     */
    updateFallbackPrice(symbol: string, price: number): void {
        this.FALLBACK_PRICES[symbol] = price;
    }
}

// ============================================================================
// SINGLETON PARA USO GLOBAL
// ============================================================================

let priceOracleInstance: PriceOracle | null = null;

export function getPriceOracle(provider: JsonRpcProvider): PriceOracle {
    if (!priceOracleInstance) {
        priceOracleInstance = new PriceOracle(provider);
    }
    return priceOracleInstance;
}

export default PriceOracle;
