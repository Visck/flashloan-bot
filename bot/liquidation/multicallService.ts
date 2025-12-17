/**
 * ============================================================================
 * MULTICALL SERVICE - Batching de Chamadas RPC
 * ============================================================================
 *
 * Reduz consumo de CUs agrupando múltiplas chamadas em uma só.
 * Uma chamada multicall = 1 CU ao invés de N CUs.
 *
 * ECONOMIA ESTIMADA: 80-90% de redução em CUs
 */

import { JsonRpcProvider, Contract, Interface } from 'ethers';
import { logger } from '../logger';

// ============================================================================
// MULTICALL3 ADDRESS (Same on all chains)
// ============================================================================

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
    'function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])'
];

// ============================================================================
// INTERFACES
// ============================================================================

export interface Call {
    target: string;
    callData: string;
    allowFailure?: boolean;
}

export interface CallResult {
    success: boolean;
    returnData: string;
}

export interface DecodedCallResult<T> {
    success: boolean;
    data: T | null;
    error?: string;
}

// ============================================================================
// MULTICALL SERVICE CLASS
// ============================================================================

export class MulticallService {
    private multicallContract: Contract;
    private pendingCalls: Call[] = [];
    private batchTimeout: NodeJS.Timeout | null = null;
    private batchResolvers: Array<{
        resolve: (result: CallResult) => void;
        reject: (error: Error) => void;
    }> = [];

    // Configurações
    private maxBatchSize: number = 100;
    private batchDelayMs: number = 50;
    private autoBatchEnabled: boolean = true;

    constructor(
        private provider: JsonRpcProvider,
        options: {
            maxBatchSize?: number;
            batchDelayMs?: number;
            autoBatch?: boolean;
        } = {}
    ) {
        this.multicallContract = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
        this.maxBatchSize = options.maxBatchSize || 100;
        this.batchDelayMs = options.batchDelayMs || 50;
        this.autoBatchEnabled = options.autoBatch ?? true;
    }

    // ========================================================================
    // IMMEDIATE MULTICALL
    // ========================================================================

    /**
     * Executa múltiplas chamadas imediatamente em um único RPC call
     * ECONOMIA: N chamadas = 1 CU
     */
    async aggregate(calls: Call[]): Promise<CallResult[]> {
        if (calls.length === 0) return [];

        // Divide em batches se necessário
        if (calls.length > this.maxBatchSize) {
            const results: CallResult[] = [];
            for (let i = 0; i < calls.length; i += this.maxBatchSize) {
                const batch = calls.slice(i, i + this.maxBatchSize);
                const batchResults = await this.executeBatch(batch);
                results.push(...batchResults);
            }
            return results;
        }

        return this.executeBatch(calls);
    }

    /**
     * Executa um batch de chamadas
     */
    private async executeBatch(calls: Call[]): Promise<CallResult[]> {
        try {
            const formattedCalls = calls.map(call => ({
                target: call.target,
                allowFailure: call.allowFailure ?? true,
                callData: call.callData
            }));

            const results = await this.multicallContract.aggregate3(formattedCalls);

            return results.map((r: any) => ({
                success: r.success,
                returnData: r.returnData
            }));
        } catch (error) {
            logger.error('Multicall failed:', error);
            // Retorna falha para todas as chamadas
            return calls.map(() => ({
                success: false,
                returnData: '0x'
            }));
        }
    }

    // ========================================================================
    // AUTO-BATCHING
    // ========================================================================

    /**
     * Adiciona chamada ao batch (será executada após delay)
     * Útil para agrupar chamadas que acontecem em rápida sucessão
     */
    queueCall(call: Call): Promise<CallResult> {
        return new Promise((resolve, reject) => {
            this.pendingCalls.push(call);
            this.batchResolvers.push({ resolve, reject });

            // Executa batch se atingiu tamanho máximo
            if (this.pendingCalls.length >= this.maxBatchSize) {
                this.flushBatch();
            } else if (!this.batchTimeout) {
                // Agenda execução do batch
                this.batchTimeout = setTimeout(() => {
                    this.flushBatch();
                }, this.batchDelayMs);
            }
        });
    }

    /**
     * Executa batch pendente imediatamente
     */
    async flushBatch(): Promise<void> {
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
            this.batchTimeout = null;
        }

        if (this.pendingCalls.length === 0) return;

        const calls = [...this.pendingCalls];
        const resolvers = [...this.batchResolvers];

        this.pendingCalls = [];
        this.batchResolvers = [];

        try {
            const results = await this.aggregate(calls);

            results.forEach((result: CallResult, index: number) => {
                resolvers[index].resolve(result);
            });
        } catch (error) {
            resolvers.forEach(r => r.reject(error as Error));
        }
    }

    // ========================================================================
    // HELPER METHODS - AAVE SPECIFIC
    // ========================================================================

    /**
     * Busca health factors de múltiplos usuários em uma chamada
     * ECONOMIA: 100 usuários = 1 CU (ao invés de 100 CUs)
     */
    async getMultipleHealthFactors(
        poolAddress: string,
        userAddresses: string[]
    ): Promise<Map<string, bigint>> {
        const iface = new Interface([
            'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'
        ]);

        const calls: Call[] = userAddresses.map(address => ({
            target: poolAddress,
            callData: iface.encodeFunctionData('getUserAccountData', [address]),
            allowFailure: true
        }));

        const results = await this.aggregate(calls);
        const healthFactors = new Map<string, bigint>();

        results.forEach((result: CallResult, index: number) => {
            if (result.success && result.returnData !== '0x') {
                try {
                    const decoded = iface.decodeFunctionResult('getUserAccountData', result.returnData);
                    healthFactors.set(
                        userAddresses[index].toLowerCase(),
                        decoded.healthFactor
                    );
                } catch {
                    // Ignora erros de decode
                }
            }
        });

        return healthFactors;
    }

    /**
     * Busca preços de múltiplos tokens em uma chamada
     */
    async getMultiplePrices(
        oracleAddress: string,
        tokenAddresses: string[]
    ): Promise<Map<string, bigint>> {
        const iface = new Interface([
            'function getAssetPrice(address asset) view returns (uint256)'
        ]);

        const calls: Call[] = tokenAddresses.map(address => ({
            target: oracleAddress,
            callData: iface.encodeFunctionData('getAssetPrice', [address]),
            allowFailure: true
        }));

        const results = await this.aggregate(calls);
        const prices = new Map<string, bigint>();

        results.forEach((result: CallResult, index: number) => {
            if (result.success && result.returnData !== '0x') {
                try {
                    const decoded = iface.decodeFunctionResult('getAssetPrice', result.returnData);
                    prices.set(tokenAddresses[index].toLowerCase(), decoded[0]);
                } catch {
                    // Ignora erros de decode
                }
            }
        });

        return prices;
    }

    /**
     * Busca balances de múltiplos tokens para um usuário
     */
    async getMultipleBalances(
        userAddress: string,
        tokenAddresses: string[]
    ): Promise<Map<string, bigint>> {
        const iface = new Interface([
            'function balanceOf(address account) view returns (uint256)'
        ]);

        const calls: Call[] = tokenAddresses.map(token => ({
            target: token,
            callData: iface.encodeFunctionData('balanceOf', [userAddress]),
            allowFailure: true
        }));

        const results = await this.aggregate(calls);
        const balances = new Map<string, bigint>();

        results.forEach((result: CallResult, index: number) => {
            if (result.success && result.returnData !== '0x') {
                try {
                    const decoded = iface.decodeFunctionResult('balanceOf', result.returnData);
                    balances.set(tokenAddresses[index].toLowerCase(), decoded[0]);
                } catch {
                    // Ignora erros de decode
                }
            }
        });

        return balances;
    }

    /**
     * Verifica se múltiplos usuários podem ser liquidados
     */
    async checkMultipleLiquidatable(
        poolAddress: string,
        userAddresses: string[]
    ): Promise<Map<string, boolean>> {
        const healthFactors = await this.getMultipleHealthFactors(poolAddress, userAddresses);
        const liquidatable = new Map<string, boolean>();

        for (const [address, hf] of healthFactors) {
            // HF < 1e18 significa liquidável
            liquidatable.set(address, hf < BigInt('1000000000000000000'));
        }

        return liquidatable;
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    /**
     * Atualiza provider
     */
    setProvider(provider: JsonRpcProvider): void {
        this.provider = provider;
        this.multicallContract = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
    }

    /**
     * Retorna estatísticas
     */
    getStats(): { pendingCalls: number; maxBatchSize: number } {
        return {
            pendingCalls: this.pendingCalls.length,
            maxBatchSize: this.maxBatchSize
        };
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createMulticallService(
    provider: JsonRpcProvider,
    options?: {
        maxBatchSize?: number;
        batchDelayMs?: number;
        autoBatch?: boolean;
    }
): MulticallService {
    return new MulticallService(provider, options);
}
