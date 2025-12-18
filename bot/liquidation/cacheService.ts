/**
 * ============================================================================
 * CACHE SERVICE - Cache Inteligente para Reduzir CUs
 * ============================================================================
 *
 * Sistema de cache que:
 * - Cacheia dados que não mudam frequentemente
 * - TTL configurável por tipo de dado
 * - Invalidação automática
 *
 * ECONOMIA ESTIMADA: 50-70% de redução em CUs
 */

import { logger } from '../logger';

// ============================================================================
// INTERFACES
// ============================================================================

interface CacheEntry<T> {
    data: T;
    timestamp: number;
    ttl: number;
    hits: number;
}

interface CacheConfig {
    // TTLs em milissegundos
    healthFactorTTL: number;      // Health factors mudam a cada bloco
    priceTTL: number;             // Preços mudam frequentemente
    reserveConfigTTL: number;     // Configs de reserva raramente mudam
    userListTTL: number;          // Lista de usuários do subgraph
    blockNumberTTL: number;       // Block number muda a cada ~250ms no Arbitrum

    // Limites
    maxEntries: number;
    cleanupIntervalMs: number;
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: CacheConfig = {
    healthFactorTTL: 1000,        // 1 segundo (atualiza a cada bloco)
    priceTTL: 5000,               // 5 segundos
    reserveConfigTTL: 3600000,    // 1 hora (raramente muda)
    userListTTL: 60000,           // 1 minuto
    blockNumberTTL: 250,          // 250ms (tempo de bloco Arbitrum)
    maxEntries: 10000,
    cleanupIntervalMs: 60000
};

// ============================================================================
// CACHE SERVICE CLASS
// ============================================================================

export class CacheService {
    private cache: Map<string, CacheEntry<any>> = new Map();
    private config: CacheConfig;
    private cleanupInterval: NodeJS.Timeout | null = null;

    // Estatísticas
    private stats = {
        hits: 0,
        misses: 0,
        evictions: 0
    };

    constructor(config: Partial<CacheConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.startCleanup();
    }

    // ========================================================================
    // CORE METHODS
    // ========================================================================

    /**
     * Obtém valor do cache
     */
    get<T>(key: string): T | null {
        const entry = this.cache.get(key);

        if (!entry) {
            this.stats.misses++;
            return null;
        }

        // Verifica TTL
        if (Date.now() - entry.timestamp > entry.ttl) {
            this.cache.delete(key);
            this.stats.misses++;
            return null;
        }

        entry.hits++;
        this.stats.hits++;
        return entry.data as T;
    }

    /**
     * Define valor no cache
     */
    set<T>(key: string, data: T, ttl?: number): void {
        // Limpa se atingiu limite
        if (this.cache.size >= this.config.maxEntries) {
            this.evictOldest();
        }

        this.cache.set(key, {
            data,
            timestamp: Date.now(),
            ttl: ttl || 60000,
            hits: 0
        });
    }

    /**
     * Obtém ou define valor
     */
    async getOrSet<T>(
        key: string,
        fetcher: () => Promise<T>,
        ttl?: number
    ): Promise<T> {
        const cached = this.get<T>(key);
        if (cached !== null) {
            return cached;
        }

        const data = await fetcher();
        this.set(key, data, ttl);
        return data;
    }

    /**
     * Remove valor do cache
     */
    delete(key: string): boolean {
        return this.cache.delete(key);
    }

    /**
     * Remove valores por prefixo
     */
    deleteByPrefix(prefix: string): number {
        let count = 0;
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
                count++;
            }
        }
        return count;
    }

    /**
     * Limpa todo o cache
     */
    clear(): void {
        this.cache.clear();
    }

    // ========================================================================
    // SPECIALIZED CACHE METHODS
    // ========================================================================

    /**
     * Cache de Health Factor
     */
    getHealthFactor(userAddress: string): number | null {
        return this.get<number>(`hf:${userAddress.toLowerCase()}`);
    }

    setHealthFactor(userAddress: string, hf: number): void {
        this.set(`hf:${userAddress.toLowerCase()}`, hf, this.config.healthFactorTTL);
    }

    /**
     * Cache de Health Factors em batch
     */
    getHealthFactors(addresses: string[]): Map<string, number> {
        const results = new Map<string, number>();
        for (const addr of addresses) {
            const hf = this.getHealthFactor(addr);
            if (hf !== null) {
                results.set(addr.toLowerCase(), hf);
            }
        }
        return results;
    }

    setHealthFactors(data: Map<string, number>): void {
        for (const [addr, hf] of data) {
            this.setHealthFactor(addr, hf);
        }
    }

    /**
     * Retorna endereços sem cache
     */
    getUncachedAddresses(addresses: string[]): string[] {
        return addresses.filter(addr => this.getHealthFactor(addr) === null);
    }

    /**
     * Cache de Preços
     */
    getPrice(tokenAddress: string): number | null {
        return this.get<number>(`price:${tokenAddress.toLowerCase()}`);
    }

    setPrice(tokenAddress: string, price: number): void {
        this.set(`price:${tokenAddress.toLowerCase()}`, price, this.config.priceTTL);
    }

    /**
     * Cache de Configuração de Reserva
     */
    getReserveConfig(assetAddress: string): any | null {
        return this.get<any>(`reserve:${assetAddress.toLowerCase()}`);
    }

    setReserveConfig(assetAddress: string, config: any): void {
        this.set(`reserve:${assetAddress.toLowerCase()}`, config, this.config.reserveConfigTTL);
    }

    /**
     * Cache de Lista de Usuários
     */
    getUserList(): string[] | null {
        return this.get<string[]>('userList');
    }

    setUserList(users: string[]): void {
        this.set('userList', users, this.config.userListTTL);
    }

    /**
     * Cache de Block Number
     */
    getBlockNumber(): number | null {
        return this.get<number>('blockNumber');
    }

    setBlockNumber(blockNumber: number): void {
        this.set('blockNumber', blockNumber, this.config.blockNumberTTL);
    }

    // ========================================================================
    // MAINTENANCE
    // ========================================================================

    /**
     * Inicia limpeza periódica
     */
    private startCleanup(): void {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, this.config.cleanupIntervalMs);
    }

    /**
     * Remove entradas expiradas
     */
    cleanup(): number {
        const now = Date.now();
        let removed = 0;

        for (const [key, entry] of this.cache) {
            if (now - entry.timestamp > entry.ttl) {
                this.cache.delete(key);
                removed++;
            }
        }

        if (removed > 0) {
            logger.debug(`Cache cleanup: removed ${removed} expired entries`);
        }

        return removed;
    }

    /**
     * Remove entradas mais antigas (LRU simplificado)
     */
    private evictOldest(): void {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.cache) {
            // Prioriza remover entradas com menos hits e mais antigas
            const score = entry.timestamp - (entry.hits * 1000);
            if (score < oldestTime) {
                oldestTime = score;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
            this.stats.evictions++;
        }
    }

    /**
     * Para limpeza
     */
    stop(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    // ========================================================================
    // STATISTICS
    // ========================================================================

    /**
     * Retorna estatísticas do cache
     */
    getStats(): {
        entries: number;
        hits: number;
        misses: number;
        hitRate: number;
        evictions: number;
        memoryEstimate: string;
    } {
        const total = this.stats.hits + this.stats.misses;
        const hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;

        // Estimativa grosseira de memória
        const memoryBytes = this.cache.size * 500; // ~500 bytes por entrada média
        const memoryMB = memoryBytes / (1024 * 1024);

        return {
            entries: this.cache.size,
            hits: this.stats.hits,
            misses: this.stats.misses,
            hitRate: Math.round(hitRate * 100) / 100,
            evictions: this.stats.evictions,
            memoryEstimate: `${memoryMB.toFixed(2)} MB`
        };
    }

    /**
     * Retorna resumo formatado
     */
    getSummary(): string {
        const stats = this.getStats();
        return `Cache: ${stats.entries} entries | Hit rate: ${stats.hitRate}% | Memory: ${stats.memoryEstimate}`;
    }

    /**
     * Reset estatísticas
     */
    resetStats(): void {
        this.stats = { hits: 0, misses: 0, evictions: 0 };
    }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const cache = new CacheService();

// ============================================================================
// FACTORY
// ============================================================================

export function createCacheService(config?: Partial<CacheConfig>): CacheService {
    return new CacheService(config);
}
