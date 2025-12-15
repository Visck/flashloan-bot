/**
 * ============================================================================
 * SERVIÇO WEBSOCKET - MONITORAMENTO EM TEMPO REAL
 * ============================================================================
 *
 * Serviço para conectar via WebSocket e receber atualizações de blocos
 * em tempo real, eliminando a necessidade de polling.
 *
 * Vantagens do WebSocket:
 * - Latência muito menor (~100ms vs ~2000ms do polling)
 * - Notificação instantânea de novos blocos
 * - Menos requests = menos chance de rate limit
 */

import { WebSocketProvider, JsonRpcProvider, Contract, formatUnits } from 'ethers';
import { EventEmitter } from 'events';
import { logger } from './logger';
import { RPC_ENDPOINTS } from './configV2';

// ============================================================================
// TIPOS
// ============================================================================

export interface BlockData {
    number: number;
    timestamp: number;
    baseFeePerGas: bigint | null;
    gasUsed: bigint;
    gasLimit: bigint;
}

export interface PendingTx {
    hash: string;
    from: string;
    to: string;
    value: bigint;
    gasPrice: bigint;
    data: string;
}

// ============================================================================
// CLASSE PRINCIPAL
// ============================================================================

export class WebSocketService extends EventEmitter {
    private wsProvider: WebSocketProvider | null = null;
    private httpProvider: JsonRpcProvider;
    private isConnected: boolean = false;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 10;
    private reconnectDelay: number = 1000;
    private wsUrl: string;

    constructor(httpProvider: JsonRpcProvider) {
        super();
        this.httpProvider = httpProvider;
        this.wsUrl = RPC_ENDPOINTS.websocket;
    }

    /**
     * Conecta ao WebSocket
     */
    async connect(): Promise<boolean> {
        if (!this.wsUrl || this.wsUrl.includes('undefined')) {
            logger.warn('WebSocket URL não configurada, usando polling');
            return false;
        }

        try {
            logger.info(`Conectando ao WebSocket: ${this.wsUrl.substring(0, 50)}...`);

            this.wsProvider = new WebSocketProvider(this.wsUrl);

            // Aguarda conexão
            await this.wsProvider.ready;

            this.isConnected = true;
            this.reconnectAttempts = 0;

            // Configura listeners
            this.setupEventListeners();

            logger.info('WebSocket conectado com sucesso!');
            this.emit('connected');

            return true;
        } catch (error) {
            logger.error('Erro ao conectar WebSocket:', error);
            this.scheduleReconnect();
            return false;
        }
    }

    /**
     * Configura os listeners de eventos
     */
    private setupEventListeners(): void {
        if (!this.wsProvider) return;

        // Listener de novos blocos - com tratamento de erro
        try {
            this.wsProvider.on('block', async (blockNumber: number) => {
                try {
                    const block = await this.wsProvider!.getBlock(blockNumber);
                    if (block) {
                        const blockData: BlockData = {
                            number: block.number,
                            timestamp: block.timestamp,
                            baseFeePerGas: block.baseFeePerGas,
                            gasUsed: block.gasUsed,
                            gasLimit: block.gasLimit,
                        };

                        logger.debug(`Novo bloco via WebSocket: ${blockNumber}`);
                        this.emit('newBlock', blockData);
                    }
                } catch (error) {
                    logger.error('Erro ao processar bloco:', error);
                }
            });
        } catch (error: any) {
            // Captura erros de subscription (rate limit, etc)
            logger.error('Erro ao subscrever blocos:', error.message);
            this.emit('subscriptionError', error);
            this.handleDisconnect();
            return;
        }

        // Listener de erro
        this.wsProvider.on('error', (error: any) => {
            // Verifica se é rate limit
            if (error.message?.includes('Too Many Requests') || error.code === -32005) {
                logger.warn('Rate limit do WebSocket detectado');
                this.emit('rateLimited');
            } else {
                logger.error('Erro no WebSocket:', error);
            }
            this.handleDisconnect();
        });

        // Listener de desconexão
        try {
            const ws = (this.wsProvider as any).websocket;
            if (ws && ws.on) {
                ws.on('close', () => {
                    logger.warn('WebSocket desconectado');
                    this.handleDisconnect();
                });
            }
        } catch (e) {
            // WebSocket pode não estar acessível
        }
    }

    /**
     * Monitora transações pendentes (mempool) - AVANÇADO
     * Nota: Nem todos os provedores suportam isso
     */
    async subscribeToMempool(): Promise<boolean> {
        if (!this.wsProvider || !this.isConnected) {
            logger.warn('WebSocket não conectado para monitorar mempool');
            return false;
        }

        try {
            // Subscreve a transações pendentes
            this.wsProvider.on('pending', async (txHash: string) => {
                try {
                    const tx = await this.wsProvider!.getTransaction(txHash);
                    if (tx && this.isRelevantTransaction(tx)) {
                        const pendingTx: PendingTx = {
                            hash: tx.hash,
                            from: tx.from,
                            to: tx.to || '',
                            value: tx.value,
                            gasPrice: tx.gasPrice || 0n,
                            data: tx.data,
                        };
                        this.emit('pendingTx', pendingTx);
                    }
                } catch (error) {
                    // Transação pode já ter sido minerada
                }
            });

            logger.info('Monitoramento de mempool ativado');
            return true;
        } catch (error) {
            logger.warn('Provedor não suporta monitoramento de mempool');
            return false;
        }
    }

    /**
     * Verifica se uma transação é relevante (swap em DEX)
     */
    private isRelevantTransaction(tx: any): boolean {
        if (!tx.to) return false;

        // Endereços dos routers das DEXs
        const dexRouters = [
            '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3
            '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap
            '0xc873fEcbd354f5A56E00E710B90EF4201db2448d', // Camelot
        ];

        return dexRouters.includes(tx.to.toLowerCase()) ||
               dexRouters.includes(tx.to);
    }

    /**
     * Lida com desconexão
     */
    private handleDisconnect(): void {
        this.isConnected = false;
        this.emit('disconnected');
        this.scheduleReconnect();
    }

    /**
     * Agenda reconexão
     */
    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.error('Máximo de tentativas de reconexão atingido');
            this.emit('maxReconnectAttempts');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        logger.info(`Reconectando em ${delay}ms (tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
            this.connect();
        }, delay);
    }

    /**
     * Desconecta do WebSocket
     */
    async disconnect(): Promise<void> {
        if (this.wsProvider) {
            this.wsProvider.removeAllListeners();
            await this.wsProvider.destroy();
            this.wsProvider = null;
        }
        this.isConnected = false;
        logger.info('WebSocket desconectado');
    }

    /**
     * Retorna status da conexão
     */
    getStatus(): { connected: boolean; reconnectAttempts: number } {
        return {
            connected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts,
        };
    }

    /**
     * Retorna o provider WebSocket (se conectado)
     */
    getProvider(): WebSocketProvider | null {
        return this.isConnected ? this.wsProvider : null;
    }
}

// ============================================================================
// SERVIÇO DE MÚLTIPLOS RPCs COM FAILOVER
// ============================================================================

export class MultiRpcService {
    private providers: JsonRpcProvider[] = [];
    private currentIndex: number = 0;
    private healthStatus: Map<number, boolean> = new Map();

    constructor() {
        this.initializeProviders();
    }

    /**
     * Inicializa todos os providers
     */
    private initializeProviders(): void {
        // Provider principal
        this.providers.push(new JsonRpcProvider(RPC_ENDPOINTS.primary));
        this.healthStatus.set(0, true);

        // Providers de backup
        RPC_ENDPOINTS.backups.forEach((url, index) => {
            this.providers.push(new JsonRpcProvider(url));
            this.healthStatus.set(index + 1, true);
        });

        logger.info(`Inicializados ${this.providers.length} providers RPC`);
    }

    /**
     * Retorna o próximo provider saudável
     */
    getProvider(): JsonRpcProvider {
        // Tenta encontrar um provider saudável
        for (let i = 0; i < this.providers.length; i++) {
            const index = (this.currentIndex + i) % this.providers.length;
            if (this.healthStatus.get(index)) {
                return this.providers[index];
            }
        }

        // Se nenhum está marcado como saudável, tenta o principal
        logger.warn('Nenhum provider saudável, usando principal');
        return this.providers[0];
    }

    /**
     * Marca um provider como não saudável
     */
    markUnhealthy(provider: JsonRpcProvider): void {
        const index = this.providers.indexOf(provider);
        if (index >= 0) {
            this.healthStatus.set(index, false);
            logger.warn(`Provider ${index} marcado como não saudável`);

            // Agenda verificação de saúde
            setTimeout(() => this.checkHealth(index), 30000);
        }
    }

    /**
     * Verifica saúde de um provider
     */
    private async checkHealth(index: number): Promise<void> {
        try {
            await this.providers[index].getBlockNumber();
            this.healthStatus.set(index, true);
            logger.info(`Provider ${index} está saudável novamente`);
        } catch (error) {
            // Ainda não saudável, agenda outra verificação
            setTimeout(() => this.checkHealth(index), 30000);
        }
    }

    /**
     * Executa uma chamada com retry automático
     */
    async executeWithRetry<T>(
        operation: (provider: JsonRpcProvider) => Promise<T>,
        maxRetries: number = 3
    ): Promise<T> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            // Rotaciona RPC a cada tentativa para distribuir carga
            this.rotateProvider();
            const provider = this.getProvider();

            try {
                const result = await operation(provider);
                return result;
            } catch (error: any) {
                lastError = error;

                // Detecta rate limit (código 429 ou mensagens específicas)
                const isRateLimit =
                    error.code === 429 ||
                    error.status === 429 ||
                    error.message?.includes('429') ||
                    error.message?.includes('Too Many Requests') ||
                    error.message?.includes('rate limit') ||
                    error.message?.includes('exceeded') ||
                    error.message?.includes('compute units') ||
                    error.code === 'TIMEOUT' ||
                    error.code === 'NETWORK_ERROR';

                if (isRateLimit) {
                    this.markUnhealthy(provider);
                }

                // Silencia CALL_EXCEPTION (pool não existe) - é esperado
                if (!error.message?.includes('CALL_EXCEPTION')) {
                    logger.warn(`Tentativa ${attempt + 1}/${maxRetries} falhou: ${error.message?.substring(0, 80)}`);
                }

                // Delay antes da próxima tentativa para evitar rate limit
                await this.delay(500 * (attempt + 1));
            }
        }

        throw lastError || new Error('Todas as tentativas falharam');
    }

    /**
     * Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Rotaciona para o próximo provider
     */
    private rotateProvider(): void {
        this.currentIndex = (this.currentIndex + 1) % this.providers.length;
    }

    /**
     * Retorna status de todos os providers
     */
    getStatus(): { total: number; healthy: number; current: number } {
        const healthy = Array.from(this.healthStatus.values()).filter(Boolean).length;
        return {
            total: this.providers.length,
            healthy,
            current: this.currentIndex,
        };
    }
}

export default WebSocketService;
