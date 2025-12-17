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
    refreshIntervalMs: number;
    requestTimeoutMs: number;
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: SubgraphConfig = {
    aaveEndpoint: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
    batchSize: 1000,
    minBorrowUsd: 100,
    maxHealthFactor: 1.5,
    refreshIntervalMs: 60000,
    requestTimeoutMs: 30000
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

    constructor(config: Partial<SubgraphConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
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
     * Busca usuários em risco (health factor baixo)
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
     * Retorna estatísticas
     */
    getStats(): {
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
        refreshIntervalMs: parseInt(process.env.SUBGRAPH_REFRESH_INTERVAL_MS || '60000'),
        minBorrowUsd: parseInt(process.env.SUBGRAPH_MIN_BORROW_USD || '100')
    };

    return new SubgraphService(config);
}
