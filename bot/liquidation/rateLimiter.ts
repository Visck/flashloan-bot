/**
 * ============================================================================
 * RATE LIMITER - Controle de Taxa de Requisições
 * ============================================================================
 *
 * Limita chamadas RPC para:
 * - Não exceder limites do plano Alchemy (25 req/s free, 300 req/s paid)
 * - Distribuir chamadas uniformemente
 * - Evitar throttling
 *
 * ECONOMIA: Evita desperdício por throttling/retries
 */

import { logger } from '../logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface RateLimiterConfig {
    maxRequestsPerSecond: number;
    maxRequestsPerMinute: number;
    maxBurstSize: number;
    windowSizeMs: number;
}

interface QueuedRequest<T> {
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    priority: number;
    timestamp: number;
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: RateLimiterConfig = {
    maxRequestsPerSecond: 20,     // Conservador para Free tier (limite é 25)
    maxRequestsPerMinute: 1000,   // ~16/s média
    maxBurstSize: 10,             // Permite burst curto
    windowSizeMs: 1000
};

// ============================================================================
// TOKEN BUCKET RATE LIMITER
// ============================================================================

export class RateLimiter {
    private config: RateLimiterConfig;
    private tokens: number;
    private lastRefill: number;
    private requestsThisMinute: number = 0;
    private minuteStart: number;
    private queue: QueuedRequest<any>[] = [];
    private isProcessing: boolean = false;

    // Estatísticas
    private stats = {
        totalRequests: 0,
        throttledRequests: 0,
        queuedRequests: 0,
        avgWaitTimeMs: 0
    };
    private waitTimes: number[] = [];

    constructor(config: Partial<RateLimiterConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.tokens = this.config.maxBurstSize;
        this.lastRefill = Date.now();
        this.minuteStart = Date.now();
    }

    // ========================================================================
    // CORE METHODS
    // ========================================================================

    /**
     * Executa função respeitando rate limit
     */
    async execute<T>(
        fn: () => Promise<T>,
        priority: number = 0
    ): Promise<T> {
        this.stats.totalRequests++;

        // Verifica limite por minuto
        this.checkMinuteLimit();

        // Tenta adquirir token
        if (this.tryAcquire()) {
            this.requestsThisMinute++;
            return fn();
        }

        // Coloca na fila se não conseguir token
        this.stats.queuedRequests++;

        return new Promise((resolve, reject) => {
            this.queue.push({
                fn,
                resolve,
                reject,
                priority,
                timestamp: Date.now()
            });

            // Ordena por prioridade (maior primeiro)
            this.queue.sort((a, b) => b.priority - a.priority);

            this.processQueue();
        });
    }

    /**
     * Tenta adquirir um token
     */
    private tryAcquire(): boolean {
        this.refillTokens();

        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }

        this.stats.throttledRequests++;
        return false;
    }

    /**
     * Reabastece tokens baseado no tempo passado
     */
    private refillTokens(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const tokensToAdd = (elapsed / this.config.windowSizeMs) * this.config.maxRequestsPerSecond;

        this.tokens = Math.min(
            this.config.maxBurstSize,
            this.tokens + tokensToAdd
        );
        this.lastRefill = now;
    }

    /**
     * Verifica e reseta limite por minuto
     */
    private checkMinuteLimit(): void {
        const now = Date.now();
        if (now - this.minuteStart >= 60000) {
            this.requestsThisMinute = 0;
            this.minuteStart = now;
        }
    }

    /**
     * Processa fila de requisições
     */
    private async processQueue(): Promise<void> {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;

        while (this.queue.length > 0) {
            // Verifica limite por minuto
            if (this.requestsThisMinute >= this.config.maxRequestsPerMinute) {
                const waitTime = 60000 - (Date.now() - this.minuteStart);
                await this.delay(waitTime);
                this.requestsThisMinute = 0;
                this.minuteStart = Date.now();
            }

            // Espera por token
            while (!this.tryAcquire()) {
                await this.delay(50); // Espera 50ms e tenta novamente
            }

            const request = this.queue.shift();
            if (!request) break;

            const waitTime = Date.now() - request.timestamp;
            this.recordWaitTime(waitTime);

            this.requestsThisMinute++;

            try {
                const result = await request.fn();
                request.resolve(result);
            } catch (error) {
                request.reject(error as Error);
            }
        }

        this.isProcessing = false;
    }

    // ========================================================================
    // BATCH EXECUTION
    // ========================================================================

    /**
     * Executa múltiplas funções respeitando rate limit
     */
    async executeBatch<T>(
        fns: Array<() => Promise<T>>,
        priority: number = 0
    ): Promise<T[]> {
        return Promise.all(fns.map(fn => this.execute(fn, priority)));
    }

    /**
     * Executa funções em série com rate limit
     */
    async executeSerial<T>(
        fns: Array<() => Promise<T>>,
        priority: number = 0
    ): Promise<T[]> {
        const results: T[] = [];
        for (const fn of fns) {
            results.push(await this.execute(fn, priority));
        }
        return results;
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private recordWaitTime(ms: number): void {
        this.waitTimes.push(ms);
        if (this.waitTimes.length > 100) {
            this.waitTimes.shift();
        }
        this.stats.avgWaitTimeMs =
            this.waitTimes.reduce((a, b) => a + b, 0) / this.waitTimes.length;
    }

    // ========================================================================
    // CONFIGURATION
    // ========================================================================

    /**
     * Atualiza configuração (ex: após upgrade de plano)
     */
    updateConfig(config: Partial<RateLimiterConfig>): void {
        this.config = { ...this.config, ...config };
        logger.info(`Rate limiter updated: ${this.config.maxRequestsPerSecond} req/s`);
    }

    /**
     * Configura para plano Free
     */
    setFreeTier(): void {
        this.updateConfig({
            maxRequestsPerSecond: 20,
            maxRequestsPerMinute: 1000,
            maxBurstSize: 10
        });
    }

    /**
     * Configura para plano Paid
     */
    setPaidTier(): void {
        this.updateConfig({
            maxRequestsPerSecond: 250,
            maxRequestsPerMinute: 10000,
            maxBurstSize: 50
        });
    }

    // ========================================================================
    // STATISTICS
    // ========================================================================

    /**
     * Retorna estatísticas
     */
    getStats(): {
        totalRequests: number;
        throttledRequests: number;
        throttleRate: number;
        queuedRequests: number;
        avgWaitTimeMs: number;
        currentQueueSize: number;
        tokensAvailable: number;
        requestsThisMinute: number;
    } {
        const throttleRate = this.stats.totalRequests > 0
            ? (this.stats.throttledRequests / this.stats.totalRequests) * 100
            : 0;

        return {
            ...this.stats,
            throttleRate: Math.round(throttleRate * 100) / 100,
            currentQueueSize: this.queue.length,
            tokensAvailable: Math.floor(this.tokens),
            requestsThisMinute: this.requestsThisMinute
        };
    }

    /**
     * Retorna resumo
     */
    getSummary(): string {
        const stats = this.getStats();
        return `RateLimit: ${stats.requestsThisMinute}/${this.config.maxRequestsPerMinute}/min | Throttled: ${stats.throttleRate}% | Queue: ${stats.currentQueueSize}`;
    }

    /**
     * Reset estatísticas
     */
    resetStats(): void {
        this.stats = {
            totalRequests: 0,
            throttledRequests: 0,
            queuedRequests: 0,
            avgWaitTimeMs: 0
        };
        this.waitTimes = [];
    }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const rateLimiter = new RateLimiter();

// ============================================================================
// FACTORY
// ============================================================================

export function createRateLimiter(config?: Partial<RateLimiterConfig>): RateLimiter {
    return new RateLimiter(config);
}
