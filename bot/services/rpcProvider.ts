import { ethers, JsonRpcProvider, WebSocketProvider } from 'ethers';
import { logger } from './logger';

interface RpcEndpoint {
    name: string;
    url: string;
    wssUrl?: string;
    priority: number; // 1 = highest priority
    isHealthy: boolean;
    latency: number; // ms
    lastCheck: number;
    errorCount: number;
}

interface RpcConfig {
    name: string;
    url: string;
    wssUrl?: string;
    priority: number;
}

const DEFAULT_RPCS: RpcConfig[] = [
    {
        name: 'Alchemy',
        url: process.env.ARBITRUM_RPC_URL || '',
        wssUrl: process.env.ARBITRUM_WSS_URL,
        priority: 1,
    },
    {
        name: 'PublicNode',
        url: 'https://arbitrum-one-rpc.publicnode.com',
        wssUrl: 'wss://arbitrum-one-rpc.publicnode.com',
        priority: 2,
    },
    {
        name: '1RPC',
        url: 'https://1rpc.io/arb',
        priority: 3,
    },
    {
        name: 'DRPC',
        url: 'https://arbitrum.drpc.org',
        wssUrl: 'wss://arbitrum.drpc.org',
        priority: 4,
    },
    {
        name: 'MeowRPC',
        url: 'https://arbitrum.meowrpc.com',
        priority: 5,
    },
    {
        name: 'Arbitrum Official',
        url: 'https://arb1.arbitrum.io/rpc',
        priority: 6,
    },
];

export class MultiRpcProvider {
    private endpoints: RpcEndpoint[] = [];
    private currentProvider: JsonRpcProvider | null = null;
    private currentWssProvider: WebSocketProvider | null = null;
    private currentEndpoint: RpcEndpoint | null = null;
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private readonly MAX_ERRORS = 3;
    private readonly HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

    constructor(customRpcs?: RpcConfig[]) {
        const rpcs = customRpcs || DEFAULT_RPCS.filter(r => r.url);

        this.endpoints = rpcs.map(rpc => ({
            ...rpc,
            isHealthy: true,
            latency: 9999,
            lastCheck: 0,
            errorCount: 0,
        }));

        logger.info(`MultiRPC initialized with ${this.endpoints.length} endpoints`);
    }

    async initialize(): Promise<JsonRpcProvider> {
        logger.info('Testing RPC endpoints...');

        // Test all endpoints in parallel
        await Promise.all(this.endpoints.map(endpoint => this.testEndpoint(endpoint)));

        // Sort by latency (fastest first), then by priority
        this.endpoints.sort((a, b) => {
            if (!a.isHealthy && b.isHealthy) return 1;
            if (a.isHealthy && !b.isHealthy) return -1;
            if (a.latency !== b.latency) return a.latency - b.latency;
            return a.priority - b.priority;
        });

        // Log results
        logger.info('RPC Endpoints Status:');
        this.endpoints.forEach((ep, i) => {
            const status = ep.isHealthy ? '✅' : '❌';
            const latency = ep.isHealthy ? `${ep.latency}ms` : 'N/A';
            logger.info(`  ${i + 1}. ${ep.name}: ${status} ${latency}`);
        });

        // Select best endpoint
        const bestEndpoint = this.endpoints.find(ep => ep.isHealthy);
        if (!bestEndpoint) {
            throw new Error('No healthy RPC endpoints available');
        }

        await this.switchToEndpoint(bestEndpoint);

        // Start health monitoring
        this.startHealthMonitoring();

        return this.currentProvider!;
    }

    private async testEndpoint(endpoint: RpcEndpoint): Promise<void> {
        const startTime = Date.now();

        try {
            // Usa staticNetwork para evitar detecção automática de rede (causa erros no console)
            const provider = new JsonRpcProvider(endpoint.url, 42161, { staticNetwork: true });

            // Test with timeout
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 5000)
            );

            await Promise.race([
                provider.getBlockNumber(),
                timeoutPromise
            ]);

            endpoint.latency = Date.now() - startTime;
            endpoint.isHealthy = true;
            endpoint.errorCount = 0;
            endpoint.lastCheck = Date.now();

        } catch (error) {
            endpoint.isHealthy = false;
            endpoint.latency = 9999;
            endpoint.errorCount++;
            endpoint.lastCheck = Date.now();
            // Silencioso - não loga erro para cada RPC que falha no teste
        }
    }

    private async switchToEndpoint(endpoint: RpcEndpoint): Promise<void> {
        logger.info(`Switching to RPC: ${endpoint.name} (${endpoint.latency}ms)`);

        // Close existing connections
        if (this.currentWssProvider) {
            await this.currentWssProvider.destroy().catch(() => {});
        }

        // Create new provider com staticNetwork para evitar erros de detecção
        this.currentProvider = new JsonRpcProvider(endpoint.url, 42161, { staticNetwork: true });
        this.currentEndpoint = endpoint;

        // WebSocket desabilitado - causa muitos erros com RPCs públicos
        // Setup WebSocket if available
        // if (endpoint.wssUrl) {
        //     try {
        //         this.currentWssProvider = new WebSocketProvider(endpoint.wssUrl);
        //         logger.info(`WebSocket connected: ${endpoint.name}`);
        //     } catch (error) {
        //         logger.warn(`WebSocket failed for ${endpoint.name}: ${error}`);
        //         this.currentWssProvider = null;
        //     }
        // }
    }

    private startHealthMonitoring(): void {
        this.healthCheckInterval = setInterval(async () => {
            // Test all endpoints
            await Promise.all(this.endpoints.map(ep => this.testEndpoint(ep)));

            // Check if current endpoint is still the best
            const healthyEndpoints = this.endpoints
                .filter(ep => ep.isHealthy)
                .sort((a, b) => a.latency - b.latency);

            if (healthyEndpoints.length === 0) {
                logger.error('All RPC endpoints are down!');
                return;
            }

            const bestEndpoint = healthyEndpoints[0];

            // Switch if current is unhealthy or significantly slower
            if (
                !this.currentEndpoint?.isHealthy ||
                (bestEndpoint.latency < this.currentEndpoint.latency - 50)
            ) {
                await this.switchToEndpoint(bestEndpoint);
            }

        }, this.HEALTH_CHECK_INTERVAL);
    }

    async executeWithFailover<T>(
        operation: (provider: JsonRpcProvider) => Promise<T>
    ): Promise<T> {
        const maxRetries = Math.min(3, this.endpoints.filter(ep => ep.isHealthy).length);

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await operation(this.currentProvider!);
            } catch (error) {
                logger.warn(`RPC call failed on ${this.currentEndpoint?.name}: ${error}`);

                this.currentEndpoint!.errorCount++;

                if (this.currentEndpoint!.errorCount >= this.MAX_ERRORS) {
                    this.currentEndpoint!.isHealthy = false;
                    logger.warn(`Marking ${this.currentEndpoint?.name} as unhealthy`);
                }

                // Find next healthy endpoint
                const nextEndpoint = this.endpoints.find(
                    ep => ep.isHealthy && ep !== this.currentEndpoint
                );

                if (nextEndpoint) {
                    await this.switchToEndpoint(nextEndpoint);
                } else if (attempt === maxRetries - 1) {
                    throw error;
                }
            }
        }

        throw new Error('All RPC attempts failed');
    }

    getProvider(): JsonRpcProvider {
        if (!this.currentProvider) {
            throw new Error('Provider not initialized. Call initialize() first.');
        }
        return this.currentProvider;
    }

    getWssProvider(): WebSocketProvider | null {
        return this.currentWssProvider;
    }

    getCurrentEndpoint(): string {
        return this.currentEndpoint?.name || 'None';
    }

    getStatus(): { name: string; healthy: boolean; latency: number }[] {
        return this.endpoints.map(ep => ({
            name: ep.name,
            healthy: ep.isHealthy,
            latency: ep.latency,
        }));
    }

    async stop(): Promise<void> {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        if (this.currentWssProvider) {
            await this.currentWssProvider.destroy().catch(() => {});
        }
    }
}

// Singleton instance
let multiRpcInstance: MultiRpcProvider | null = null;

export async function getMultiRpcProvider(): Promise<MultiRpcProvider> {
    if (!multiRpcInstance) {
        multiRpcInstance = new MultiRpcProvider();
        await multiRpcInstance.initialize();
    }
    return multiRpcInstance;
}

export async function getProvider(): Promise<JsonRpcProvider> {
    const multiRpc = await getMultiRpcProvider();
    return multiRpc.getProvider();
}
