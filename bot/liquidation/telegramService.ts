/**
 * ============================================================================
 * TELEGRAM SERVICE - Notificações e Comandos via Telegram
 * ============================================================================
 *
 * Serviço de Telegram que:
 * - Envia notificações de liquidações
 * - Responde a comandos do usuário
 * - Envia alertas de oportunidades
 * - Relatórios periódicos de status
 */

import { logger } from '../logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface TelegramConfig {
    botToken: string;
    chatId: string;
    enabled: boolean;
    rateLimit: number; // mensagens por minuto
}

export interface NotificationOptions {
    parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
    disableNotification?: boolean;
    priority?: 'low' | 'normal' | 'high';
}

// ============================================================================
// TELEGRAM SERVICE CLASS
// ============================================================================

export class TelegramService {
    private config: TelegramConfig;
    private messageQueue: { message: string; options: NotificationOptions }[] = [];
    private lastSentTime: number = 0;
    private messageCount: number = 0;
    private isProcessingQueue: boolean = false;

    constructor(config: Partial<TelegramConfig> = {}) {
        this.config = {
            botToken: config.botToken || process.env.TELEGRAM_BOT_TOKEN || '',
            chatId: config.chatId || process.env.TELEGRAM_CHAT_ID || '',
            enabled: config.enabled ?? true,
            rateLimit: config.rateLimit || 20
        };
    }

    // ========================================================================
    // CORE MESSAGING
    // ========================================================================

    /**
     * Envia mensagem para o Telegram
     */
    async sendMessage(
        message: string,
        options: NotificationOptions = {}
    ): Promise<boolean> {
        if (!this.isConfigured()) {
            logger.debug('Telegram not configured, skipping message');
            return false;
        }

        // Rate limiting
        const now = Date.now();
        if (now - this.lastSentTime < 60000) {
            if (this.messageCount >= this.config.rateLimit) {
                this.messageQueue.push({ message, options });
                this.processQueue();
                return true;
            }
        } else {
            this.messageCount = 0;
        }

        try {
            const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: this.config.chatId,
                    text: message,
                    parse_mode: options.parseMode || 'Markdown',
                    disable_notification: options.disableNotification || options.priority === 'low'
                })
            });

            if (!response.ok) {
                const error = await response.text();
                logger.error('Telegram API error:', error);
                return false;
            }

            this.lastSentTime = now;
            this.messageCount++;
            return true;
        } catch (error) {
            logger.error('Failed to send Telegram message:', error);
            return false;
        }
    }

    /**
     * Processa fila de mensagens
     */
    private async processQueue(): Promise<void> {
        if (this.isProcessingQueue || this.messageQueue.length === 0) return;

        this.isProcessingQueue = true;

        while (this.messageQueue.length > 0) {
            const now = Date.now();

            if (now - this.lastSentTime < 60000 && this.messageCount >= this.config.rateLimit) {
                // Espera até resetar o rate limit
                await this.delay(60000 - (now - this.lastSentTime) + 1000);
                this.messageCount = 0;
            }

            const item = this.messageQueue.shift();
            if (item) {
                await this.sendMessage(item.message, item.options);
            }
        }

        this.isProcessingQueue = false;
    }

    // ========================================================================
    // NOTIFICATION TEMPLATES
    // ========================================================================

    /**
     * Notifica oportunidade de liquidação encontrada
     */
    async notifyOpportunityFound(opportunity: {
        userAddress: string;
        healthFactor: number;
        debtUsd: number;
        collateralUsd: number;
        estimatedProfit: number;
    }): Promise<void> {
        const message = `
🎯 *OPORTUNIDADE ENCONTRADA*
═══════════════════════════════

👤 *Usuário:* \`${this.shortAddress(opportunity.userAddress)}\`
❤️ *Health Factor:* ${opportunity.healthFactor.toFixed(4)}
💳 *Dívida:* $${opportunity.debtUsd.toFixed(2)}
🏦 *Colateral:* $${opportunity.collateralUsd.toFixed(2)}
💰 *Lucro Est.:* $${opportunity.estimatedProfit.toFixed(2)}

⏳ Tentando liquidação...
        `.trim();

        await this.sendMessage(message, { priority: 'high' });
    }

    /**
     * Notifica liquidação executada com sucesso
     */
    async notifyLiquidationSuccess(liquidation: {
        userAddress: string;
        txHash: string;
        debtRepaid: number;
        collateralReceived: number;
        profitUsd: number;
        gasCostUsd: number;
    }): Promise<void> {
        const netProfit = liquidation.profitUsd - liquidation.gasCostUsd;

        const message = `
✅ *LIQUIDAÇÃO EXECUTADA!*
═══════════════════════════════

👤 *Usuário:* \`${this.shortAddress(liquidation.userAddress)}\`
📝 *TX:* [Ver no Arbiscan](https://arbiscan.io/tx/${liquidation.txHash})

💳 *Dívida Paga:* $${liquidation.debtRepaid.toFixed(2)}
🏦 *Colateral Recebido:* $${liquidation.collateralReceived.toFixed(2)}
⛽ *Gas:* $${liquidation.gasCostUsd.toFixed(4)}

💰 *Lucro Líquido:* $${netProfit.toFixed(2)}

🎉 Parabéns!
        `.trim();

        await this.sendMessage(message, { priority: 'high' });
    }

    /**
     * Notifica falha na liquidação
     */
    async notifyLiquidationFailed(error: {
        userAddress: string;
        reason: string;
        lostToCompetitor: boolean;
    }): Promise<void> {
        const emoji = error.lostToCompetitor ? '🏃' : '❌';
        const title = error.lostToCompetitor ? 'PERDIDA PARA COMPETIDOR' : 'LIQUIDAÇÃO FALHOU';

        const message = `
${emoji} *${title}*
═══════════════════════════════

👤 *Usuário:* \`${this.shortAddress(error.userAddress)}\`
📋 *Razão:* ${error.reason}
        `.trim();

        await this.sendMessage(message, { priority: 'normal' });
    }

    /**
     * Notifica alerta de usuário em risco
     */
    async notifyHighRiskUser(user: {
        address: string;
        healthFactor: number;
        debtUsd: number;
    }): Promise<void> {
        const message = `
⚠️ *ALERTA: USUÁRIO EM RISCO*
═══════════════════════════════

👤 \`${this.shortAddress(user.address)}\`
❤️ HF: ${user.healthFactor.toFixed(4)}
💳 Dívida: $${user.debtUsd.toFixed(2)}

🔍 Monitorando de perto...
        `.trim();

        await this.sendMessage(message, { priority: 'normal', disableNotification: true });
    }

    /**
     * Envia relatório de status
     */
    async sendStatusReport(report: string): Promise<void> {
        await this.sendMessage(report, { priority: 'low', disableNotification: true });
    }

    /**
     * Notifica erro crítico
     */
    async notifyCriticalError(error: string): Promise<void> {
        const message = `
🚨 *ERRO CRÍTICO*
═══════════════════════════════

${error}

⚠️ Verificar imediatamente!
        `.trim();

        await this.sendMessage(message, { priority: 'high' });
    }

    /**
     * Notifica início do bot
     */
    async notifyBotStarted(info: {
        simulationMode: boolean;
        usersMonitored: number;
    }): Promise<void> {
        const mode = info.simulationMode ? '🧪 SIMULAÇÃO' : '🔴 PRODUÇÃO';

        const message = `
🚀 *BOT INICIADO*
═══════════════════════════════

📋 *Modo:* ${mode}
👥 *Usuários:* ${info.usersMonitored}
⏰ *Hora:* ${new Date().toISOString()}

✅ Monitoramento ativo!
        `.trim();

        await this.sendMessage(message);
    }

    /**
     * Notifica parada do bot
     */
    async notifyBotStopped(reason: string): Promise<void> {
        const message = `
🛑 *BOT PARADO*
═══════════════════════════════

📋 *Razão:* ${reason}
⏰ *Hora:* ${new Date().toISOString()}
        `.trim();

        await this.sendMessage(message, { priority: 'high' });
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    /**
     * Verifica se está configurado
     */
    isConfigured(): boolean {
        return !!(this.config.enabled && this.config.botToken && this.config.chatId);
    }

    /**
     * Encurta endereço para exibição
     */
    private shortAddress(address: string): string {
        if (address.length <= 10) return address;
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * Escapa caracteres especiais do Markdown
     */
    private escapeMarkdown(text: string): string {
        return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Retorna estatísticas
     */
    getStats(): { configured: boolean; messagesSent: number; queueSize: number } {
        return {
            configured: this.isConfigured(),
            messagesSent: this.messageCount,
            queueSize: this.messageQueue.length
        };
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createTelegramService(): TelegramService {
    return new TelegramService({
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
        enabled: process.env.TELEGRAM_ENABLED !== 'false'
    });
}
