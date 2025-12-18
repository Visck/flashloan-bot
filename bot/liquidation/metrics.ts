/**
 * ============================================================================
 * METRICS SERVICE - Métricas de Performance do Bot
 * ============================================================================
 *
 * Sistema de métricas que:
 * - Rastreia todas as operações do bot
 * - Calcula taxas de sucesso e lucro
 * - Monitora performance de RPC
 * - Envia relatórios periódicos via Telegram
 */

import { logger } from '../logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface BotMetrics {
    // Timing
    startTime: Date;
    lastActivityTime: Date;

    // RPC Metrics
    rpcCalls: number;
    rpcErrors: number;
    avgRpcLatencyMs: number;

    // Discovery Metrics
    usersMonitored: number;
    usersAtRisk: number;
    usersLiquidatable: number;

    // Opportunity Metrics
    opportunitiesFound: number;
    opportunitiesExecuted: number;
    opportunitiesSuccessful: number;
    opportunitiesFailed: number;
    opportunitiesLost: number;
    opportunitiesSkipped: number;

    // Financial Metrics
    totalProfitUsd: number;
    totalGasCostUsd: number;
    netProfitUsd: number;
    avgProfitPerLiquidation: number;

    // Performance Metrics
    avgExecutionTimeMs: number;
    avgBlockProcessingMs: number;
}

export interface LiquidationRecord {
    timestamp: Date;
    userAddress: string;
    collateralAsset: string;
    debtAsset: string;
    debtRepaid: number;
    collateralReceived: number;
    profitUsd: number;
    gasCostUsd: number;
    txHash: string;
    success: boolean;
    error?: string;
}

// ============================================================================
// METRICS SERVICE CLASS
// ============================================================================

export class MetricsService {
    private metrics: BotMetrics;
    private latencies: number[] = [];
    private executionTimes: number[] = [];
    private blockTimes: number[] = [];
    private liquidationHistory: LiquidationRecord[] = [];
    private telegramCallback?: (message: string) => Promise<void>;
    private reportInterval: NodeJS.Timeout | null = null;

    constructor() {
        this.metrics = this.createInitialMetrics();
    }

    private createInitialMetrics(): BotMetrics {
        return {
            startTime: new Date(),
            lastActivityTime: new Date(),
            rpcCalls: 0,
            rpcErrors: 0,
            avgRpcLatencyMs: 0,
            usersMonitored: 0,
            usersAtRisk: 0,
            usersLiquidatable: 0,
            opportunitiesFound: 0,
            opportunitiesExecuted: 0,
            opportunitiesSuccessful: 0,
            opportunitiesFailed: 0,
            opportunitiesLost: 0,
            opportunitiesSkipped: 0,
            totalProfitUsd: 0,
            totalGasCostUsd: 0,
            netProfitUsd: 0,
            avgProfitPerLiquidation: 0,
            avgExecutionTimeMs: 0,
            avgBlockProcessingMs: 0
        };
    }

    // ========================================================================
    // RPC METRICS
    // ========================================================================

    /**
     * Registra chamada RPC
     */
    recordRpcCall(latencyMs: number, success: boolean): void {
        this.metrics.rpcCalls++;
        this.metrics.lastActivityTime = new Date();

        if (!success) {
            this.metrics.rpcErrors++;
        }

        this.latencies.push(latencyMs);
        if (this.latencies.length > 1000) {
            this.latencies.shift();
        }

        this.metrics.avgRpcLatencyMs = this.calculateAverage(this.latencies);
    }

    // ========================================================================
    // USER METRICS
    // ========================================================================

    /**
     * Atualiza contagem de usuários
     */
    updateUserCounts(monitored: number, atRisk: number, liquidatable: number): void {
        this.metrics.usersMonitored = monitored;
        this.metrics.usersAtRisk = atRisk;
        this.metrics.usersLiquidatable = liquidatable;
    }

    // ========================================================================
    // OPPORTUNITY METRICS
    // ========================================================================

    /**
     * Registra oportunidade encontrada
     */
    recordOpportunityFound(): void {
        this.metrics.opportunitiesFound++;
    }

    /**
     * Registra oportunidade pulada (não viável)
     */
    recordOpportunitySkipped(): void {
        this.metrics.opportunitiesSkipped++;
    }

    /**
     * Registra tentativa de liquidação
     */
    recordLiquidationAttempt(
        success: boolean,
        lostToCompetitor: boolean,
        profitUsd: number,
        gasCostUsd: number,
        executionTimeMs: number,
        record?: Partial<LiquidationRecord>
    ): void {
        this.metrics.opportunitiesExecuted++;
        this.metrics.lastActivityTime = new Date();

        if (success) {
            this.metrics.opportunitiesSuccessful++;
            this.metrics.totalProfitUsd += profitUsd;
        } else if (lostToCompetitor) {
            this.metrics.opportunitiesLost++;
        } else {
            this.metrics.opportunitiesFailed++;
        }

        this.metrics.totalGasCostUsd += gasCostUsd;
        this.metrics.netProfitUsd = this.metrics.totalProfitUsd - this.metrics.totalGasCostUsd;

        // Calcula média de lucro
        if (this.metrics.opportunitiesSuccessful > 0) {
            this.metrics.avgProfitPerLiquidation =
                this.metrics.totalProfitUsd / this.metrics.opportunitiesSuccessful;
        }

        // Registra tempo de execução
        this.executionTimes.push(executionTimeMs);
        if (this.executionTimes.length > 100) {
            this.executionTimes.shift();
        }
        this.metrics.avgExecutionTimeMs = this.calculateAverage(this.executionTimes);

        // Adiciona ao histórico
        if (record) {
            this.liquidationHistory.push({
                timestamp: new Date(),
                userAddress: record.userAddress || '',
                collateralAsset: record.collateralAsset || '',
                debtAsset: record.debtAsset || '',
                debtRepaid: record.debtRepaid || 0,
                collateralReceived: record.collateralReceived || 0,
                profitUsd,
                gasCostUsd,
                txHash: record.txHash || '',
                success,
                error: record.error
            });

            // Mantém últimas 1000 liquidações
            if (this.liquidationHistory.length > 1000) {
                this.liquidationHistory.shift();
            }
        }
    }

    /**
     * Registra tempo de processamento de bloco
     */
    recordBlockProcessing(timeMs: number): void {
        this.blockTimes.push(timeMs);
        if (this.blockTimes.length > 100) {
            this.blockTimes.shift();
        }
        this.metrics.avgBlockProcessingMs = this.calculateAverage(this.blockTimes);
    }

    // ========================================================================
    // CALCULATIONS
    // ========================================================================

    private calculateAverage(values: number[]): number {
        if (values.length === 0) return 0;
        return values.reduce((a, b) => a + b, 0) / values.length;
    }

    /**
     * Calcula taxa de sucesso
     */
    getSuccessRate(): number {
        if (this.metrics.opportunitiesExecuted === 0) return 0;
        return (this.metrics.opportunitiesSuccessful / this.metrics.opportunitiesExecuted) * 100;
    }

    /**
     * Calcula taxa de perda para competidores
     */
    getLossRate(): number {
        if (this.metrics.opportunitiesExecuted === 0) return 0;
        return (this.metrics.opportunitiesLost / this.metrics.opportunitiesExecuted) * 100;
    }

    /**
     * Calcula uptime formatado
     */
    getUptime(): string {
        const ms = Date.now() - this.metrics.startTime.getTime();
        const days = Math.floor(ms / 86400000);
        const hours = Math.floor((ms % 86400000) / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);

        if (days > 0) {
            return `${days}d ${hours}h ${minutes}m`;
        }
        return `${hours}h ${minutes}m`;
    }

    /**
     * Calcula ROI
     */
    getROI(): number {
        if (this.metrics.totalGasCostUsd === 0) return 0;
        return (this.metrics.netProfitUsd / this.metrics.totalGasCostUsd) * 100;
    }

    // ========================================================================
    // REPORTS
    // ========================================================================

    /**
     * Retorna resumo formatado para Telegram
     */
    getSummary(): string {
        const successRate = this.getSuccessRate();
        const lossRate = this.getLossRate();
        const roi = this.getROI();

        return `
📊 *LIQUIDATION BOT - STATUS*
═══════════════════════════════

⏱ *Uptime:* ${this.getUptime()}
📡 *RPC:* ${this.metrics.avgRpcLatencyMs.toFixed(0)}ms avg | ${this.metrics.rpcErrors} erros

👥 *Usuários Monitorados:*
   Total: ${this.metrics.usersMonitored}
   Em Risco: ${this.metrics.usersAtRisk}
   Liquidáveis: ${this.metrics.usersLiquidatable}

🎯 *Oportunidades:*
   Encontradas: ${this.metrics.opportunitiesFound}
   Executadas: ${this.metrics.opportunitiesExecuted}
   ✅ Sucesso: ${this.metrics.opportunitiesSuccessful}
   ❌ Falha: ${this.metrics.opportunitiesFailed}
   🏃 Perdidas: ${this.metrics.opportunitiesLost}
   ⏭ Puladas: ${this.metrics.opportunitiesSkipped}

📈 *Performance:*
   Taxa Sucesso: ${successRate.toFixed(1)}%
   Taxa Perda: ${lossRate.toFixed(1)}%
   Tempo Exec: ${this.metrics.avgExecutionTimeMs.toFixed(0)}ms
   Proc. Bloco: ${this.metrics.avgBlockProcessingMs.toFixed(0)}ms

💰 *Financeiro:*
   Lucro Bruto: $${this.metrics.totalProfitUsd.toFixed(2)}
   Gas Gasto: $${this.metrics.totalGasCostUsd.toFixed(2)}
   Lucro Líquido: $${this.metrics.netProfitUsd.toFixed(2)}
   ROI: ${roi.toFixed(1)}%
   Média/Liq: $${this.metrics.avgProfitPerLiquidation.toFixed(2)}

═══════════════════════════════
        `.trim();
    }

    /**
     * Retorna resumo curto
     */
    getShortSummary(): string {
        return `🤖 Up: ${this.getUptime()} | ✅ ${this.metrics.opportunitiesSuccessful}/${this.metrics.opportunitiesExecuted} | 💰 $${this.metrics.netProfitUsd.toFixed(2)}`;
    }

    // ========================================================================
    // TELEGRAM INTEGRATION
    // ========================================================================

    /**
     * Configura callback do Telegram
     */
    setTelegramCallback(callback: (message: string) => Promise<void>): void {
        this.telegramCallback = callback;
    }

    /**
     * Envia relatório para Telegram
     */
    async sendToTelegram(message?: string): Promise<void> {
        if (!this.telegramCallback) return;

        try {
            await this.telegramCallback(message || this.getSummary());
        } catch (error) {
            logger.error('Failed to send Telegram message:', error);
        }
    }

    /**
     * Inicia relatórios periódicos
     */
    startPeriodicReports(intervalMs: number = 3600000): void {
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
        }

        this.reportInterval = setInterval(() => {
            this.sendToTelegram();
        }, intervalMs);

        logger.info(`Periodic reports started (every ${intervalMs}ms)`);
    }

    /**
     * Para relatórios periódicos
     */
    stopPeriodicReports(): void {
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
            this.reportInterval = null;
        }
    }

    // ========================================================================
    // DATA ACCESS
    // ========================================================================

    /**
     * Retorna todas as métricas
     */
    getMetrics(): BotMetrics {
        return { ...this.metrics };
    }

    /**
     * Retorna histórico de liquidações
     */
    getLiquidationHistory(limit?: number): LiquidationRecord[] {
        const history = [...this.liquidationHistory].reverse();
        return limit ? history.slice(0, limit) : history;
    }

    /**
     * Retorna liquidações de hoje
     */
    getTodayLiquidations(): LiquidationRecord[] {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        return this.liquidationHistory.filter(l => l.timestamp >= today);
    }

    /**
     * Reset das métricas
     */
    reset(): void {
        this.metrics = this.createInitialMetrics();
        this.latencies = [];
        this.executionTimes = [];
        this.blockTimes = [];
        // Mantém histórico de liquidações
        logger.info('Metrics reset');
    }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const metrics = new MetricsService();

// ============================================================================
// FACTORY
// ============================================================================

export function createMetricsService(): MetricsService {
    return new MetricsService();
}
