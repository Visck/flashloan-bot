/**
 * ============================================================================
 * ARBITRUM SEQUENCER FEED - ACESSO DIRETO AO MEMPOOL
 * ============================================================================
 *
 * Conecta diretamente ao Sequencer do Arbitrum para ver transações
 * ANTES de serem incluídas em blocos (~100-500ms de vantagem)
 *
 * Documentação: https://docs.arbitrum.io/node-running/how-tos/read-sequencer-feed
 */

import WebSocket from 'ws';
import { ethers } from 'ethers';

// URLs do Sequencer Feed
const SEQUENCER_FEEDS = {
    mainnet: 'wss://arb1.arbitrum.io/feed',
    // Backups
    backups: [
        'wss://arb1.arbitrum.io/feed',
        'wss://arbitrum-one.publicnode.com',
    ]
};

// Interface para mensagens do feed
interface SequencerMessage {
    version: number;
    messages: {
        sequenceNumber: number;
        message: {
            message: {
                header: {
                    kind: number;
                    sender: string;
                    blockNumber: number;
                    timestamp: number;
                };
                l2Msg: string; // Transação codificada
            };
            delayedMessagesRead: number;
        };
        signature: string;
    }[];
}

interface PendingTransaction {
    hash: string;
    from: string;
    to: string | null;
    value: bigint;
    data: string;
    gasLimit: bigint;
    gasPrice: bigint;
    nonce: number;
    timestamp: number;
    sequenceNumber: number;
}

type TransactionCallback = (tx: PendingTransaction) => void;

export class SequencerFeed {
    private ws: WebSocket | null = null;
    private isConnected = false;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private callbacks: TransactionCallback[] = [];
    private processedSequences = new Set<number>();

    // Filtros para reduzir ruído
    private targetContracts: Set<string> = new Set();
    private minValue: bigint = 0n;

    constructor() {
        // Contratos DEX conhecidos para filtrar
        this.targetContracts = new Set([
            '0xE592427A0AEce92De3Edee1F18E0157C05861564'.toLowerCase(), // Uniswap V3 Router
            '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'.toLowerCase(), // Uniswap V3 Router 2
            '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'.toLowerCase(), // SushiSwap Router
            '0xc873fEcbd354f5A56E00E710B90EF4201db2448d'.toLowerCase(), // Camelot Router
            '0xBA12222222228d8Ba445958a75a0704d566BF2C8'.toLowerCase(), // Balancer Vault
            '0x7f90122BF0700F9E7e1F688fe926940E8839F353'.toLowerCase(), // Curve 2pool
            '0x960ea3e3C7FB317332d990873d354E18d7645590'.toLowerCase(), // Curve Tricrypto
        ]);
    }

    /**
     * Conecta ao Sequencer Feed
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                console.log('🔌 Conectando ao Arbitrum Sequencer Feed...');

                this.ws = new WebSocket(SEQUENCER_FEEDS.mainnet);

                this.ws.on('open', () => {
                    console.log('✅ Conectado ao Sequencer Feed!');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    resolve();
                });

                this.ws.on('message', (data: Buffer) => {
                    this.handleMessage(data);
                });

                this.ws.on('error', (error) => {
                    console.error('❌ Erro no Sequencer Feed:', error.message);
                    if (!this.isConnected) {
                        reject(error);
                    }
                });

                this.ws.on('close', () => {
                    console.log('🔌 Conexão com Sequencer Feed fechada');
                    this.isConnected = false;
                    this.attemptReconnect();
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Processa mensagens do sequencer
     */
    private handleMessage(data: Buffer): void {
        try {
            // O feed envia dados binários (não JSON puro)
            // Formato: Arbitrum Nitro batch format

            // Tentar parsear como JSON primeiro (alguns feeds enviam JSON)
            const str = data.toString();
            if (str.startsWith('{')) {
                const msg = JSON.parse(str) as SequencerMessage;
                this.processSequencerMessage(msg);
                return;
            }

            // Se for binário, decodificar batch
            this.processBinaryBatch(data);

        } catch (error) {
            // Silenciar erros de parsing - muitas mensagens são heartbeats
        }
    }

    /**
     * Processa mensagem JSON do sequencer
     */
    private processSequencerMessage(msg: SequencerMessage): void {
        if (!msg.messages) return;

        for (const item of msg.messages) {
            const seqNum = item.sequenceNumber;

            // Evitar processar duplicatas
            if (this.processedSequences.has(seqNum)) continue;
            this.processedSequences.add(seqNum);

            // Limpar cache antigo (manter últimos 10000)
            if (this.processedSequences.size > 10000) {
                const arr = Array.from(this.processedSequences).sort((a, b) => a - b);
                for (let i = 0; i < 5000; i++) {
                    this.processedSequences.delete(arr[i]);
                }
            }

            try {
                const l2Msg = item.message.message.l2Msg;
                if (!l2Msg) continue;

                // Decodificar transação
                const tx = this.decodeL2Message(l2Msg, seqNum, item.message.message.header.timestamp);
                if (tx && this.shouldProcess(tx)) {
                    this.notifyCallbacks(tx);
                }
            } catch (e) {
                // Ignorar erros de decodificação
            }
        }
    }

    /**
     * Processa batch binário do Nitro
     */
    private processBinaryBatch(data: Buffer): void {
        // Formato Nitro batch é complexo - simplificando para transações básicas
        // Em produção, usar @arbitrum/sdk para decodificação completa

        try {
            // Tentar encontrar transações RLP no buffer
            let offset = 0;
            while (offset < data.length - 10) {
                // Procurar por padrões de transação RLP
                const byte = data[offset];

                // Transação RLP começa com 0xf8 ou 0xf9 (lista longa)
                if (byte === 0xf8 || byte === 0xf9) {
                    const tx = this.tryDecodeTransaction(data, offset);
                    if (tx && this.shouldProcess(tx)) {
                        this.notifyCallbacks(tx);
                    }
                }
                offset++;
            }
        } catch (e) {
            // Ignorar erros
        }
    }

    /**
     * Tenta decodificar transação de buffer
     */
    private tryDecodeTransaction(data: Buffer, offset: number): PendingTransaction | null {
        try {
            // Extrair slice com tamanho estimado
            const slice = data.slice(offset, Math.min(offset + 1000, data.length));
            const hex = '0x' + slice.toString('hex');

            // Tentar parsear como transação
            const parsed = ethers.Transaction.from(hex);

            return {
                hash: parsed.hash || '',
                from: parsed.from || '',
                to: parsed.to,
                value: parsed.value,
                data: parsed.data,
                gasLimit: parsed.gasLimit,
                gasPrice: parsed.gasPrice || 0n,
                nonce: parsed.nonce,
                timestamp: Date.now(),
                sequenceNumber: 0,
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Decodifica mensagem L2 do sequencer
     */
    private decodeL2Message(l2Msg: string, seqNum: number, timestamp: number): PendingTransaction | null {
        try {
            // L2 message é uma transação codificada em hex
            const txData = l2Msg.startsWith('0x') ? l2Msg : '0x' + l2Msg;
            const parsed = ethers.Transaction.from(txData);

            return {
                hash: parsed.hash || ethers.keccak256(txData),
                from: parsed.from || '',
                to: parsed.to,
                value: parsed.value,
                data: parsed.data,
                gasLimit: parsed.gasLimit,
                gasPrice: parsed.gasPrice || 0n,
                nonce: parsed.nonce,
                timestamp: timestamp * 1000,
                sequenceNumber: seqNum,
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Verifica se transação deve ser processada
     */
    private shouldProcess(tx: PendingTransaction): boolean {
        // Filtrar por contratos alvo (DEXs)
        if (tx.to && this.targetContracts.size > 0) {
            if (!this.targetContracts.has(tx.to.toLowerCase())) {
                return false;
            }
        }

        // Filtrar por valor mínimo
        if (tx.value < this.minValue) {
            return false;
        }

        return true;
    }

    /**
     * Notifica callbacks sobre nova transação
     */
    private notifyCallbacks(tx: PendingTransaction): void {
        for (const callback of this.callbacks) {
            try {
                callback(tx);
            } catch (e) {
                console.error('Erro no callback:', e);
            }
        }
    }

    /**
     * Tenta reconectar ao feed
     */
    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ Máximo de tentativas de reconexão atingido');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

        console.log(`🔄 Reconectando em ${delay/1000}s (tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

        setTimeout(() => {
            this.connect().catch(console.error);
        }, delay);
    }

    /**
     * Registra callback para novas transações
     */
    onTransaction(callback: TransactionCallback): void {
        this.callbacks.push(callback);
    }

    /**
     * Adiciona contrato para monitorar
     */
    addTargetContract(address: string): void {
        this.targetContracts.add(address.toLowerCase());
    }

    /**
     * Define valor mínimo para filtrar
     */
    setMinValue(value: bigint): void {
        this.minValue = value;
    }

    /**
     * Desconecta do feed
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }

    /**
     * Verifica se está conectado
     */
    get connected(): boolean {
        return this.isConnected;
    }
}

// ============================================================================
// EXEMPLO DE USO
// ============================================================================

export async function startSequencerMonitor(): Promise<SequencerFeed> {
    const feed = new SequencerFeed();

    // Callback para processar transações
    feed.onTransaction((tx) => {
        const value = ethers.formatEther(tx.value);
        const gasPrice = ethers.formatUnits(tx.gasPrice, 'gwei');

        console.log(`\n🔥 TRANSAÇÃO PENDENTE DETECTADA!`);
        console.log(`   Hash: ${tx.hash}`);
        console.log(`   From: ${tx.from}`);
        console.log(`   To: ${tx.to}`);
        console.log(`   Value: ${value} ETH`);
        console.log(`   Gas Price: ${gasPrice} Gwei`);
        console.log(`   Sequence: ${tx.sequenceNumber}`);

        // Analisar se é swap em DEX
        if (tx.data.length > 10) {
            const selector = tx.data.slice(0, 10);
            const knownSelectors: Record<string, string> = {
                '0x414bf389': 'exactInputSingle (Uniswap V3)',
                '0xc04b8d59': 'exactInput (Uniswap V3)',
                '0xdb3e2198': 'exactOutputSingle (Uniswap V3)',
                '0x38ed1739': 'swapExactTokensForTokens (V2)',
                '0x7ff36ab5': 'swapExactETHForTokens (V2)',
                '0x18cbafe5': 'swapExactTokensForETH (V2)',
                '0x52bbbe29': 'swap (Balancer)',
            };

            if (knownSelectors[selector]) {
                console.log(`   🎯 SWAP DETECTADO: ${knownSelectors[selector]}`);
            }
        }
    });

    await feed.connect();

    return feed;
}

// Export para uso no bot principal
export default SequencerFeed;
