/**
 * WebSocket Manager - Conexão nativa para eventos em tempo real
 * Suporta múltiplos providers com failover automático
 */

import { WebSocketProvider, Contract, JsonRpcProvider } from 'ethers';
import { logger } from './logger';

interface WssEndpoint {
    name: string;
    url: string;
    priority: number;
    isHealthy: boolean;
    reconnectAttempts: number;
    lastError?: string;
}

interface EventCallback {
    event: string;
    callback: (...args: any[]) => void;
}

const DEFAULT_WSS_ENDPOINTS: { name: string; url: string; priority: number }[] = [
    // Nó local só é adicionado se USE_LOCAL_NODE=true
    ...(process.env.USE_LOCAL_NODE === 'true' ? [{
        name: 'Local Node',
        url: process.env.LOCAL_NODE_WSS_URL || 'ws://localhost:8548',
        priority: 0,
    }] : []),
    {
        name: 'Alchemy',
        url: process.env.ARBITRUM_WSS_URL || '',
        priority: 1,
    },
    {
        name: 'PublicNode',
        url: 'wss://arbitrum-one-rpc.publicnode.com',
        priority: 2,
    },
    {
        name: 'DRPC',
        url: 'wss://arbitrum.drpc.org',
        priority: 3,
    },
];

export class WebSocketManager {
    private endpoints: WssEndpoint[] = [];
    private currentProvider: WebSocketProvider | null = null;
    private currentEndpoint: WssEndpoint | null = null;
    private contracts: Map<string, Contract> = new Map();
    private eventCallbacks: Map<string, EventCallback[]> = new Map();
    private reconnectInterval: NodeJS.Timeout | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;

    private readonly MAX_RECONNECT_ATTEMPTS = 5;
    private readonly RECONNECT_DELAY = 5000; // 5 seconds
    private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds

    constructor(customEndpoints?: { name: string; url: string; priority: number }[]) {
        const endpoints = customEndpoints || DEFAULT_WSS_ENDPOINTS;

        this.endpoints = endpoints
            .filter(ep => ep.url && !ep.url.includes('[api-key]'))
            .map(ep => ({
                ...ep,
                isHealthy: false,
                reconnectAttempts: 0,
            }));

        // Ordena por prioridade (menor = melhor)
        this.endpoints.sort((a, b) => a.priority - b.priority);

        logger.info(`WebSocketManager initialized with ${this.endpoints.length} endpoints`);
    }

    async connect(): Promise<WebSocketProvider | null> {
        logger.info('Connecting to WebSocket...');

        for (const endpoint of this.endpoints) {
            try {
                logger.info(`Trying WebSocket: ${endpoint.name}...`);

                // Validar URL antes de tentar conectar
                if (!endpoint.url || endpoint.url.length < 10) {
                    logger.warn(`Skipping invalid WebSocket URL: ${endpoint.name}`);
                    continue;
                }

                const provider = new WebSocketProvider(endpoint.url, 42161);

                // Testa conexão com timeout
                await Promise.race([
                    provider.getBlockNumber(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Timeout')), 10000)
                    ),
                ]);

                endpoint.isHealthy = true;
                endpoint.reconnectAttempts = 0;
                this.currentProvider = provider;
                this.currentEndpoint = endpoint;

                // Setup event handlers
                this.setupProviderEvents(provider, endpoint);

                logger.info(`✅ WebSocket connected: ${endpoint.name}`);

                // Start heartbeat
                this.startHeartbeat();
                this.isRunning = true;

                return provider;

            } catch (error: any) {
                endpoint.isHealthy = false;
                endpoint.lastError = String(error);
                // Log mais curto para erros de conexão esperados
                if (error?.code === 'ECONNREFUSED') {
                    logger.warn(`WebSocket ${endpoint.name}: Connection refused`);
                } else {
                    logger.warn(`WebSocket ${endpoint.name} failed: ${error?.message || error}`);
                }
            }
        }

        logger.warn('All WebSocket endpoints failed, continuing without WebSocket');
        return null;
    }

    private setupProviderEvents(provider: WebSocketProvider, endpoint: WssEndpoint): void {
        // Usar eventos do provider ao invés do websocket interno
        provider.on('error', (error: any) => {
            logger.error(`WebSocket error on ${endpoint.name}: ${error}`);
            endpoint.isHealthy = false;
            this.handleDisconnect();
        });

        // Monitorar desconexão via polling
        const checkConnection = setInterval(async () => {
            if (!this.isRunning) {
                clearInterval(checkConnection);
                return;
            }
            try {
                await Promise.race([
                    provider.getBlockNumber(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                ]);
            } catch {
                logger.warn(`WebSocket connection lost: ${endpoint.name}`);
                endpoint.isHealthy = false;
                clearInterval(checkConnection);
                this.handleDisconnect();
            }
        }, 30000);
    }

    private async handleDisconnect(): Promise<void> {
        if (!this.isRunning) return;

        // Tenta reconectar
        if (this.currentEndpoint) {
            this.currentEndpoint.reconnectAttempts++;

            if (this.currentEndpoint.reconnectAttempts <= this.MAX_RECONNECT_ATTEMPTS) {
                logger.info(`Reconnecting in ${this.RECONNECT_DELAY / 1000}s (attempt ${this.currentEndpoint.reconnectAttempts})...`);

                await new Promise(r => setTimeout(r, this.RECONNECT_DELAY));

                // Tenta reconectar ao mesmo endpoint
                try {
                    const provider = new WebSocketProvider(this.currentEndpoint.url, 42161);
                    await provider.getBlockNumber();

                    this.currentProvider = provider;
                    this.currentEndpoint.isHealthy = true;
                    this.setupProviderEvents(provider, this.currentEndpoint);

                    // Reconfigura os listeners de eventos
                    await this.reattachEventListeners();

                    logger.info(`✅ Reconnected to ${this.currentEndpoint.name}`);
                    return;

                } catch (error) {
                    logger.warn(`Reconnect failed: ${error}`);
                }
            }
        }

        // Tenta próximo endpoint
        logger.info('Trying fallback WebSocket endpoint...');
        await this.connect();
        await this.reattachEventListeners();
    }

    private async reattachEventListeners(): Promise<void> {
        if (!this.currentProvider) return;

        for (const [contractAddress, callbacks] of this.eventCallbacks) {
            const contract = this.contracts.get(contractAddress);
            if (contract) {
                const newContract = new Contract(
                    contractAddress,
                    contract.interface,
                    this.currentProvider
                );
                this.contracts.set(contractAddress, newContract);

                for (const { event, callback } of callbacks) {
                    newContract.on(event, callback);
                }
            }
        }
    }

    private startHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        this.heartbeatInterval = setInterval(async () => {
            if (!this.currentProvider || !this.isRunning) return;

            try {
                await Promise.race([
                    this.currentProvider.getBlockNumber(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Heartbeat timeout')), 10000)
                    ),
                ]);
            } catch (error) {
                logger.warn('WebSocket heartbeat failed, reconnecting...');
                this.handleDisconnect();
            }
        }, this.HEARTBEAT_INTERVAL);
    }

    async subscribeToContract(
        contractAddress: string,
        abi: string[],
        events: { event: string; callback: (...args: any[]) => void }[]
    ): Promise<Contract | null> {
        if (!this.currentProvider) {
            logger.error('WebSocket not connected');
            return null;
        }

        const contract = new Contract(contractAddress, abi, this.currentProvider);
        this.contracts.set(contractAddress, contract);

        const callbacks: EventCallback[] = [];

        for (const { event, callback } of events) {
            contract.on(event, callback);
            callbacks.push({ event, callback });
            logger.info(`📡 Subscribed to ${event} on ${contractAddress.slice(0, 10)}...`);
        }

        this.eventCallbacks.set(contractAddress, callbacks);

        return contract;
    }

    async subscribeToBlocks(callback: (blockNumber: number) => void): Promise<void> {
        if (!this.currentProvider) {
            logger.error('WebSocket not connected');
            return;
        }

        this.currentProvider.on('block', callback);
        logger.info('📡 Subscribed to new blocks');
    }

    async subscribeToPendingTransactions(callback: (txHash: string) => void): Promise<void> {
        if (!this.currentProvider) {
            logger.error('WebSocket not connected');
            return;
        }

        this.currentProvider.on('pending', callback);
        logger.info('📡 Subscribed to pending transactions');
    }

    getProvider(): WebSocketProvider | null {
        return this.currentProvider;
    }

    getCurrentEndpoint(): string {
        return this.currentEndpoint?.name || 'None';
    }

    isConnected(): boolean {
        return this.currentProvider !== null && this.currentEndpoint?.isHealthy === true;
    }

    getStatus(): { name: string; healthy: boolean; attempts: number }[] {
        return this.endpoints.map(ep => ({
            name: ep.name,
            healthy: ep.isHealthy,
            attempts: ep.reconnectAttempts,
        }));
    }

    async stop(): Promise<void> {
        logger.info('Stopping WebSocket manager...');
        this.isRunning = false;

        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
        }

        // Remove all listeners
        for (const contract of this.contracts.values()) {
            contract.removeAllListeners();
        }
        this.contracts.clear();
        this.eventCallbacks.clear();

        if (this.currentProvider) {
            await this.currentProvider.destroy().catch(() => {});
            this.currentProvider = null;
        }

        logger.info('WebSocket manager stopped');
    }
}

// Singleton instance
let wssManagerInstance: WebSocketManager | null = null;

export function getWebSocketManager(): WebSocketManager {
    if (!wssManagerInstance) {
        wssManagerInstance = new WebSocketManager();
    }
    return wssManagerInstance;
}

export async function initWebSocket(): Promise<WebSocketProvider | null> {
    const manager = getWebSocketManager();
    return await manager.connect();
}
