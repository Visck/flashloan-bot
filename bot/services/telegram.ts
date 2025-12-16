import { logger } from './logger';

interface TelegramConfig {
    botToken: string;
    chatId: string;
    enabled: boolean;
}

class TelegramNotifier {
    private config: TelegramConfig;
    private baseUrl: string;
    private messageQueue: string[] = [];
    private isSending: boolean = false;
    private rateLimitDelay: number = 1000; // 1 segundo entre mensagens

    constructor() {
        this.config = {
            botToken: process.env.TELEGRAM_BOT_TOKEN || '',
            chatId: process.env.TELEGRAM_CHAT_ID || '',
            enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
        };

        this.baseUrl = `https://api.telegram.org/bot${this.config.botToken}`;

        if (this.config.enabled) {
            logger.info('Telegram notifications enabled');
        } else {
            logger.info('Telegram notifications disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
        }
    }

    private async sendRequest(method: string, params: Record<string, any>): Promise<any> {
        try {
            const url = `${this.baseUrl}/${method}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });

            const data = await response.json() as { ok: boolean; description?: string };

            if (!data.ok) {
                logger.error(`Telegram API error: ${data.description}`);
            }

            return data;
        } catch (error) {
            logger.error(`Telegram request failed: ${error}`);
            return null;
        }
    }

    private async processQueue(): Promise<void> {
        if (this.isSending || this.messageQueue.length === 0) return;

        this.isSending = true;

        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            if (message) {
                await this.sendRequest('sendMessage', {
                    chat_id: this.config.chatId,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                });
                await this.sleep(this.rateLimitDelay);
            }
        }

        this.isSending = false;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async send(message: string): Promise<void> {
        if (!this.config.enabled) return;

        this.messageQueue.push(message);
        this.processQueue();
    }

    // === Mensagens Pré-formatadas ===

    async sendStartup(stats: {
        chain: string;
        mode: string;
        protocols: number;
        users: number;
        rpcs: number;
    }): Promise<void> {
        const message = `
🚀 <b>LIQUIDATION BOT STARTED</b>

📍 Chain: ${stats.chain}
⚙️ Mode: ${stats.mode}
📊 Protocols: ${stats.protocols}
👥 Users Monitored: ${stats.users}
🌐 RPCs Available: ${stats.rpcs}

Bot is now monitoring for liquidation opportunities...
        `.trim();

        await this.send(message);
    }

    async sendOpportunity(data: {
        protocol: string;
        user: string;
        healthFactor: number;
        profitUsd: number;
        debtAsset: string;
        debtValueUsd: number;
        collateralAsset: string;
        collateralValueUsd: number;
        isSimulation: boolean;
    }): Promise<void> {
        const emoji = data.isSimulation ? '🔍' : '💰';
        const status = data.isSimulation ? 'SIMULATION' : 'EXECUTING';

        const message = `
${emoji} <b>LIQUIDATION OPPORTUNITY ${status}</b>

📋 Protocol: ${data.protocol}
👤 User: <code>${data.user.slice(0, 10)}...${data.user.slice(-8)}</code>
❤️ Health Factor: ${data.healthFactor.toFixed(4)}

💳 Debt: ${data.debtAsset} ($${data.debtValueUsd.toFixed(2)})
🏦 Collateral: ${data.collateralAsset} ($${data.collateralValueUsd.toFixed(2)})

💵 <b>Expected Profit: $${data.profitUsd.toFixed(2)}</b>
        `.trim();

        await this.send(message);
    }

    async sendExecution(data: {
        txHash: string;
        profitUsd: number;
        gasUsed: string;
        success: boolean;
        blockExplorer: string;
    }): Promise<void> {
        const emoji = data.success ? '✅' : '❌';
        const status = data.success ? 'SUCCESS' : 'FAILED';

        const message = `
${emoji} <b>LIQUIDATION ${status}</b>

🔗 TX: <a href="${data.blockExplorer}/tx/${data.txHash}">${data.txHash.slice(0, 20)}...</a>
⛽ Gas Used: ${data.gasUsed}
💵 Profit: $${data.profitUsd.toFixed(2)}
        `.trim();

        await this.send(message);
    }

    async sendStats(stats: {
        runtime: string;
        cycles: number;
        usersChecked: number;
        opportunitiesFound: number;
        liquidationsExecuted: number;
        totalProfitUsd: number;
        activeRpc: string;
        healthyRpcs: number;
        totalRpcs: number;
    }): Promise<void> {
        const message = `
📊 <b>BOT STATISTICS</b>

⏱️ Runtime: ${stats.runtime}
🔄 Cycles: ${stats.cycles.toLocaleString()}
👥 Users Checked: ${stats.usersChecked.toLocaleString()}
🎯 Opportunities: ${stats.opportunitiesFound}
✅ Liquidations: ${stats.liquidationsExecuted}
💰 Total Profit: $${stats.totalProfitUsd.toFixed(2)}

🌐 Active RPC: ${stats.activeRpc}
💚 RPC Health: ${stats.healthyRpcs}/${stats.totalRpcs}
        `.trim();

        await this.send(message);
    }

    async sendError(error: string): Promise<void> {
        const message = `
🚨 <b>BOT ERROR</b>

${error}

Please check the logs for more details.
        `.trim();

        await this.send(message);
    }

    async sendShutdown(reason: string): Promise<void> {
        const message = `
🛑 <b>BOT STOPPED</b>

Reason: ${reason}
        `.trim();

        await this.send(message);
    }

    async sendRpcSwitch(from: string, to: string, reason: string): Promise<void> {
        const message = `
🔄 <b>RPC SWITCHED</b>

From: ${from}
To: ${to}
Reason: ${reason}
        `.trim();

        await this.send(message);
    }

    isEnabled(): boolean {
        return this.config.enabled;
    }
}

// Singleton instance
export const telegram = new TelegramNotifier();

// Helper function para teste
export async function testTelegramConnection(): Promise<boolean> {
    if (!telegram.isEnabled()) {
        logger.warn('Telegram not configured');
        return false;
    }

    try {
        await telegram.send('🧪 Test message from Liquidation Bot');
        logger.info('Telegram test message sent successfully');
        return true;
    } catch (error) {
        logger.error(`Telegram test failed: ${error}`);
        return false;
    }
}
