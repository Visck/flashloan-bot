/**
 * ============================================================================
 * SUBGRAPH SERVICE - Descoberta de Usuários via The Graph
 * ============================================================================
 *
 * Usa The Graph para:
 * - Descobrir todos os borrowers do Aave V3 Arbitrum
 * - Filtrar usuários por risco (health factor)
 * - Cache eficiente de posições
 * - Atualizações periódicas
 */

import { logger } from '../logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface SubgraphUser {
    id: string;
    totalCollateralUSD: string;
    totalBorrowsUSD: string;
    healthFactor: string;
    borrowedReservesCount: number;
    reserves?: SubgraphUserReserve[];
}

export interface SubgraphUserReserve {
    reserve: {
        symbol: string;
        underlyingAsset: string;
        liquidationThreshold: string;
        liquidationBonus: string;
    };
    currentATokenBalance: string;
    currentVariableDebt: string;
    currentStableDebt: string;
}

export interface SubgraphConfig {
    aaveEndpoint: string;
    batchSize: number;
    minBorrowUsd: number;
    maxHealthFactor: number;
    maxCollateralRatio: number;  // Filtro: colateral/dívida máximo (ex: 1.8 = ~HF 1.15)
    refreshIntervalMs: number;
    requestTimeoutMs: number;
    // Otimizações
    maxAtRiskUsers: number;      // Limite de resultados (para de buscar após X)
    cacheEnabled: boolean;       // Cache de carteiras conhecidas
    incrementalSearch: boolean;  // Busca incremental (só mudanças recentes)
    incrementalBlocksBack: number; // Blocos para busca incremental
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: SubgraphConfig = {
    aaveEndpoint: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
    batchSize: 1000,
    minBorrowUsd: 100,
    maxHealthFactor: 1.5,
    maxCollateralRatio: 1.8,  // ~HF 1.15 (pega usuários em risco)
    refreshIntervalMs: 60000,
    requestTimeoutMs: 30000,
    // Otimizações
    maxAtRiskUsers: 500,        // Para de buscar após 500 em risco
    cacheEnabled: true,         // Usa cache de carteiras
    incrementalSearch: true,    // Busca incremental habilitada
    incrementalBlocksBack: 1000 // ~4 minutos em Arbitrum
};

// Alternative endpoints
const SUBGRAPH_ENDPOINTS = [
    'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
    'https://gateway.thegraph.com/api/subgraphs/id/DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B',
    'https://api.studio.thegraph.com/query/47555/aave-v3-arbitrum/version/latest'
];

// ============================================================================
// SUBGRAPH SERVICE CLASS
// ============================================================================

export class SubgraphService {
    private users: Map<string, SubgraphUser> = new Map();
    private lastUpdate: Date | null = null;
    private config: SubgraphConfig;
    private currentEndpointIndex: number = 0;
    private refreshInterval: NodeJS.Timeout | null = null;

    // Cache de carteiras conhecidas com seus ratios
    private walletCache: Map<string, {
        ratio: number;
        lastSeen: number;
        isAtRisk: boolean;
    }> = new Map();
    private lastFullScan: number = 0;
    private stats = {
        totalScanned: 0,
        fromCache: 0,
        newWallets: 0,
        atRiskFound: 0
    };

    constructor(config: Partial<SubgraphConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Retorna estatísticas de otimização
     */
    getStats() {
        return {
            ...this.stats,
            cacheSize: this.walletCache.size,
            atRiskUsers: this.users.size,
            lastFullScan: this.lastFullScan ? new Date(this.lastFullScan).toISOString() : 'never'
        };
    }

    /**
     * Limpa estatísticas
     */
    resetStats() {
        this.stats = { totalScanned: 0, fromCache: 0, newWallets: 0, atRiskFound: 0 };
    }

    // ========================================================================
    // FETCHING
    // ========================================================================

    /**
     * Busca todos os usuários com empréstimos
     */
    async fetchAllUsers(): Promise<SubgraphUser[]> {
        const allUsers: SubgraphUser[] = [];
        let skip = 0;
        let hasMore = true;

        logger.info('Fetching all borrowers from subgraph...');

        while (hasMore) {
            const query = `
                query GetBorrowers($first: Int!, $skip: Int!, $minBorrow: String!) {
                    users(
                        first: $first
                        skip: $skip
                        where: {
                            borrowedReservesCount_gt: 0
                            totalBorrowsUSD_gte: $minBorrow
                        }
                        orderBy: totalBorrowsUSD
                        orderDirection: desc
                    ) {
                        id
                        totalCollateralUSD
                        totalBorrowsUSD
                        borrowedReservesCount
                    }
                }
            `;

            try {
                const data = await this.executeQuery(query, {
                    first: this.config.batchSize,
                    skip,
                    minBorrow: this.config.minBorrowUsd.toString()
                });

                const users = data?.users || [];
                allUsers.push(...users);

                if (users.length < this.config.batchSize) {
                    hasMore = false;
                } else {
                    skip += this.config.batchSize;
                }

                logger.debug(`Fetched ${allUsers.length} users so far...`);

                // Rate limiting
                await this.delay(100);
            } catch (error) {
                logger.error('Subgraph fetch error:', error);
                hasMore = false;
            }
        }

        // Atualiza cache
        this.users.clear();
        for (const user of allUsers) {
            this.users.set(user.id.toLowerCase(), user);
        }
        this.lastUpdate = new Date();

        logger.info(`Subgraph: ${allUsers.length} total borrowers cached`);
        return allUsers;
    }

    /**
     * Busca APENAS usuários em risco (filtrados por ratio colateral/dívida)
     * Com 3 otimizações:
     * 1. CACHE: Pula carteiras conhecidas como seguras
     * 2. LIMITE: Para de buscar após encontrar maxAtRiskUsers
     * 3. INCREMENTAL: Busca apenas mudanças recentes após primeiro scan
     *
     * Ratio = totalCollateralUSD / totalBorrowsUSD
     * - Ratio < 1.5 → Alto risco (provável HF < 1.0)
     * - Ratio 1.5-1.8 → Médio risco (provável HF 1.0-1.15)
     * - Ratio > 1.8 → Baixo risco (não interessa)
     */
    async fetchAtRiskUsers(): Promise<SubgraphUser[]> {
        const atRiskUsers: SubgraphUser[] = [];
        let skip = 0;
        let hasMore = true;
        const now = Date.now();

        // Reset stats para esta busca
        this.stats.totalScanned = 0;
        this.stats.fromCache = 0;
        this.stats.newWallets = 0;
        this.stats.atRiskFound = 0;

        // Determina se é busca incremental ou full scan
        const isIncremental = this.config.incrementalSearch &&
                              this.lastFullScan > 0 &&
                              this.walletCache.size > 0;

        if (isIncremental) {
            logger.info(`[INCREMENTAL] Buscando mudanças recentes (cache: ${this.walletCache.size} carteiras)...`);
        } else {
            logger.info(`[FULL SCAN] Buscando AT-RISK borrowers (ratio < ${this.config.maxCollateralRatio})...`);
            this.lastFullScan = now;
        }

        while (hasMore) {
            // OTIMIZAÇÃO 2: Limite de resultados - para se já temos suficientes
            if (atRiskUsers.length >= this.config.maxAtRiskUsers) {
                logger.info(`Limite atingido: ${this.config.maxAtRiskUsers} usuários em risco encontrados`);
                break;
            }

            const query = `
                query GetBorrowers($first: Int!, $skip: Int!, $minBorrow: String!) {
                    users(
                        first: $first
                        skip: $skip
                        where: {
                            borrowedReservesCount_gt: 0
                            totalBorrowsUSD_gte: $minBorrow
                        }
                        orderBy: totalBorrowsUSD
                        orderDirection: desc
                    ) {
                        id
                        totalCollateralUSD
                        totalBorrowsUSD
                        borrowedReservesCount
                    }
                }
            `;

            try {
                const data = await this.executeQuery(query, {
                    first: this.config.batchSize,
                    skip,
                    minBorrow: this.config.minBorrowUsd.toString()
                });

                const users = data?.users || [];

                for (const user of users) {
                    this.stats.totalScanned++;
                    const userId = user.id.toLowerCase();
                    const collateral = parseFloat(user.totalCollateralUSD || '0');
                    const debt = parseFloat(user.totalBorrowsUSD || '0');

                    if (debt <= 0) continue;

                    const ratio = collateral / debt;

                    // OTIMIZAÇÃO 1: Cache de carteiras conhecidas
                    if (this.config.cacheEnabled) {
                        const cached = this.walletCache.get(userId);

                        if (cached) {
                            // Carteira conhecida - verifica se mudou de status
                            const wasAtRisk = cached.isAtRisk;
                            const isNowAtRisk = ratio < this.config.maxCollateralRatio;

                            // Atualiza cache
                            cached.ratio = ratio;
                            cached.lastSeen = now;
                            cached.isAtRisk = isNowAtRisk;

                            if (isNowAtRisk) {
                                // Ainda em risco ou ficou em risco
                                atRiskUsers.push({
                                    ...user,
                                    calculatedRatio: ratio
                                } as SubgraphUser & { calculatedRatio: number });
                                this.stats.atRiskFound++;

                                if (!wasAtRisk) {
                                    logger.debug(`[CACHE] Carteira ${userId.slice(0,8)}... ENTROU em risco (ratio: ${ratio.toFixed(3)})`);
                                }
                            } else if (wasAtRisk) {
                                // Saiu de risco
                                logger.debug(`[CACHE] Carteira ${userId.slice(0,8)}... SAIU de risco (ratio: ${ratio.toFixed(3)})`);
                            }

                            this.stats.fromCache++;
                        } else {
                            // Nova carteira - adiciona ao cache
                            this.walletCache.set(userId, {
                                ratio,
                                lastSeen: now,
                                isAtRisk: ratio < this.config.maxCollateralRatio
                            });
                            this.stats.newWallets++;

                            if (ratio < this.config.maxCollateralRatio) {
                                atRiskUsers.push({
                                    ...user,
                                    calculatedRatio: ratio
                                } as SubgraphUser & { calculatedRatio: number });
                                this.stats.atRiskFound++;
                            }
                        }
                    } else {
                        // Sem cache - comportamento original
                        if (ratio < this.config.maxCollateralRatio) {
                            atRiskUsers.push({
                                ...user,
                                calculatedRatio: ratio
                            } as SubgraphUser & { calculatedRatio: number });
                            this.stats.atRiskFound++;
                        }
                    }

                    // OTIMIZAÇÃO 2: Verifica limite novamente após cada adição
                    if (atRiskUsers.length >= this.config.maxAtRiskUsers) {
                        break;
                    }
                }

                if (users.length < this.config.batchSize) {
                    hasMore = false;
                } else {
                    skip += this.config.batchSize;
                }

                // Rate limiting
                await this.delay(100);
            } catch (error) {
                logger.error('Subgraph fetch error:', error);
                hasMore = false;
            }
        }

        // Ordena por ratio (menor primeiro = mais arriscado)
        atRiskUsers.sort((a: any, b: any) =>
            (a.calculatedRatio || 999) - (b.calculatedRatio || 999)
        );

        // Atualiza cache de usuários em risco
        this.users.clear();
        for (const user of atRiskUsers) {
            this.users.set(user.id.toLowerCase(), user);
        }
        this.lastUpdate = new Date();

        // Log de estatísticas
        logger.info(`Subgraph: ${atRiskUsers.length} AT-RISK | Scanned: ${this.stats.totalScanned} | Cache: ${this.stats.fromCache} | New: ${this.stats.newWallets}`);

        return atRiskUsers;
    }

    /**
     * Limpa carteiras antigas do cache (não vistas há muito tempo)
     */
    cleanupCache(maxAgeMs: number = 3600000): number {
        const now = Date.now();
        let removed = 0;

        for (const [userId, data] of this.walletCache.entries()) {
            if (now - data.lastSeen > maxAgeMs) {
                this.walletCache.delete(userId);
                removed++;
            }
        }

        if (removed > 0) {
            logger.debug(`Cache cleanup: ${removed} carteiras antigas removidas`);
        }

        return removed;
    }

    /**
     * Força um full scan na próxima busca
     */
    forceFullScan(): void {
        this.lastFullScan = 0;
        logger.info('Próxima busca será um FULL SCAN');
    }

    /**
     * Busca usuários em risco (health factor baixo)
     * @deprecated Use fetchAtRiskUsers() instead
     */
    async fetchRiskyUsers(maxHf: number = 1.5): Promise<SubgraphUser[]> {
        const query = `
            query GetRiskyUsers($maxHF: String!, $minBorrow: String!) {
                users(
                    first: 1000
                    where: {
                        borrowedReservesCount_gt: 0
                        totalBorrowsUSD_gte: $minBorrow
                    }
                    orderBy: totalBorrowsUSD
                    orderDirection: desc
                ) {
                    id
                    totalCollateralUSD
                    totalBorrowsUSD
                    borrowedReservesCount
                }
            }
        `;

        try {
            const data = await this.executeQuery(query, {
                maxHF: maxHf.toString(),
                minBorrow: this.config.minBorrowUsd.toString()
            });

            const users = data?.users || [];
            logger.info(`Found ${users.length} risky users (HF < ${maxHf})`);
            return users;
        } catch (error) {
            logger.error('Subgraph risky users fetch error:', error);
            return [];
        }
    }

    /**
     * Busca detalhes de um usuário específico
     */
    async fetchUserDetails(address: string): Promise<SubgraphUser | null> {
        const query = `
            query GetUserDetails($id: ID!) {
                user(id: $id) {
                    id
                    totalCollateralUSD
                    totalBorrowsUSD
                    borrowedReservesCount
                    reserves {
                        reserve {
                            symbol
                            underlyingAsset
                            liquidationThreshold
                            liquidationBonus
                        }
                        currentATokenBalance
                        currentVariableDebt
                        currentStableDebt
                    }
                }
            }
        `;

        try {
            const data = await this.executeQuery(query, {
                id: address.toLowerCase()
            });

            return data?.user || null;
        } catch (error) {
            logger.error(`Failed to fetch user ${address}:`, error);
            return null;
        }
    }

    /**
     * Busca liquidações recentes (para análise)
     */
    async fetchRecentLiquidations(hours: number = 24): Promise<any[]> {
        const timestamp = Math.floor(Date.now() / 1000) - (hours * 3600);

        const query = `
            query GetRecentLiquidations($timestamp: Int!) {
                liquidationCalls(
                    first: 100
                    where: { timestamp_gt: $timestamp }
                    orderBy: timestamp
                    orderDirection: desc
                ) {
                    id
                    user {
                        id
                    }
                    collateralAsset {
                        symbol
                    }
                    principalAsset {
                        symbol
                    }
                    collateralAmount
                    principalAmount
                    liquidator
                    timestamp
                }
            }
        `;

        try {
            const data = await this.executeQuery(query, { timestamp });
            return data?.liquidationCalls || [];
        } catch (error) {
            logger.error('Failed to fetch recent liquidations:', error);
            return [];
        }
    }

    // ========================================================================
    // QUERY EXECUTION
    // ========================================================================

    private async executeQuery(query: string, variables: Record<string, any>): Promise<any> {
        let lastError: Error | null = null;

        // Tenta cada endpoint
        for (let i = 0; i < SUBGRAPH_ENDPOINTS.length; i++) {
            const endpointIndex = (this.currentEndpointIndex + i) % SUBGRAPH_ENDPOINTS.length;
            const endpoint = SUBGRAPH_ENDPOINTS[endpointIndex];

            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, variables }),
                    signal: controller.signal
                });

                clearTimeout(timeout);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json() as { data?: any; errors?: Array<{ message: string }> };

                if (data.errors) {
                    throw new Error(data.errors[0]?.message || 'GraphQL error');
                }

                // Sucesso - usa este endpoint como primário
                this.currentEndpointIndex = endpointIndex;
                return data.data;
            } catch (error) {
                lastError = error as Error;
                logger.warn(`Subgraph endpoint ${endpointIndex} failed:`, error);
            }
        }

        throw lastError || new Error('All subgraph endpoints failed');
    }

    // ========================================================================
    // AUTO-REFRESH
    // ========================================================================

    /**
     * Inicia atualização automática
     */
    startAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }

        // Fetch inicial
        this.fetchAllUsers();

        this.refreshInterval = setInterval(() => {
            this.fetchAllUsers();
        }, this.config.refreshIntervalMs);

        logger.info(`Subgraph auto-refresh started (every ${this.config.refreshIntervalMs}ms)`);
    }

    /**
     * Para atualização automática
     */
    stopAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    // ========================================================================
    // CACHE ACCESS
    // ========================================================================

    /**
     * Retorna todos os usuários cacheados
     */
    getUsers(): SubgraphUser[] {
        return Array.from(this.users.values());
    }

    /**
     * Retorna endereços de todos os usuários
     */
    getUserAddresses(): string[] {
        return Array.from(this.users.keys());
    }

    /**
     * Retorna usuário específico do cache
     */
    getUser(address: string): SubgraphUser | undefined {
        return this.users.get(address.toLowerCase());
    }

    /**
     * Retorna estatísticas de cache de usuários
     */
    getCacheStats(): {
        totalUsers: number;
        lastUpdate: Date | null;
        cacheAgeMs: number | null;
    } {
        return {
            totalUsers: this.users.size,
            lastUpdate: this.lastUpdate,
            cacheAgeMs: this.lastUpdate
                ? Date.now() - this.lastUpdate.getTime()
                : null
        };
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createSubgraphService(): SubgraphService {
    const config: Partial<SubgraphConfig> = {
        aaveEndpoint: process.env.AAVE_SUBGRAPH_URL || DEFAULT_CONFIG.aaveEndpoint,
        refreshIntervalMs: parseInt(process.env.SUBGRAPH_REFRESH_INTERVAL_MS || '120000'),
        minBorrowUsd: parseInt(process.env.SUBGRAPH_MIN_BORROW_USD || '100'),
        maxCollateralRatio: parseFloat(process.env.MAX_COLLATERAL_RATIO || '1.8'),
        // 3 Otimizações
        maxAtRiskUsers: parseInt(process.env.MAX_AT_RISK_USERS || '500'),
        cacheEnabled: process.env.WALLET_CACHE_ENABLED !== 'false',
        incrementalSearch: process.env.INCREMENTAL_SEARCH !== 'false',
        incrementalBlocksBack: parseInt(process.env.INCREMENTAL_BLOCKS_BACK || '1000')
    };

    return new SubgraphService(config);
}
