/**
 * ============================================================================
 * OPTIMIZED CONFIG - Configurações Otimizadas para Economia de CUs
 * ============================================================================
 *
 * Este arquivo contém configurações otimizadas para minimizar o uso de CUs
 * enquanto mantém o bot competitivo.
 *
 * PLANO FREE ALCHEMY:
 * - 30M CUs/mês = ~1M CUs/dia = ~41.6K CUs/hora = ~11.5 CUs/segundo
 * - 25 requests/segundo máximo
 *
 * ESTRATÉGIAS DE ECONOMIA:
 * 1. Multicall: 100 chamadas = 1 CU
 * 2. Cache: Evita chamadas repetidas
 * 3. Rate Limit: Previne throttling
 * 4. Subgraph First: Usa dados gratuitos quando possível
 * 5. Polling Adaptativo: Verifica menos frequentemente usuários de baixo risco
 */

// ============================================================================
// CU COSTS (APROXIMADOS)
// ============================================================================

export const CU_COSTS = {
    // Leitura básica
    eth_blockNumber: 10,
    eth_getBlockByNumber: 16,
    eth_call: 26,
    eth_getBalance: 15,
    eth_getLogs: 75,
    eth_getTransactionReceipt: 15,

    // Escrita
    eth_sendRawTransaction: 250,
    eth_estimateGas: 87,

    // Multicall (1 chamada = custo fixo, independente de quantas sub-chamadas)
    multicall: 26,

    // WebSocket
    eth_subscribe: 10,
    newHeads: 1, // por bloco recebido
};

// ============================================================================
// CONFIGURAÇÕES POR PLANO
// ============================================================================

export interface OptimizationConfig {
    // Rate Limiting
    maxRequestsPerSecond: number;
    maxRequestsPerMinute: number;

    // Polling Intervals
    criticalUserPollMs: number;    // HF < 1.0
    highRiskUserPollMs: number;    // HF < 1.05
    mediumRiskUserPollMs: number;  // HF < 1.15
    lowRiskUserPollMs: number;     // HF >= 1.15

    // Batching
    multicallBatchSize: number;
    healthCheckBatchSize: number;

    // Cache TTLs
    healthFactorCacheTTL: number;
    priceCacheTTL: number;
    reserveConfigCacheTTL: number;

    // Subgraph
    subgraphRefreshMs: number;
    useSubgraphForInitialData: boolean;

    // Monitoramento
    rpcHealthCheckMs: number;
    maxConcurrentCalls: number;

    // Budget
    dailyCUBudget: number;
    hourlyCUBudget: number;
    warningThreshold: number; // % do budget
}

// ============================================================================
// PRESET: FREE TIER (Conservador)
// ============================================================================

export const FREE_TIER_CONFIG: OptimizationConfig = {
    // Rate Limiting - Conservador
    maxRequestsPerSecond: 15,      // Limite é 25, usamos 15 para margem
    maxRequestsPerMinute: 800,     // ~13/s média

    // Polling Intervals - Mais espaçados
    criticalUserPollMs: 1000,      // 1s para críticos
    highRiskUserPollMs: 5000,      // 5s para alto risco
    mediumRiskUserPollMs: 30000,   // 30s para médio risco
    lowRiskUserPollMs: 120000,     // 2min para baixo risco

    // Batching - Máximo possível
    multicallBatchSize: 100,       // Agrupa até 100 chamadas
    healthCheckBatchSize: 50,      // 50 usuários por batch

    // Cache TTLs - Mais longos para economizar
    healthFactorCacheTTL: 2000,    // 2s (compromisso)
    priceCacheTTL: 10000,          // 10s
    reserveConfigCacheTTL: 3600000, // 1 hora

    // Subgraph - Uso máximo
    subgraphRefreshMs: 120000,     // 2 minutos
    useSubgraphForInitialData: true,

    // Monitoramento
    rpcHealthCheckMs: 60000,       // 1 minuto
    maxConcurrentCalls: 5,

    // Budget
    dailyCUBudget: 900000,         // 90% de 1M
    hourlyCUBudget: 37500,         // 90% de 41.6K
    warningThreshold: 0.8
};

// ============================================================================
// PRESET: PAID TIER (Agressivo)
// ============================================================================

export const PAID_TIER_CONFIG: OptimizationConfig = {
    // Rate Limiting - Mais agressivo
    maxRequestsPerSecond: 250,     // Limite é 300
    maxRequestsPerMinute: 12000,

    // Polling Intervals - Mais frequentes
    criticalUserPollMs: 250,       // A cada bloco
    highRiskUserPollMs: 1000,      // 1s
    mediumRiskUserPollMs: 5000,    // 5s
    lowRiskUserPollMs: 30000,      // 30s

    // Batching
    multicallBatchSize: 100,
    healthCheckBatchSize: 100,

    // Cache TTLs - Mais curtos para dados frescos
    healthFactorCacheTTL: 500,     // 500ms
    priceCacheTTL: 2000,           // 2s
    reserveConfigCacheTTL: 3600000,

    // Subgraph
    subgraphRefreshMs: 30000,      // 30s
    useSubgraphForInitialData: true,

    // Monitoramento
    rpcHealthCheckMs: 30000,
    maxConcurrentCalls: 20,

    // Budget
    dailyCUBudget: 3000000,        // 3M por dia (100M / 30 dias)
    hourlyCUBudget: 125000,
    warningThreshold: 0.9
};

// ============================================================================
// PRESET: ULTRA ECONOMY (Mínimo absoluto)
// ============================================================================

export const ULTRA_ECONOMY_CONFIG: OptimizationConfig = {
    // Rate Limiting - Mínimo
    maxRequestsPerSecond: 5,
    maxRequestsPerMinute: 250,

    // Polling Intervals - Muito espaçados
    criticalUserPollMs: 2000,      // 2s
    highRiskUserPollMs: 10000,     // 10s
    mediumRiskUserPollMs: 60000,   // 1min
    lowRiskUserPollMs: 300000,     // 5min

    // Batching - Máximo
    multicallBatchSize: 100,
    healthCheckBatchSize: 100,

    // Cache TTLs - Muito longos
    healthFactorCacheTTL: 5000,    // 5s
    priceCacheTTL: 30000,          // 30s
    reserveConfigCacheTTL: 86400000, // 24 horas

    // Subgraph - Uso máximo, poucos updates
    subgraphRefreshMs: 300000,     // 5 minutos
    useSubgraphForInitialData: true,

    // Monitoramento
    rpcHealthCheckMs: 120000,      // 2 minutos
    maxConcurrentCalls: 2,

    // Budget
    dailyCUBudget: 500000,         // 50% do limite
    hourlyCUBudget: 20000,
    warningThreshold: 0.7
};

// ============================================================================
// CU TRACKER
// ============================================================================

export class CUTracker {
    private usedToday: number = 0;
    private usedThisHour: number = 0;
    private dayStart: number = Date.now();
    private hourStart: number = Date.now();
    private config: OptimizationConfig;

    constructor(config: OptimizationConfig = FREE_TIER_CONFIG) {
        this.config = config;
    }

    /**
     * Registra uso de CUs
     */
    record(cus: number): void {
        this.checkReset();
        this.usedToday += cus;
        this.usedThisHour += cus;
    }

    /**
     * Verifica e reseta contadores
     */
    private checkReset(): void {
        const now = Date.now();

        // Reset diário
        if (now - this.dayStart >= 86400000) {
            this.usedToday = 0;
            this.dayStart = now;
        }

        // Reset horário
        if (now - this.hourStart >= 3600000) {
            this.usedThisHour = 0;
            this.hourStart = now;
        }
    }

    /**
     * Verifica se está dentro do budget
     */
    isWithinBudget(): boolean {
        this.checkReset();
        return (
            this.usedToday < this.config.dailyCUBudget &&
            this.usedThisHour < this.config.hourlyCUBudget
        );
    }

    /**
     * Verifica se está perto do limite
     */
    isNearLimit(): boolean {
        this.checkReset();
        return (
            this.usedToday > this.config.dailyCUBudget * this.config.warningThreshold ||
            this.usedThisHour > this.config.hourlyCUBudget * this.config.warningThreshold
        );
    }

    /**
     * Retorna estatísticas
     */
    getStats(): {
        usedToday: number;
        usedThisHour: number;
        remainingToday: number;
        remainingThisHour: number;
        percentUsedToday: number;
        percentUsedThisHour: number;
    } {
        this.checkReset();
        return {
            usedToday: this.usedToday,
            usedThisHour: this.usedThisHour,
            remainingToday: this.config.dailyCUBudget - this.usedToday,
            remainingThisHour: this.config.hourlyCUBudget - this.usedThisHour,
            percentUsedToday: (this.usedToday / this.config.dailyCUBudget) * 100,
            percentUsedThisHour: (this.usedThisHour / this.config.hourlyCUBudget) * 100
        };
    }

    /**
     * Retorna resumo
     */
    getSummary(): string {
        const stats = this.getStats();
        return `CU Usage: ${stats.usedThisHour.toLocaleString()}/${this.config.hourlyCUBudget.toLocaleString()}/h (${stats.percentUsedThisHour.toFixed(1)}%) | ${stats.usedToday.toLocaleString()}/${this.config.dailyCUBudget.toLocaleString()}/d (${stats.percentUsedToday.toFixed(1)}%)`;
    }

    /**
     * Atualiza configuração
     */
    setConfig(config: OptimizationConfig): void {
        this.config = config;
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Seleciona configuração baseada no plano
 */
export function getConfigForPlan(plan: 'free' | 'paid' | 'economy'): OptimizationConfig {
    switch (plan) {
        case 'paid':
            return PAID_TIER_CONFIG;
        case 'economy':
            return ULTRA_ECONOMY_CONFIG;
        default:
            return FREE_TIER_CONFIG;
    }
}

/**
 * Estima CUs para uma operação
 */
export function estimateCUs(operation: string, count: number = 1): number {
    const baseCost = CU_COSTS[operation as keyof typeof CU_COSTS] || 26;
    return baseCost * count;
}

/**
 * Calcula economia do multicall
 */
export function calculateMulticallSavings(callCount: number): {
    withoutMulticall: number;
    withMulticall: number;
    saved: number;
    percentSaved: number;
} {
    const withoutMulticall = callCount * CU_COSTS.eth_call;
    const withMulticall = CU_COSTS.multicall;
    const saved = withoutMulticall - withMulticall;

    return {
        withoutMulticall,
        withMulticall,
        saved,
        percentSaved: (saved / withoutMulticall) * 100
    };
}

// ============================================================================
// SINGLETON
// ============================================================================

export const cuTracker = new CUTracker();
