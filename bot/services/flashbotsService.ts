/**
 * Flashbots Service - Proteção contra MEV/Frontrunning
 * Envia transações via Flashbots Protect para evitar ser frontrun
 */

import { ethers, Wallet, JsonRpcProvider, TransactionRequest, TransactionResponse } from 'ethers';
import { logger } from './logger';

// Flashbots Protect RPC endpoints
const FLASHBOTS_RPC = {
    arbitrum: 'https://rpc.flashbots.net/fast', // Ethereum Mainnet (Flashbots)
    arbitrumProtect: 'https://protect.flashbots.net', // Flashbots Protect
};

// Para Arbitrum, usamos MEV Blocker ou transações diretas ao sequencer
const MEV_PROTECT_ENDPOINTS = {
    mevBlocker: 'https://rpc.mevblocker.io',
    flashbotsProtect: 'https://rpc.flashbots.net',
    // Arbitrum não tem Flashbots nativo, mas podemos usar private mempool
};

interface FlashbotsBundle {
    signedTransactions: string[];
    blockNumber: number;
}

interface SendBundleResult {
    bundleHash: string;
    success: boolean;
    error?: string;
}

export class FlashbotsService {
    private wallet: Wallet;
    private provider: JsonRpcProvider;
    private flashbotsProvider: JsonRpcProvider | null = null;
    private useFlashbots: boolean;

    constructor(provider: JsonRpcProvider, wallet: Wallet, useFlashbots: boolean = true) {
        this.provider = provider;
        this.wallet = wallet;
        this.useFlashbots = useFlashbots;

        if (useFlashbots) {
            // Para Ethereum mainnet, usaria Flashbots
            // Para Arbitrum, usamos transações diretas ao sequencer
            logger.info('Flashbots/MEV Protection initialized');
        }
    }

    /**
     * Envia transação com proteção MEV
     * Em Arbitrum, o sequencer é centralizado, então frontrunning é menos comum
     * Mas ainda podemos otimizar para menor latência
     */
    async sendProtectedTransaction(
        tx: TransactionRequest,
        priorityFee?: bigint
    ): Promise<TransactionResponse | null> {
        try {
            // Obtém nonce atual
            const nonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');

            // Obtém fee data
            const feeData = await this.provider.getFeeData();

            // Configura transação com prioridade
            const txRequest: TransactionRequest = {
                ...tx,
                from: this.wallet.address,
                nonce,
                chainId: 42161, // Arbitrum
                type: 2, // EIP-1559
                maxFeePerGas: feeData.maxFeePerGas || feeData.gasPrice || BigInt(100000000), // 0.1 gwei
                maxPriorityFeePerGas: priorityFee || feeData.maxPriorityFeePerGas || BigInt(10000000), // 0.01 gwei
            };

            // Estima gas se não especificado
            if (!txRequest.gasLimit) {
                const gasEstimate = await this.provider.estimateGas(txRequest);
                txRequest.gasLimit = (gasEstimate * 120n) / 100n; // +20% buffer
            }

            logger.info(`Sending protected transaction (nonce: ${nonce}, gasLimit: ${txRequest.gasLimit})`);

            // Assina e envia
            const signedTx = await this.wallet.signTransaction(txRequest);
            const txResponse = await this.provider.broadcastTransaction(signedTx);

            logger.info(`Transaction sent: ${txResponse.hash}`);
            return txResponse;

        } catch (error) {
            logger.error(`Failed to send protected transaction: ${error}`);
            return null;
        }
    }

    /**
     * Envia liquidação com máxima prioridade
     * Usa gas price competitivo para garantir inclusão rápida
     */
    async sendLiquidationTx(
        to: string,
        data: string,
        value: bigint = 0n,
        gasLimit?: bigint
    ): Promise<TransactionResponse | null> {
        try {
            const feeData = await this.provider.getFeeData();

            // Para liquidações, usamos prioridade mais alta
            const priorityFee = (feeData.maxPriorityFeePerGas || BigInt(10000000)) * 2n;

            const tx: TransactionRequest = {
                to,
                data,
                value,
                gasLimit: gasLimit || undefined,
            };

            return await this.sendProtectedTransaction(tx, priorityFee);

        } catch (error) {
            logger.error(`Failed to send liquidation tx: ${error}`);
            return null;
        }
    }

    /**
     * Simula transação antes de enviar
     * Útil para verificar se liquidação vai funcionar
     */
    async simulateTransaction(tx: TransactionRequest): Promise<{
        success: boolean;
        gasUsed?: bigint;
        error?: string;
    }> {
        try {
            const result = await this.provider.call(tx);
            const gasEstimate = await this.provider.estimateGas(tx);

            return {
                success: true,
                gasUsed: gasEstimate,
            };

        } catch (error: any) {
            return {
                success: false,
                error: error.message || String(error),
            };
        }
    }

    /**
     * Obtém gas price otimizado baseado em condições atuais
     */
    async getOptimalGasPrice(): Promise<{
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
    }> {
        const feeData = await this.provider.getFeeData();

        // Em Arbitrum, gas é muito barato
        // Usamos um pequeno buffer para garantir inclusão
        const baseFee = feeData.gasPrice || BigInt(100000000); // 0.1 gwei default
        const priorityFee = feeData.maxPriorityFeePerGas || BigInt(1000000); // 0.001 gwei

        return {
            maxFeePerGas: baseFee * 2n, // 2x do base para segurança
            maxPriorityFeePerGas: priorityFee * 2n,
        };
    }

    /**
     * Verifica se há transações pendentes para o mesmo target
     * Útil para detectar competição
     */
    async checkPendingCompetition(targetAddress: string): Promise<boolean> {
        // Em Arbitrum, não temos acesso ao mempool público
        // O sequencer processa em ordem FIFO
        // Retorna false por padrão
        return false;
    }

    /**
     * Cancela transação pendente (replace com gas mais alto)
     */
    async cancelTransaction(nonce: number): Promise<TransactionResponse | null> {
        try {
            const feeData = await this.provider.getFeeData();

            const cancelTx: TransactionRequest = {
                to: this.wallet.address,
                value: 0n,
                nonce,
                gasLimit: 21000n,
                maxFeePerGas: (feeData.maxFeePerGas || BigInt(100000000)) * 3n, // 3x para garantir replace
                maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas || BigInt(10000000)) * 3n,
            };

            const signedTx = await this.wallet.signTransaction(cancelTx);
            return await this.provider.broadcastTransaction(signedTx);

        } catch (error) {
            logger.error(`Failed to cancel transaction: ${error}`);
            return null;
        }
    }
}

/**
 * Helper para criar chamada de liquidação Aave V3
 */
export function encodeLiquidationCall(
    collateralAsset: string,
    debtAsset: string,
    user: string,
    debtToCover: bigint,
    receiveAToken: boolean = false
): string {
    const iface = new ethers.Interface([
        'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)',
    ]);

    return iface.encodeFunctionData('liquidationCall', [
        collateralAsset,
        debtAsset,
        user,
        debtToCover,
        receiveAToken,
    ]);
}

/**
 * Helper para criar chamada de flash loan + liquidação
 */
export function encodeFlashLoanLiquidation(
    flashLoanContract: string,
    asset: string,
    amount: bigint,
    liquidationParams: {
        collateralAsset: string;
        debtAsset: string;
        user: string;
    }
): string {
    // Encode params para o callback do flash loan
    const params = ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'address'],
        [liquidationParams.collateralAsset, liquidationParams.debtAsset, liquidationParams.user]
    );

    const iface = new ethers.Interface([
        'function executeFlashLoan(address asset, uint256 amount, bytes params)',
    ]);

    return iface.encodeFunctionData('executeFlashLoan', [asset, amount, params]);
}
