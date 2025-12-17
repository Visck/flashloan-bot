/**
 * ============================================================================
 * RPC MANAGER - Multi-RPC com Fallback e Load Balancing
 * ============================================================================
 *
 * Gerencia múltiplos provedores RPC com:
 * - Health checks automáticos
 * - Fallback inteligente
 * - Load balancing baseado em latência
 * - Retry automático com timeout
 */

import { JsonRpcProvider, WebSocketProvider } from 'ethers';
import { logger } from '../logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface RPCConfig {
    name: string;
    httpUrl: string;
    wssUrl?: string;
    priority: number;
    maxRetries: number;
    timeout: number;
    weight?: number;
}

export interface RPCHealth {
    name: string;
    isHealthy: boolean;
    latencyMs: number;
    lastCheck: Date;
    errorCount: number;
    successCount: number;
    consecutiveErrors: number;
}

// ============================================================================
// RPC MANAGER CLASS
// ============================================================================

export class RPCManager {
    private rpcs: RPCConfig[];
    private health: Map<string, RPCHealth> = new Map();
    private providers: Map<string, JsonRpcProvider> = new Map();
    private wsProviders: Map<string, WebSocketProvider> = new Map();
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private currentProviderIndex: number = 0;

    constructor(rpcs: RPCConfig[]) {
        this.rpcs = rpcs.sort((a, b) => a.priority - b.priority);
        this.initializeProviders();
    }

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    private initializeProviders(): void {
        for (const rpc of this.rpcs) {
            if (!rpc.httpUrl) continue;

            try {
                const provider = new JsonRpcProvider(rpc.httpUrl, undefined, {
                    staticNetwork: true,
                    batchMaxCount: 1
                });
                this.providers.set(rpc.name, provider);

                this.health.set(rpc.name, {
                    name: rpc.name,
                    isHealthy: true,
                    latencyMs: 0,
                    lastCheck: new Date(),
                    errorCount: 0,
                    successCount: 0,
                    consecutiveErrors: 0
                });

                logger.debug(`RPC ${rpc.name} initialized`);
            } catch (error) {
                logger.error(`Failed to initialize RPC ${rpc.name}:`, error);
            }
        }

        logger.info(`RPCManager initialized with ${this.providers.size} providers`);
    }

    // ========================================================================
    // PROVIDER SELECTION
    // ========================================================================

    /**
     * Retorna o melhor provider disponível baseado em saúde e latência
     */
    async getBestProvider(): Promise<JsonRpcProvider> {
        const healthyRpcs = Array.from(this.health.entries())
            .filter(([_, h]) => h.isHealthy)
            .sort((a, b) => {
                // Primeiro por prioridade
                const rpcA = this.rpcs.find(r => r.name === a[0]);
                const rpcB = this.rpcs.find(r => r.name === b[0]);
                const priorityDiff = (rpcA?.priority || 99) - (rpcB?.priority || 99);
                if (priorityDiff !== 0) return priorityDiff;

                // Depois por latência
                return a[1].latencyMs - b[1].latencyMs;
            });

        if (healthyRpcs.length === 0) {
            // Tentar recuperar o primeiro provider mesmo se marcado como unhealthy
            const firstProvider = this.providers.values().next().value;
            if (firstProvider) {
                logger.warn('No healthy RPCs, using first available');
                return firstProvider;
            }
            throw new Error('No healthy RPCs available');
        }

        return this.providers.get(healthyRpcs[0][0])!;
    }

    /**
     * Retorna provider usando round-robin entre os saudáveis
     */
    getNextProvider(): JsonRpcProvider {
        const healthyProviders = Array.from(this.health.entries())
            .filter(([_, h]) => h.isHealthy)
            .map(([name]) => this.providers.get(name)!)
            .filter(Boolean);

        if (healthyProviders.length === 0) {
            const firstProvider = this.providers.values().next().value;
            if (!firstProvider) {
                throw new Error('No providers available');
            }
            return firstProvider;
        }

        this.currentProviderIndex = (this.currentProviderIndex + 1) % healthyProviders.length;
        return healthyProviders[this.currentProviderIndex];
    }

    /**
     * Retorna provider específico por nome
     */
    getProvider(name: string): JsonRpcProvider | undefined {
        return this.providers.get(name);
    }

    /**
     * Retorna todos os providers saudáveis
     */
    getHealthyProviders(): JsonRpcProvider[] {
        return Array.from(this.health.entries())
            .filter(([_, h]) => h.isHealthy)
            .map(([name]) => this.providers.get(name)!)
            .filter(Boolean);
    }

    // ========================================================================
    // HEALTH CHECKS
    // ========================================================================

    /**
     * Executa health check em todos os RPCs
     */
    async healthCheck(): Promise<void> {
        const checks = Array.from(this.providers.entries()).map(async ([name, provider]) => {
            const start = Date.now();
            const health = this.health.get(name)!;

            try {
                await Promise.race([
                    provider.getBlockNumber(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Health check timeout')), 5000)
                    )
                ]);

                const latency = Date.now() - start;

                health.isHealthy = true;
                health.latencyMs = latency;
                health.lastCheck = new Date();
                health.successCount++;
                health.consecutiveErrors = 0;

                logger.debug(`RPC ${name}: ${latency}ms ✓`);
            } catch (error) {
                health.errorCount++;
                health.consecutiveErrors++;
                health.lastCheck = new Date();

                // Marca como unhealthy após 3 erros consecutivos
                if (health.consecutiveErrors >= 3) {
                    health.isHealthy = false;
                    logger.warn(`RPC ${name} marked unhealthy after ${health.consecutiveErrors} errors`);
                }
            }
        });

        await Promise.allSettled(checks);
    }

    /**
     * Inicia health checks periódicos
     */
    startHealthChecks(intervalMs: number = 30000): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }

        // Health check inicial
        this.healthCheck();

        this.healthCheckInterval = setInterval(() => {
            this.healthCheck();
        }, intervalMs);

        logger.info(`Health checks started (every ${intervalMs}ms)`);
    }

    /**
     * Para health checks
     */
    stopHealthChecks(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    // ========================================================================
    // EXECUTION WITH FALLBACK
    // ========================================================================

    /**
     * Executa função com fallback automático entre RPCs
     */
    async executeWithFallback<T>(
        fn: (provider: JsonRpcProvider) => Promise<T>,
        options: { timeout?: number; maxRetries?: number } = {}
    ): Promise<T> {
        const { timeout = 5000, maxRetries = 2 } = options;

        for (const rpc of this.rpcs) {
            const health = this.health.get(rpc.name);
            if (!health?.isHealthy && this.hasHealthyProviders()) continue;

            const provider = this.providers.get(rpc.name);
            if (!provider) continue;

            for (let retry = 0; retry <= maxRetries; retry++) {
                const start = Date.now();

                try {
                    const result = await Promise.race([
                        fn(provider),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error('Timeout')), timeout)
                        )
                    ]);

                    // Atualiza métricas de sucesso
                    if (health) {
                        health.successCount++;
                        health.latencyMs = Date.now() - start;
                        health.consecutiveErrors = 0;
                        health.isHealthy = true;
                    }

                    return result;
                } catch (error) {
                    const latency = Date.now() - start;
                    logger.warn(`RPC ${rpc.name} attempt ${retry + 1}/${maxRetries + 1} failed (${latency}ms)`);

                    if (health) {
                        health.errorCount++;
                        health.consecutiveErrors++;
                    }

                    // Último retry deste RPC
                    if (retry === maxRetries) {
                        if (health && health.consecutiveErrors >= 3) {
                            health.isHealthy = false;
                        }
                    }
                }
            }
        }

        throw new Error('All RPCs failed after retries');
    }

    /**
     * Executa em paralelo em múltiplos RPCs (para verificação de dados)
     */
    async executeParallel<T>(
        fn: (provider: JsonRpcProvider) => Promise<T>,
        minResponses: number = 1
    ): Promise<T[]> {
        const healthyProviders = this.getHealthyProviders();

        if (healthyProviders.length < minResponses) {
            throw new Error(`Need ${minResponses} healthy RPCs, only ${healthyProviders.length} available`);
        }

        const results = await Promise.allSettled(
            healthyProviders.map(provider => fn(provider))
        );

        const successes: T[] = [];
        for (const result of results) {
            if (result.status === 'fulfilled') {
                successes.push(result.value);
            }
        }

        if (successes.length < minResponses) {
            throw new Error(`Only ${successes.length}/${minResponses} required responses succeeded`);
        }

        return successes;
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    private hasHealthyProviders(): boolean {
        return Array.from(this.health.values()).some(h => h.isHealthy);
    }

    /**
     * Retorna métricas de todos os RPCs
     */
    getMetrics(): RPCHealth[] {
        return Array.from(this.health.values());
    }

    /**
     * Retorna resumo do status
     */
    getStatus(): {
        total: number;
        healthy: number;
        avgLatency: number;
        providers: RPCHealth[];
    } {
        const metrics = this.getMetrics();
        const healthy = metrics.filter(m => m.isHealthy);
        const avgLatency = healthy.length > 0
            ? healthy.reduce((sum, m) => sum + m.latencyMs, 0) / healthy.length
            : 0;

        return {
            total: metrics.length,
            healthy: healthy.length,
            avgLatency: Math.round(avgLatency),
            providers: metrics
        };
    }

    /**
     * Reseta estado de um RPC específico
     */
    resetProvider(name: string): void {
        const health = this.health.get(name);
        if (health) {
            health.isHealthy = true;
            health.consecutiveErrors = 0;
            logger.info(`RPC ${name} reset to healthy`);
        }
    }

    /**
     * Cleanup
     */
    async destroy(): Promise<void> {
        this.stopHealthChecks();

        for (const [name, provider] of this.providers) {
            try {
                await provider.destroy();
            } catch {
                // Ignore
            }
        }

        for (const [name, ws] of this.wsProviders) {
            try {
                await ws.destroy();
            } catch {
                // Ignore
            }
        }

        this.providers.clear();
        this.wsProviders.clear();
        this.health.clear();
    }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Cria RPCManager com configuração do ambiente
 */
export function createRPCManager(): RPCManager {
    const rpcs: RPCConfig[] = [];

    // Primary RPC (Alchemy)
    if (process.env.ARBITRUM_RPC_PRIMARY) {
        rpcs.push({
            name: 'alchemy',
            httpUrl: process.env.ARBITRUM_RPC_PRIMARY,
            wssUrl: process.env.ARBITRUM_WSS_PRIMARY,
            priority: 1,
            maxRetries: 3,
            timeout: parseInt(process.env.RPC_TIMEOUT_MS || '5000')
        });
    }

    // Backup 1 (Infura)
    if (process.env.ARBITRUM_RPC_BACKUP1) {
        rpcs.push({
            name: 'infura',
            httpUrl: process.env.ARBITRUM_RPC_BACKUP1,
            priority: 2,
            maxRetries: 2,
            timeout: parseInt(process.env.RPC_TIMEOUT_MS || '5000')
        });
    }

    // Backup 2 (Public)
    rpcs.push({
        name: 'public',
        httpUrl: process.env.ARBITRUM_RPC_BACKUP2 || 'https://arb1.arbitrum.io/rpc',
        priority: 3,
        maxRetries: 2,
        timeout: 10000
    });

    // Backup 3 (Ankr)
    rpcs.push({
        name: 'ankr',
        httpUrl: 'https://rpc.ankr.com/arbitrum',
        priority: 4,
        maxRetries: 2,
        timeout: 10000
    });

    return new RPCManager(rpcs.filter(rpc => rpc.httpUrl));
}
