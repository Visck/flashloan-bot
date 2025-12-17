/**
 * ============================================================================
 * REALTIME MONITOR - WebSocket Otimizado para Liquidações
 * ============================================================================
 *
 * Monitor em tempo real que:
 * - Usa WebSocket para receber novos blocos instantaneamente
 * - Monitora eventos de mudança de preço
 * - Detecta oportunidades de liquidação em tempo real
 * - Auto-reconecta com backoff exponencial
 */

import { WebSocketProvider, JsonRpcProvider, Contract } from 'ethers';
import { logger } from '../logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface MonitorConfig {
    wssUrl: string;
    httpUrl: string;
    reconnectDelayMs: number;
    maxReconnectAttempts: number;
    heartbeatIntervalMs: number;
    blockProcessingTimeoutMs: number;
}

export interface MonitorStats {
    isConnected: boolean;
    lastBlock: number;
    blocksProcessed: number;
    reconnectAttempts: number;
    uptime: number;
    avgBlockProcessingMs: number;
}

type BlockHandler = (blockNumber: number, timestamp: number) => void | Promise<void>;
type EventHandler = (event: any) => void | Promise<void>;

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: MonitorConfig = {
    wssUrl: '',
    httpUrl: '',
    reconnectDelayMs: 1000,
    maxReconnectAttempts: 50,
    heartbeatIntervalMs: 30000,
    blockProcessingTimeoutMs: 5000
};

// ============================================================================
// REALTIME MONITOR CLASS
// ============================================================================

export class RealtimeMonitor {
    private wsProvider: WebSocketProvider | null = null;
    private httpProvider: JsonRpcProvider | null = null;
    private isConnected: boolean = false;
    private reconnectAttempts: number = 0;
    private blockHandlers: BlockHandler[] = [];
    private eventHandlers: Map<string, EventHandler[]> = new Map();
    private lastBlockNumber: number = 0;
    private blocksProcessed: number = 0;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private config: MonitorConfig;
    private startTime: Date = new Date();
    private blockProcessingTimes: number[] = [];
    private isProcessingBlock: boolean = false;

    constructor(config: Partial<MonitorConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ========================================================================
    // CONNECTION MANAGEMENT
    // ========================================================================

    /**
     * Conecta ao WebSocket
     */
    async connect(): Promise<void> {
        if (!this.config.wssUrl) {
            logger.warn('WebSocket URL not configured, using HTTP polling');
            await this.startHttpPolling();
            return;
        }

        try {
            logger.info('Connecting to WebSocket...');

            this.wsProvider = new WebSocketProvider(this.config.wssUrl);

            // Espera conexão estar pronta
            await this.wsProvider.ready;

            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.startTime = new Date();

            // Configura listeners
            this.setupBlockListener();
            this.setupDisconnectHandler();
            this.startHeartbeat();

            const currentBlock = await this.wsProvider.getBlockNumber();
            this.lastBlockNumber = currentBlock;

            logger.info(`WebSocket connected at block ${currentBlock}`);
        } catch (error) {
            logger.error('WebSocket connection failed:', error);
            await this.reconnect();
        }
    }

    /**
     * Configura listener de novos blocos
     */
    private setupBlockListener(): void {
        if (!this.wsProvider) return;

        this.wsProvider.on('block', async (blockNumber: number) => {
            // Evita processamento duplicado
            if (blockNumber <= this.lastBlockNumber) return;
            if (this.isProcessingBlock) return;

            this.isProcessingBlock = true;
            const startTime = Date.now();

            try {
                this.lastBlockNumber = blockNumber;
                this.blocksProcessed++;

                // Obtém timestamp do bloco
                const block = await this.wsProvider?.getBlock(blockNumber);
                const timestamp = block?.timestamp || Math.floor(Date.now() / 1000);

                // Executa handlers
                await Promise.race([
                    this.executeBlockHandlers(blockNumber, timestamp),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Block processing timeout')),
                        this.config.blockProcessingTimeoutMs)
                    )
                ]);

                // Registra tempo de processamento
                const processingTime = Date.now() - startTime;
                this.blockProcessingTimes.push(processingTime);
                if (this.blockProcessingTimes.length > 100) {
                    this.blockProcessingTimes.shift();
                }

                if (blockNumber % 100 === 0) {
                    logger.debug(`Block ${blockNumber} processed in ${processingTime}ms`);
                }
            } catch (error) {
                logger.error(`Error processing block ${blockNumber}:`, error);
            } finally {
                this.isProcessingBlock = false;
            }
        });
    }

    /**
     * Executa todos os handlers de bloco
     */
    private async executeBlockHandlers(blockNumber: number, timestamp: number): Promise<void> {
        const promises = this.blockHandlers.map(async handler => {
            try {
                await handler(blockNumber, timestamp);
            } catch (error) {
                logger.error(`Block handler error at ${blockNumber}:`, error);
            }
        });

        await Promise.allSettled(promises);
    }

    /**
     * Configura handler de desconexão
     */
    private setupDisconnectHandler(): void {
        if (!this.wsProvider) return;

        // Use provider events instead of websocket directly
        this.wsProvider.on('error', (error: Error) => {
            logger.error('WebSocket error:', error);
            this.isConnected = false;
            this.reconnect();
        });

        // Monitor for connection issues
        this.wsProvider.on('debug', (info: any) => {
            if (info?.action === 'close' || info?.action === 'disconnect') {
                logger.warn('WebSocket disconnected');
                this.isConnected = false;
                this.reconnect();
            }
        });
    }

    /**
     * Reconecta com backoff exponencial
     */
    private async reconnect(): Promise<void> {
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            logger.error('Max reconnection attempts reached, falling back to HTTP');
            await this.startHttpPolling();
            return;
        }

        this.reconnectAttempts++;

        // Backoff exponencial: 1s, 2s, 4s, 8s... max 30s
        const delay = Math.min(
            this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
            30000
        );

        logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        await this.delay(delay);
        await this.connect();
    }

    // ========================================================================
    // HTTP FALLBACK
    // ========================================================================

    /**
     * Fallback para polling HTTP se WebSocket falhar
     */
    private async startHttpPolling(): Promise<void> {
        if (!this.config.httpUrl) {
            throw new Error('No HTTP URL configured for fallback');
        }

        logger.info('Starting HTTP polling fallback...');

        this.httpProvider = new JsonRpcProvider(this.config.httpUrl);
        this.isConnected = true;

        // Poll a cada 250ms (Arbitrum tem blocos de ~250ms)
        const pollInterval = setInterval(async () => {
            try {
                const blockNumber = await this.httpProvider!.getBlockNumber();

                if (blockNumber > this.lastBlockNumber) {
                    this.lastBlockNumber = blockNumber;
                    this.blocksProcessed++;

                    const block = await this.httpProvider!.getBlock(blockNumber);
                    const timestamp = block?.timestamp || Math.floor(Date.now() / 1000);

                    await this.executeBlockHandlers(blockNumber, timestamp);
                }
            } catch (error) {
                logger.error('HTTP polling error:', error);
            }
        }, 250);

        // Armazena referência para cleanup
        (this as any).pollInterval = pollInterval;
    }

    // ========================================================================
    // HEARTBEAT
    // ========================================================================

    /**
     * Inicia verificação periódica de conexão
     */
    private startHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        this.heartbeatInterval = setInterval(async () => {
            if (!this.isConnected || !this.wsProvider) return;

            try {
                const blockNumber = await this.wsProvider.getBlockNumber();

                // Verifica se estamos recebendo blocos
                if (blockNumber === this.lastBlockNumber) {
                    // Pode estar travado, verifica timestamp
                    const timeSinceLastBlock = Date.now() - (this.lastBlockNumber * 1000);
                    if (timeSinceLastBlock > 30000) {
                        logger.warn('No new blocks in 30s, reconnecting...');
                        await this.reconnect();
                    }
                }
            } catch (error) {
                logger.warn('Heartbeat failed, reconnecting...');
                this.isConnected = false;
                await this.reconnect();
            }
        }, this.config.heartbeatIntervalMs);
    }

    // ========================================================================
    // EVENT HANDLERS
    // ========================================================================

    /**
     * Registra handler para novos blocos
     */
    onNewBlock(handler: BlockHandler): void {
        this.blockHandlers.push(handler);
    }

    /**
     * Remove handler de blocos
     */
    offNewBlock(handler: BlockHandler): void {
        const index = this.blockHandlers.indexOf(handler);
        if (index > -1) {
            this.blockHandlers.splice(index, 1);
        }
    }

    /**
     * Registra handler para eventos de contrato
     */
    async onContractEvent(
        contractAddress: string,
        abi: any[],
        eventName: string,
        handler: EventHandler
    ): Promise<void> {
        const provider = this.wsProvider || this.httpProvider;
        if (!provider) return;

        const contract = new Contract(contractAddress, abi, provider);

        contract.on(eventName, (...args) => {
            handler(args);
        });

        const key = `${contractAddress}:${eventName}`;
        if (!this.eventHandlers.has(key)) {
            this.eventHandlers.set(key, []);
        }
        this.eventHandlers.get(key)!.push(handler);
    }

    // ========================================================================
    // STATUS & METRICS
    // ========================================================================

    /**
     * Retorna status atual
     */
    getStatus(): MonitorStats {
        const avgProcessing = this.blockProcessingTimes.length > 0
            ? this.blockProcessingTimes.reduce((a, b) => a + b, 0) / this.blockProcessingTimes.length
            : 0;

        return {
            isConnected: this.isConnected,
            lastBlock: this.lastBlockNumber,
            blocksProcessed: this.blocksProcessed,
            reconnectAttempts: this.reconnectAttempts,
            uptime: Date.now() - this.startTime.getTime(),
            avgBlockProcessingMs: Math.round(avgProcessing)
        };
    }

    /**
     * Verifica se está conectado
     */
    isOnline(): boolean {
        return this.isConnected;
    }

    /**
     * Retorna último bloco
     */
    getLastBlock(): number {
        return this.lastBlockNumber;
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    /**
     * Desconecta e limpa recursos
     */
    async disconnect(): Promise<void> {
        logger.info('Disconnecting realtime monitor...');

        // Para heartbeat
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }

        // Para polling HTTP se ativo
        if ((this as any).pollInterval) {
            clearInterval((this as any).pollInterval);
        }

        // Fecha WebSocket
        if (this.wsProvider) {
            this.wsProvider.removeAllListeners();
            await this.wsProvider.destroy();
            this.wsProvider = null;
        }

        // Fecha HTTP provider
        if (this.httpProvider) {
            await this.httpProvider.destroy();
            this.httpProvider = null;
        }

        this.isConnected = false;
        this.blockHandlers = [];
        this.eventHandlers.clear();

        logger.info('Realtime monitor disconnected');
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

export function createRealtimeMonitor(wssUrl?: string, httpUrl?: string): RealtimeMonitor {
    const config: Partial<MonitorConfig> = {
        wssUrl: wssUrl || process.env.ARBITRUM_WSS_PRIMARY || '',
        httpUrl: httpUrl || process.env.ARBITRUM_RPC_PRIMARY || 'https://arb1.arbitrum.io/rpc',
        reconnectDelayMs: 1000,
        maxReconnectAttempts: 50,
        heartbeatIntervalMs: 30000
    };

    return new RealtimeMonitor(config);
}
