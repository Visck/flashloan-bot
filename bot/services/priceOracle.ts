import { ethers, Contract, Provider } from 'ethers';
import { logger } from './logger';

const CHAINLINK_FEEDS: Record<string, Record<string, string>> = {
    arbitrum: {
        'ETH': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
        'WETH': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
        'USDC': '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
        'USDT': '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7',
        'WBTC': '0xd0C7101eACbB49F3deCcCc166d238410D6D46d57',
        'ARB': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
        'DAI': '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB',
        'LINK': '0x86E53CF1B870786351Da77A57575e79CB55812CB',
        'UNI': '0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720',
    }
};

const CHAINLINK_ABI = [
    'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function decimals() external view returns (uint8)'
];

export class PriceOracle {
    private provider: Provider;
    private chain: string;
    private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
    private cacheDuration = 30000; // 30 seconds

    constructor(provider: Provider, chain: string = 'arbitrum') {
        this.provider = provider;
        this.chain = chain;
    }

    async getPrice(symbol: string): Promise<number> {
        const cached = this.priceCache.get(symbol);
        if (cached && Date.now() - cached.timestamp < this.cacheDuration) {
            return cached.price;
        }

        const feedAddress = CHAINLINK_FEEDS[this.chain]?.[symbol.toUpperCase()];
        if (!feedAddress) {
            logger.warn(`No Chainlink feed for ${symbol} on ${this.chain}`);
            return 0;
        }

        try {
            const feed = new Contract(feedAddress, CHAINLINK_ABI, this.provider);
            const [, answer] = await feed.latestRoundData();
            const decimals = await feed.decimals();

            const price = Number(answer) / Math.pow(10, Number(decimals));

            this.priceCache.set(symbol, { price, timestamp: Date.now() });

            return price;
        } catch (error) {
            logger.error(`Failed to get price for ${symbol}: ${error}`);
            return 0;
        }
    }

    async getPrices(symbols: string[]): Promise<Map<string, number>> {
        const prices = new Map<string, number>();

        await Promise.all(
            symbols.map(async (symbol) => {
                const price = await this.getPrice(symbol);
                prices.set(symbol, price);
            })
        );

        return prices;
    }

    async getEthPrice(): Promise<number> {
        return this.getPrice('ETH');
    }

    async convertToUsd(amount: bigint, decimals: number, symbol: string): Promise<number> {
        const price = await this.getPrice(symbol);
        const amountNum = Number(amount) / Math.pow(10, decimals);
        return amountNum * price;
    }
}

export const TOKEN_DECIMALS: Record<string, number> = {
    'WETH': 18,
    'ETH': 18,
    'USDC': 6,
    'USDT': 6,
    'WBTC': 8,
    'DAI': 18,
    'ARB': 18,
    'LINK': 18,
    'UNI': 18,
};

export const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
    arbitrum: {
        'WETH': '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        'USDC': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        'USDT': '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        'WBTC': '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
        'DAI': '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
        'ARB': '0x912CE59144191C1204E64559FE8253a0e49E6548',
        'LINK': '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    }
};
