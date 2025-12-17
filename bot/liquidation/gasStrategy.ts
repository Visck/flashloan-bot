/**
 * ============================================================================
 * GAS STRATEGY - Ajuste Dinâmico de Gas para Liquidações
 * ============================================================================
 *
 * Estratégia inteligente de gas que:
 * - Ajusta gas baseado no lucro esperado
 * - Considera urgência da liquidação
 * - Monitora condições de rede
 * - Garante competitividade sem overpaying
 */

import { JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { logger } from '../logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface GasEstimate {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    gasLimit: bigint;
    estimatedCostWei: bigint;
    estimatedCostUsd: number;
    isViable: boolean;
    strategy: string;
}

export interface GasConfig {
    // Multipliers baseados em lucro
    highProfitMultiplier: number;      // Lucro > $100
    mediumProfitMultiplier: number;    // Lucro $50-100
    lowProfitMultiplier: number;       // Lucro < $50

    // Limites de custo
    maxGasPercentOfProfit: number;     // Máximo % do lucro para gas

    // Limites absolutos (em gwei)
    absoluteMaxGwei: number;           // Máximo absoluto
    absoluteMinGwei: number;           // Mínimo para garantir inclusão
    minPriorityFeeGwei: number;        // Priority fee mínimo

    // Gas limits por operação
    defaultGasLimit: number;           // Liquidação simples
    complexGasLimit: number;           // Liquidação com swap
}

export interface NetworkConditions {
    baseFee: bigint;
    priorityFee: bigint;
    congestionLevel: 'low' | 'medium' | 'high';
    recentBlockTime: number;
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: GasConfig = {
    highProfitMultiplier: 1.5,
    mediumProfitMultiplier: 1.3,
    lowProfitMultiplier: 1.15,
    maxGasPercentOfProfit: 0.30,
    absoluteMaxGwei: 5.0,
    absoluteMinGwei: 0.01,
    minPriorityFeeGwei: 0.001,
    defaultGasLimit: 500000,
    complexGasLimit: 800000
};

// ============================================================================
// GAS STRATEGY CLASS
// ============================================================================

export class GasStrategy {
    private config: GasConfig;
    private ethPriceUsd: number = 3500;
    private lastNetworkConditions: NetworkConditions | null = null;
    private historicalGas: bigint[] = [];

    constructor(
        private provider: JsonRpcProvider,
        config: Partial<GasConfig> = {}
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ========================================================================
    // GAS CALCULATION
    // ========================================================================

    /**
     * Calcula gas ótimo baseado no lucro e urgência
     */
    async calculateOptimalGas(
        profitUsd: number,
        urgency: 'low' | 'medium' | 'high' | 'critical' = 'medium',
        isComplex: boolean = false
    ): Promise<GasEstimate> {
        // Obtém dados de fee da rede
        const feeData = await this.provider.getFeeData();
        const networkConditions = await this.getNetworkConditions();

        // Determina multiplicador base pelo lucro
        let multiplier = this.config.lowProfitMultiplier;
        if (profitUsd > 100) {
            multiplier = this.config.highProfitMultiplier;
        } else if (profitUsd > 50) {
            multiplier = this.config.mediumProfitMultiplier;
        }

        // Ajusta pela urgência
        switch (urgency) {
            case 'critical':
                multiplier *= 2.0;
                break;
            case 'high':
                multiplier *= 1.5;
                break;
            case 'low':
                multiplier *= 0.9;
                break;
        }

        // Ajusta pela congestão da rede
        switch (networkConditions.congestionLevel) {
            case 'high':
                multiplier *= 1.3;
                break;
            case 'medium':
                multiplier *= 1.1;
                break;
        }

        // Calcula fees
        const baseFee = feeData.maxFeePerGas || parseUnits('0.1', 'gwei');
        const priorityFee = feeData.maxPriorityFeePerGas || parseUnits('0.001', 'gwei');

        let maxFeePerGas = (baseFee * BigInt(Math.floor(multiplier * 100))) / 100n;
        let maxPriorityFeePerGas = (priorityFee * BigInt(Math.floor(multiplier * 100))) / 100n;

        // Aplica limites
        const maxGwei = parseUnits(this.config.absoluteMaxGwei.toString(), 'gwei');
        const minGwei = parseUnits(this.config.absoluteMinGwei.toString(), 'gwei');
        const minPriority = parseUnits(this.config.minPriorityFeeGwei.toString(), 'gwei');

        if (maxFeePerGas > maxGwei) maxFeePerGas = maxGwei;
        if (maxFeePerGas < minGwei) maxFeePerGas = minGwei;
        if (maxPriorityFeePerGas < minPriority) maxPriorityFeePerGas = minPriority;

        // Gas limit
        const gasLimit = BigInt(isComplex ? this.config.complexGasLimit : this.config.defaultGasLimit);

        // Calcula custo estimado
        const estimatedCostWei = maxFeePerGas * gasLimit;
        const estimatedCostEth = parseFloat(formatUnits(estimatedCostWei, 18));
        const estimatedCostUsd = estimatedCostEth * this.ethPriceUsd;

        // Verifica viabilidade
        const maxAcceptableGas = profitUsd * this.config.maxGasPercentOfProfit;
        const isViable = estimatedCostUsd <= maxAcceptableGas;

        // Determina estratégia usada
        const strategy = this.getStrategyDescription(urgency, multiplier, networkConditions.congestionLevel);

        // Armazena para histórico
        this.historicalGas.push(maxFeePerGas);
        if (this.historicalGas.length > 100) this.historicalGas.shift();

        return {
            maxFeePerGas,
            maxPriorityFeePerGas,
            gasLimit,
            estimatedCostWei,
            estimatedCostUsd,
            isViable,
            strategy
        };
    }

    /**
     * Calcula gas competitivo (para vencer outros bots)
     */
    async calculateCompetitiveGas(
        profitUsd: number,
        competitorGasPrice?: bigint
    ): Promise<GasEstimate> {
        const baseEstimate = await this.calculateOptimalGas(profitUsd, 'high');

        if (competitorGasPrice) {
            // Tenta superar o competidor em 10%
            const competitiveGas = (competitorGasPrice * 110n) / 100n;
            const maxGwei = parseUnits(this.config.absoluteMaxGwei.toString(), 'gwei');

            if (competitiveGas <= maxGwei) {
                const newCostWei = competitiveGas * baseEstimate.gasLimit;
                const newCostEth = parseFloat(formatUnits(newCostWei, 18));
                const newCostUsd = newCostEth * this.ethPriceUsd;
                const maxAcceptable = profitUsd * this.config.maxGasPercentOfProfit;

                if (newCostUsd <= maxAcceptable) {
                    return {
                        ...baseEstimate,
                        maxFeePerGas: competitiveGas,
                        estimatedCostWei: newCostWei,
                        estimatedCostUsd: newCostUsd,
                        isViable: true,
                        strategy: 'competitive_override'
                    };
                }
            }
        }

        return baseEstimate;
    }

    // ========================================================================
    // NETWORK MONITORING
    // ========================================================================

    /**
     * Obtém condições atuais da rede
     */
    async getNetworkConditions(): Promise<NetworkConditions> {
        try {
            const [feeData, block] = await Promise.all([
                this.provider.getFeeData(),
                this.provider.getBlock('latest')
            ]);

            const baseFee = feeData.maxFeePerGas || 0n;
            const priorityFee = feeData.maxPriorityFeePerGas || 0n;

            // Determina nível de congestão (Arbitrum tem gas muito baixo)
            const baseFeeGwei = parseFloat(formatUnits(baseFee, 'gwei'));
            let congestionLevel: 'low' | 'medium' | 'high' = 'low';

            if (baseFeeGwei > 1.0) {
                congestionLevel = 'high';
            } else if (baseFeeGwei > 0.5) {
                congestionLevel = 'medium';
            }

            const conditions: NetworkConditions = {
                baseFee,
                priorityFee,
                congestionLevel,
                recentBlockTime: block?.timestamp || Math.floor(Date.now() / 1000)
            };

            this.lastNetworkConditions = conditions;
            return conditions;
        } catch (error) {
            // Retorna último conhecido ou padrão
            return this.lastNetworkConditions || {
                baseFee: parseUnits('0.1', 'gwei'),
                priorityFee: parseUnits('0.001', 'gwei'),
                congestionLevel: 'low',
                recentBlockTime: Math.floor(Date.now() / 1000)
            };
        }
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    /**
     * Atualiza preço do ETH
     */
    updateEthPrice(priceUsd: number): void {
        this.ethPriceUsd = priceUsd;
        logger.debug(`ETH price updated: $${priceUsd}`);
    }

    /**
     * Verifica se execução é viável
     */
    isExecutionViable(profitUsd: number, gasCostUsd: number): boolean {
        const maxAcceptable = profitUsd * this.config.maxGasPercentOfProfit;
        return gasCostUsd <= maxAcceptable && profitUsd > gasCostUsd;
    }

    /**
     * Calcula lucro líquido após gas
     */
    calculateNetProfit(profitUsd: number, gasCostUsd: number): number {
        return profitUsd - gasCostUsd;
    }

    /**
     * Estima gas para transação específica
     */
    async estimateGas(
        to: string,
        data: string,
        value: bigint = 0n
    ): Promise<bigint> {
        try {
            const estimate = await this.provider.estimateGas({
                to,
                data,
                value
            });
            // Adiciona 20% de margem
            return (estimate * 120n) / 100n;
        } catch {
            return BigInt(this.config.defaultGasLimit);
        }
    }

    private getStrategyDescription(
        urgency: string,
        multiplier: number,
        congestion: string
    ): string {
        return `${urgency}_${multiplier.toFixed(2)}x_${congestion}`;
    }

    /**
     * Retorna estatísticas de gas
     */
    getStats(): {
        ethPrice: number;
        avgGasGwei: number;
        lastConditions: NetworkConditions | null;
    } {
        const avgGas = this.historicalGas.length > 0
            ? this.historicalGas.reduce((a, b) => a + b, 0n) / BigInt(this.historicalGas.length)
            : 0n;

        return {
            ethPrice: this.ethPriceUsd,
            avgGasGwei: parseFloat(formatUnits(avgGas, 'gwei')),
            lastConditions: this.lastNetworkConditions
        };
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createGasStrategy(provider: JsonRpcProvider): GasStrategy {
    const config: Partial<GasConfig> = {
        highProfitMultiplier: parseFloat(process.env.GAS_HIGH_PROFIT_MULTIPLIER || '1.5'),
        mediumProfitMultiplier: parseFloat(process.env.GAS_MEDIUM_PROFIT_MULTIPLIER || '1.3'),
        lowProfitMultiplier: parseFloat(process.env.GAS_LOW_PROFIT_MULTIPLIER || '1.15'),
        maxGasPercentOfProfit: parseFloat(process.env.GAS_MAX_PERCENT_OF_PROFIT || '0.3')
    };

    return new GasStrategy(provider, config);
}
