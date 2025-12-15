/**
 * ============================================================================
 * SERVIÇO FLASHBOTS - PROTEÇÃO MEV
 * ============================================================================
 *
 * Implementação de proteção contra MEV (Maximal Extractable Value) usando
 * bundles privados.
 *
 * O que é MEV?
 * - Bots monitoram a mempool pública
 * - Quando veem uma transação lucrativa, fazem frontrunning/sandwich
 * - Isso pode causar perdas significativas
 *
 * Como Flashbots protege:
 * - Transações são enviadas diretamente aos block builders
 * - Não passam pela mempool pública
 * - Bots de MEV não conseguem ver suas transações
 *
 * NOTA: Flashbots tradicional é para Ethereum mainnet.
 * Para Arbitrum, usamos provedores de bundle privado ou RPC privado.
 */

import {
    JsonRpcProvider,
    Wallet,
    TransactionRequest,
    TransactionResponse,
    formatUnits,
    parseUnits,
} from 'ethers';
import { logger } from './logger';

// ============================================================================
// TIPOS
// ============================================================================

interface BundleTransaction {
    signedTransaction: string;
    hash: string;
}

interface BundleSimulation {
    success: boolean;
    error?: string;
    profit?: bigint;
    gasUsed?: bigint;
}

interface PrivateRpcConfig {
    url: string;
    name: string;
    supportsBundle: boolean;
}

// ============================================================================
// CONFIGURAÇÃO DE RPCs PRIVADOS PARA ARBITRUM
// ============================================================================

const PRIVATE_RPCS: PrivateRpcConfig[] = [
    {
        url: 'https://arb1.arbitrum.io/rpc',
        name: 'Arbitrum Official',
        supportsBundle: false,
    },
    // Adicione RPCs privados se tiver acesso
    // {
    //     url: 'https://seu-rpc-privado.com',
    //     name: 'Private RPC',
    //     supportsBundle: true,
    // },
];

// ============================================================================
// CLASSE PRINCIPAL
// ============================================================================

export class FlashbotsService {
    private wallet: Wallet;
    private provider: JsonRpcProvider;
    private privateProvider: JsonRpcProvider | null = null;
    private isEnabled: boolean;

    constructor(wallet: Wallet, provider: JsonRpcProvider) {
        this.wallet = wallet;
        this.provider = provider;
        this.isEnabled = process.env.USE_FLASHBOTS === 'true';

        if (this.isEnabled) {
            this.initializePrivateRpc();
        }
    }

    /**
     * Inicializa conexão com RPC privado
     */
    private async initializePrivateRpc(): Promise<void> {
        logger.info('Inicializando proteção MEV...');

        // Para Arbitrum, usamos estratégias diferentes do Ethereum
        // 1. RPC privado (se disponível)
        // 2. Transações com gas alto para prioridade
        // 3. Slippage calculado para proteção

        const privateRpc = PRIVATE_RPCS.find(rpc => rpc.supportsBundle);
        if (privateRpc) {
            this.privateProvider = new JsonRpcProvider(privateRpc.url);
            logger.info(`RPC privado conectado: ${privateRpc.name}`);
        } else {
            logger.warn('Nenhum RPC privado com suporte a bundle disponível');
            logger.info('Usando estratégias alternativas de proteção MEV');
        }
    }

    /**
     * Envia transação com proteção MEV
     */
    async sendProtectedTransaction(
        tx: TransactionRequest
    ): Promise<TransactionResponse | null> {
        if (!this.isEnabled) {
            // Sem proteção, envia normalmente
            return await this.wallet.sendTransaction(tx);
        }

        logger.info('Enviando transação com proteção MEV...');

        try {
            // Estratégia 1: Usar RPC privado se disponível
            if (this.privateProvider) {
                return await this.sendViaPrivateRpc(tx);
            }

            // Estratégia 2: Aumentar gas para prioridade
            return await this.sendWithPriorityGas(tx);
        } catch (error: any) {
            logger.error('Erro ao enviar transação protegida:', error.message);

            // Fallback: enviar normalmente
            logger.warn('Fallback: enviando sem proteção MEV');
            return await this.wallet.sendTransaction(tx);
        }
    }

    /**
     * Envia via RPC privado
     */
    private async sendViaPrivateRpc(
        tx: TransactionRequest
    ): Promise<TransactionResponse> {
        if (!this.privateProvider) {
            throw new Error('RPC privado não disponível');
        }

        const walletWithPrivate = this.wallet.connect(this.privateProvider);
        const response = await walletWithPrivate.sendTransaction(tx);

        logger.info(`Transação enviada via RPC privado: ${response.hash}`);
        return response;
    }

    /**
     * Envia com gas prioritário
     * Aumenta a chance de inclusão rápida, reduzindo janela de ataque
     */
    private async sendWithPriorityGas(
        tx: TransactionRequest
    ): Promise<TransactionResponse> {
        const feeData = await this.provider.getFeeData();

        // Aumenta gas em 20% para prioridade
        const priorityMultiplier = 1.2;

        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            tx.maxFeePerGas = BigInt(Math.floor(
                Number(feeData.maxFeePerGas) * priorityMultiplier
            ));
            tx.maxPriorityFeePerGas = BigInt(Math.floor(
                Number(feeData.maxPriorityFeePerGas) * priorityMultiplier
            ));
        } else if (feeData.gasPrice) {
            tx.gasPrice = BigInt(Math.floor(
                Number(feeData.gasPrice) * priorityMultiplier
            ));
        }

        logger.debug(`Gas prioritário aplicado (${priorityMultiplier}x)`);

        const response = await this.wallet.sendTransaction(tx);
        logger.info(`Transação enviada com gas prioritário: ${response.hash}`);

        return response;
    }

    /**
     * Simula transação antes de enviar
     * Verifica se será lucrativa mesmo com possível MEV
     */
    async simulateTransaction(
        tx: TransactionRequest
    ): Promise<BundleSimulation> {
        try {
            // Simula a transação
            const result = await this.provider.call(tx);

            // Se chegou aqui, a transação seria bem-sucedida
            return {
                success: true,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message,
            };
        }
    }

    /**
     * Calcula slippage dinâmico baseado em condições de mercado
     * Slippage mais alto = mais proteção contra sandwich attacks
     */
    calculateProtectiveSlippage(
        baseSlippageBps: number,
        amountUsd: number
    ): number {
        // Para valores maiores, usa slippage menor (mais arriscado)
        // Para valores menores, pode usar slippage maior (mais seguro)

        let adjustedSlippage = baseSlippageBps;

        if (amountUsd > 50000) {
            // Transações grandes: slippage mais apertado
            adjustedSlippage = Math.max(baseSlippageBps * 0.5, 10); // Mínimo 0.1%
        } else if (amountUsd > 10000) {
            // Transações médias: slippage normal
            adjustedSlippage = baseSlippageBps;
        } else {
            // Transações pequenas: pode aceitar mais slippage
            adjustedSlippage = baseSlippageBps * 1.5;
        }

        // Limita entre 0.1% e 2%
        return Math.min(Math.max(adjustedSlippage, 10), 200);
    }

    /**
     * Verifica se há atividade de MEV suspeita no bloco atual
     */
    async detectMevActivity(): Promise<{
        detected: boolean;
        suspiciousTxCount: number;
    }> {
        try {
            const latestBlock = await this.provider.getBlock('latest', true);
            if (!latestBlock || !latestBlock.transactions) {
                return { detected: false, suspiciousTxCount: 0 };
            }

            let suspiciousTxCount = 0;

            // Analisa transações do bloco
            for (const txHash of latestBlock.transactions) {
                if (typeof txHash === 'string') {
                    const tx = await this.provider.getTransaction(txHash);
                    if (tx && this.isSuspiciousMevTx(tx)) {
                        suspiciousTxCount++;
                    }
                }
            }

            // Se mais de 5% das transações parecem MEV, alerta
            const mevThreshold = latestBlock.transactions.length * 0.05;
            const detected = suspiciousTxCount > mevThreshold;

            if (detected) {
                logger.warn(`Atividade MEV detectada: ${suspiciousTxCount} transações suspeitas`);
            }

            return { detected, suspiciousTxCount };
        } catch (error) {
            return { detected: false, suspiciousTxCount: 0 };
        }
    }

    /**
     * Verifica se uma transação parece ser de MEV bot
     */
    private isSuspiciousMevTx(tx: any): boolean {
        // Características de transações MEV:
        // 1. Gas price muito alto
        // 2. Para contratos de DEX
        // 3. Valor alto

        const dexRouters = [
            '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3
            '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap
            '0xc873fEcbd354f5A56E00E710B90EF4201db2448d', // Camelot
        ];

        if (!tx.to) return false;

        const isToRouter = dexRouters.some(
            router => router.toLowerCase() === tx.to.toLowerCase()
        );

        // Verifica se gas é anormalmente alto (> 10 Gwei na Arbitrum é alto)
        const gasPrice = tx.gasPrice || tx.maxFeePerGas || 0n;
        const isHighGas = gasPrice > parseUnits('10', 'gwei');

        return isToRouter && isHighGas;
    }

    /**
     * Retorna status do serviço
     */
    getStatus(): {
        enabled: boolean;
        privateRpcConnected: boolean;
        strategies: string[];
    } {
        const strategies: string[] = [];

        if (this.privateProvider) {
            strategies.push('RPC Privado');
        }
        strategies.push('Gas Prioritário');
        strategies.push('Slippage Dinâmico');
        strategies.push('Detecção MEV');

        return {
            enabled: this.isEnabled,
            privateRpcConnected: this.privateProvider !== null,
            strategies,
        };
    }
}

// ============================================================================
// UTILITÁRIOS DE PROTEÇÃO
// ============================================================================

/**
 * Calcula amountOutMinimum com proteção contra sandwich
 */
export function calculateProtectedAmountOut(
    expectedAmount: bigint,
    slippageBps: number
): bigint {
    // slippageBps: 100 = 1%
    const slippageMultiplier = 10000n - BigInt(slippageBps);
    return (expectedAmount * slippageMultiplier) / 10000n;
}

/**
 * Verifica se o preço está dentro de limites aceitáveis
 */
export function isPriceWithinRange(
    currentPrice: number,
    expectedPrice: number,
    tolerancePercent: number
): boolean {
    const lowerBound = expectedPrice * (1 - tolerancePercent / 100);
    const upperBound = expectedPrice * (1 + tolerancePercent / 100);

    return currentPrice >= lowerBound && currentPrice <= upperBound;
}

/**
 * Calcula deadline ótimo para transação
 * Deadline mais curto = menos tempo para MEV
 */
export function calculateOptimalDeadline(
    baseSeconds: number = 60
): number {
    // Deadline de 60 segundos é razoável para Arbitrum
    // Blocos são rápidos (~0.25s), então não precisa muito tempo
    return Math.floor(Date.now() / 1000) + baseSeconds;
}

export default FlashbotsService;
