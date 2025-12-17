/**
 * ============================================================================
 * USER PRIORITIZER - Classificação Inteligente de Usuários
 * ============================================================================
 *
 * Sistema de priorização que:
 * - Classifica usuários por risco de liquidação
 * - Estima lucro potencial
 * - Define intervalos de checagem dinâmicos
 * - Otimiza uso de recursos do bot
 */

import { logger } from '../logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface UserPosition {
    address: string;
    healthFactor: number;
    totalDebtUsd: number;
    totalCollateralUsd: number;
    collateralAssets: CollateralAsset[];
    debtAssets: DebtAsset[];
    lastUpdated?: Date;
}

export interface CollateralAsset {
    symbol: string;
    address: string;
    balanceUsd: number;
    liquidationThreshold: number;
    liquidationBonus: number;
}

export interface DebtAsset {
    symbol: string;
    address: string;
    balanceUsd: number;
}

export interface PrioritizedUser extends UserPosition {
    priorityScore: number;
    estimatedProfit: number;
    riskLevel: RiskLevel;
    checkIntervalMs: number;
    liquidatable: boolean;
    bestCollateral?: CollateralAsset;
    bestDebt?: DebtAsset;
}

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export interface PrioritizationConfig {
    // Weights para score
    healthFactorWeight: number;
    debtSizeWeight: number;
    collateralQualityWeight: number;

    // Liquidation parameters
    liquidationBonusPercent: number;
    maxLiquidationPercent: number;

    // Risk thresholds
    criticalHF: number;
    highRiskHF: number;
    mediumRiskHF: number;

    // Filters
    minDebtUsd: number;
    minProfitUsd: number;
    maxUsersToMonitor: number;
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: PrioritizationConfig = {
    healthFactorWeight: 0.4,
    debtSizeWeight: 0.4,
    collateralQualityWeight: 0.2,
    liquidationBonusPercent: 5,
    maxLiquidationPercent: 50,
    criticalHF: 1.0,
    highRiskHF: 1.05,
    mediumRiskHF: 1.15,
    minDebtUsd: 100,
    minProfitUsd: 5,
    maxUsersToMonitor: 1000
};

// Check intervals por risco (ms)
const RISK_CHECK_INTERVALS: Record<RiskLevel, number> = {
    critical: 500,      // 0.5s - Liquidação iminente
    high: 2000,         // 2s - Alto risco
    medium: 10000,      // 10s - Risco moderado
    low: 60000          // 60s - Baixo risco
};

// ============================================================================
// USER PRIORITIZER CLASS
// ============================================================================

export class UserPrioritizer {
    private config: PrioritizationConfig;
    private prioritizedUsers: Map<string, PrioritizedUser> = new Map();

    constructor(config: Partial<PrioritizationConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ========================================================================
    // PRIORITIZATION
    // ========================================================================

    /**
     * Processa e prioriza lista de usuários
     */
    prioritizeUsers(users: UserPosition[]): PrioritizedUser[] {
        const prioritized = users
            .filter(u => this.isValidUser(u))
            .map(user => this.calculatePriority(user))
            .filter(u => u.estimatedProfit >= this.config.minProfitUsd)
            .sort((a, b) => b.priorityScore - a.priorityScore)
            .slice(0, this.config.maxUsersToMonitor);

        // Atualiza cache
        this.prioritizedUsers.clear();
        for (const user of prioritized) {
            this.prioritizedUsers.set(user.address.toLowerCase(), user);
        }

        logger.debug(`Prioritized ${prioritized.length} users from ${users.length} total`);
        return prioritized;
    }

    /**
     * Calcula prioridade de um usuário
     */
    private calculatePriority(user: UserPosition): PrioritizedUser {
        const riskLevel = this.getRiskLevel(user.healthFactor);
        const priorityScore = this.calculatePriorityScore(user);
        const estimatedProfit = this.estimateProfit(user);
        const checkIntervalMs = RISK_CHECK_INTERVALS[riskLevel];
        const liquidatable = user.healthFactor < 1.0;

        // Encontra melhores assets para liquidação
        const bestCollateral = this.findBestCollateral(user.collateralAssets);
        const bestDebt = this.findBestDebt(user.debtAssets);

        return {
            ...user,
            priorityScore,
            estimatedProfit,
            riskLevel,
            checkIntervalMs,
            liquidatable,
            bestCollateral,
            bestDebt
        };
    }

    /**
     * Calcula score de prioridade (0-100)
     */
    private calculatePriorityScore(user: UserPosition): number {
        let score = 0;

        // Health Factor Score (quanto mais baixo, maior score)
        // HF 1.0 = 100 pontos, HF 1.2 = 0 pontos
        const hfScore = Math.max(0, Math.min(100, (1.2 - user.healthFactor) * 500));
        score += hfScore * this.config.healthFactorWeight;

        // Debt Size Score (maior dívida = maior score)
        // $10k = 100 pontos
        const debtScore = Math.min(100, (user.totalDebtUsd / 10000) * 100);
        score += debtScore * this.config.debtSizeWeight;

        // Collateral Quality Score
        const collateralScore = this.calculateCollateralQuality(user.collateralAssets);
        score += collateralScore * this.config.collateralQualityWeight;

        return Math.round(score);
    }

    /**
     * Estima lucro potencial de liquidação
     */
    private estimateProfit(user: UserPosition): number {
        if (user.healthFactor >= 1.0) {
            return 0; // Não liquidável ainda
        }

        // Máximo liquidável = 50% da dívida
        const maxLiquidationUsd = user.totalDebtUsd * (this.config.maxLiquidationPercent / 100);

        // Bonus médio de liquidação (~5%)
        const bonusPercent = this.config.liquidationBonusPercent;

        // Lucro bruto estimado
        const grossProfit = maxLiquidationUsd * (bonusPercent / 100);

        // Desconta estimativa de gas (~$0.50 no Arbitrum)
        const estimatedGas = 0.50;

        return Math.max(0, grossProfit - estimatedGas);
    }

    /**
     * Calcula qualidade do colateral
     */
    private calculateCollateralQuality(assets: CollateralAsset[]): number {
        if (assets.length === 0) return 0;

        // Média ponderada do liquidation bonus
        let totalValue = 0;
        let weightedBonus = 0;

        for (const asset of assets) {
            totalValue += asset.balanceUsd;
            weightedBonus += asset.balanceUsd * asset.liquidationBonus;
        }

        if (totalValue === 0) return 0;

        const avgBonus = weightedBonus / totalValue;

        // Bonus médio de 5% = score 50
        return Math.min(100, avgBonus * 10);
    }

    // ========================================================================
    // RISK CLASSIFICATION
    // ========================================================================

    /**
     * Determina nível de risco baseado no health factor
     */
    private getRiskLevel(hf: number): RiskLevel {
        if (hf < this.config.criticalHF) return 'critical';
        if (hf < this.config.highRiskHF) return 'high';
        if (hf < this.config.mediumRiskHF) return 'medium';
        return 'low';
    }

    // ========================================================================
    // ASSET SELECTION
    // ========================================================================

    /**
     * Encontra melhor colateral para receber na liquidação
     */
    private findBestCollateral(assets: CollateralAsset[]): CollateralAsset | undefined {
        if (assets.length === 0) return undefined;

        // Prioriza por: maior bonus * maior valor
        return assets.sort((a, b) => {
            const scoreA = a.liquidationBonus * a.balanceUsd;
            const scoreB = b.liquidationBonus * b.balanceUsd;
            return scoreB - scoreA;
        })[0];
    }

    /**
     * Encontra melhor dívida para pagar na liquidação
     */
    private findBestDebt(assets: DebtAsset[]): DebtAsset | undefined {
        if (assets.length === 0) return undefined;

        // Prioriza por maior valor (pagar mais = receber mais colateral)
        return assets.sort((a, b) => b.balanceUsd - a.balanceUsd)[0];
    }

    // ========================================================================
    // FILTERING
    // ========================================================================

    /**
     * Valida se usuário deve ser considerado
     */
    private isValidUser(user: UserPosition): boolean {
        // Deve ter dívida mínima
        if (user.totalDebtUsd < this.config.minDebtUsd) return false;

        // Deve ter colateral
        if (user.totalCollateralUsd <= 0) return false;

        // Health factor deve ser razoável (não infinito)
        if (!isFinite(user.healthFactor) || user.healthFactor > 10) return false;

        return true;
    }

    /**
     * Filtra apenas usuários liquidáveis
     */
    filterLiquidatable(users: PrioritizedUser[]): PrioritizedUser[] {
        return users.filter(u => u.liquidatable);
    }

    /**
     * Filtra por nível de risco
     */
    filterByRisk(users: PrioritizedUser[], ...levels: RiskLevel[]): PrioritizedUser[] {
        return users.filter(u => levels.includes(u.riskLevel));
    }

    /**
     * Filtra por lucro mínimo
     */
    filterByProfit(users: PrioritizedUser[], minProfit: number): PrioritizedUser[] {
        return users.filter(u => u.estimatedProfit >= minProfit);
    }

    // ========================================================================
    // CACHE ACCESS
    // ========================================================================

    /**
     * Obtém usuário do cache
     */
    getUser(address: string): PrioritizedUser | undefined {
        return this.prioritizedUsers.get(address.toLowerCase());
    }

    /**
     * Obtém todos os usuários prioritizados
     */
    getAllUsers(): PrioritizedUser[] {
        return Array.from(this.prioritizedUsers.values());
    }

    /**
     * Obtém usuários por risco
     */
    getUsersByRisk(level: RiskLevel): PrioritizedUser[] {
        return Array.from(this.prioritizedUsers.values())
            .filter(u => u.riskLevel === level);
    }

    // ========================================================================
    // STATISTICS
    // ========================================================================

    /**
     * Retorna estatísticas de distribuição
     */
    getStats(users?: PrioritizedUser[]): {
        total: number;
        critical: number;
        high: number;
        medium: number;
        low: number;
        liquidatable: number;
        totalPotentialProfit: number;
        avgHealthFactor: number;
    } {
        const list = users || Array.from(this.prioritizedUsers.values());

        const stats = {
            total: list.length,
            critical: list.filter(u => u.riskLevel === 'critical').length,
            high: list.filter(u => u.riskLevel === 'high').length,
            medium: list.filter(u => u.riskLevel === 'medium').length,
            low: list.filter(u => u.riskLevel === 'low').length,
            liquidatable: list.filter(u => u.liquidatable).length,
            totalPotentialProfit: list.reduce((sum, u) => sum + u.estimatedProfit, 0),
            avgHealthFactor: list.length > 0
                ? list.reduce((sum, u) => sum + u.healthFactor, 0) / list.length
                : 0
        };

        return stats;
    }

    /**
     * Retorna resumo formatado
     */
    getSummary(): string {
        const stats = this.getStats();

        return `
📊 *DISTRIBUIÇÃO DE RISCO*
════════════════════════════
🔴 Crítico (HF < ${this.config.criticalHF}): ${stats.critical}
🟠 Alto (HF < ${this.config.highRiskHF}): ${stats.high}
🟡 Médio (HF < ${this.config.mediumRiskHF}): ${stats.medium}
🟢 Baixo: ${stats.low}
════════════════════════════
💀 Liquidáveis: ${stats.liquidatable}
💰 Lucro Potencial: $${stats.totalPotentialProfit.toFixed(2)}
📈 HF Médio: ${stats.avgHealthFactor.toFixed(3)}
        `.trim();
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createUserPrioritizer(): UserPrioritizer {
    const config: Partial<PrioritizationConfig> = {
        criticalHF: parseFloat(process.env.PRIORITY_CRITICAL_HF || '1.0'),
        highRiskHF: parseFloat(process.env.PRIORITY_HIGH_RISK_HF || '1.05'),
        mediumRiskHF: parseFloat(process.env.PRIORITY_MEDIUM_RISK_HF || '1.15')
    };

    return new UserPrioritizer(config);
}
