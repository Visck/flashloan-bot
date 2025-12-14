/**
 * ============================================================================
 * LOGGER - SISTEMA DE LOGS DO BOT
 * ============================================================================
 *
 * Sistema de logging configurável para o bot de arbitragem.
 *
 * NÍVEIS DE LOG:
 * - error: Erros críticos que impedem operação
 * - warn: Avisos importantes
 * - info: Informações gerais de operação
 * - debug: Detalhes técnicos para debugging
 *
 * RECURSOS:
 * - Logs coloridos no console
 * - Timestamps em cada mensagem
 * - Contexto (módulo/operação)
 * - Formatação de objetos JSON
 */

import winston from 'winston';
import { BOT_CONFIG } from './config';

// ============================================================================
// CONFIGURAÇÃO DE CORES
// ============================================================================

/**
 * Cores para diferentes níveis de log no console
 */
const colors = {
    error: '\x1b[31m',   // Vermelho
    warn: '\x1b[33m',    // Amarelo
    info: '\x1b[36m',    // Ciano
    debug: '\x1b[90m',   // Cinza
    reset: '\x1b[0m',    // Reset
};

// ============================================================================
// FORMATO CUSTOMIZADO
// ============================================================================

/**
 * Formato customizado para logs no console
 */
const consoleFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    // Cor baseada no nível
    const color = colors[level as keyof typeof colors] || colors.reset;

    // Emoji baseado no nível
    const emoji = {
        error: '❌',
        warn: '⚠️',
        info: 'ℹ️',
        debug: '🔍',
    }[level] || '📝';

    // Formata metadata se existir
    let metaStr = '';
    if (Object.keys(metadata).length > 0) {
        metaStr = '\n' + JSON.stringify(metadata, null, 2);
    }

    return `${color}${timestamp} ${emoji} [${level.toUpperCase()}] ${message}${metaStr}${colors.reset}`;
});

// ============================================================================
// INSTÂNCIA DO LOGGER
// ============================================================================

/**
 * Logger principal do bot
 *
 * USO:
 * ```typescript
 * import { logger } from './logger';
 *
 * logger.info('Bot iniciado');
 * logger.error('Erro ao executar', { error: err.message });
 * logger.debug('Detalhes técnicos', { data: someObject });
 * ```
 */
export const logger = winston.createLogger({
    // Nível mínimo de log (configurável via .env)
    level: BOT_CONFIG.logLevel,

    // Formato base com timestamp
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss.SSS',
        }),
        winston.format.errors({ stack: true }),
    ),

    // Transports (destinos dos logs)
    transports: [
        // Console com cores
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                consoleFormat,
            ),
        }),
    ],
});

// ============================================================================
// FUNÇÕES AUXILIARES
// ============================================================================

/**
 * Log de início de operação com separador visual
 */
export function logOperationStart(operation: string): void {
    logger.info('═'.repeat(60));
    logger.info(`🚀 INICIANDO: ${operation}`);
    logger.info('═'.repeat(60));
}

/**
 * Log de fim de operação
 */
export function logOperationEnd(operation: string, success: boolean): void {
    const status = success ? '✅ SUCESSO' : '❌ FALHA';
    logger.info(`${status}: ${operation}`);
    logger.info('─'.repeat(60));
}

/**
 * Log de oportunidade de arbitragem encontrada
 */
export function logArbitrageOpportunity(opportunity: {
    tokenBorrow: { symbol: string };
    tokenTarget: { symbol: string };
    profitPercentage: number;
    netProfitUsd: number;
    dexBuy: number;
    dexSell: number;
}): void {
    const dexNames = ['Uniswap V3', 'SushiSwap'];

    logger.info('');
    logger.info('💰 ═══════════════════════════════════════════════════');
    logger.info('💰 OPORTUNIDADE DE ARBITRAGEM ENCONTRADA!');
    logger.info('💰 ═══════════════════════════════════════════════════');
    logger.info(`   Par: ${opportunity.tokenBorrow.symbol} ↔ ${opportunity.tokenTarget.symbol}`);
    logger.info(`   Comprar em: ${dexNames[opportunity.dexBuy]}`);
    logger.info(`   Vender em: ${dexNames[opportunity.dexSell]}`);
    logger.info(`   Lucro: ${opportunity.profitPercentage.toFixed(4)}%`);
    logger.info(`   Lucro Líquido: $${opportunity.netProfitUsd.toFixed(2)}`);
    logger.info('💰 ═══════════════════════════════════════════════════');
    logger.info('');
}

/**
 * Log de execução de arbitragem
 */
export function logArbitrageExecution(
    txHash: string,
    profit: number,
    gasUsed: bigint,
    gasCost: number
): void {
    logger.info('');
    logger.info('🎉 ═══════════════════════════════════════════════════');
    logger.info('🎉 ARBITRAGEM EXECUTADA COM SUCESSO!');
    logger.info('🎉 ═══════════════════════════════════════════════════');
    logger.info(`   TX Hash: ${txHash}`);
    logger.info(`   Lucro: $${profit.toFixed(2)}`);
    logger.info(`   Gas Usado: ${gasUsed.toString()}`);
    logger.info(`   Custo de Gas: $${gasCost.toFixed(4)}`);
    logger.info('🎉 ═══════════════════════════════════════════════════');
    logger.info('');
}

/**
 * Log de status do bot
 */
export function logBotStatus(
    uptime: number,
    opportunitiesFound: number,
    executedTrades: number,
    totalProfit: number
): void {
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    logger.info('');
    logger.info('📊 ═══════════════════════════════════════════════════');
    logger.info('📊 STATUS DO BOT');
    logger.info('📊 ═══════════════════════════════════════════════════');
    logger.info(`   Uptime: ${hours}h ${minutes}m`);
    logger.info(`   Oportunidades Encontradas: ${opportunitiesFound}`);
    logger.info(`   Trades Executados: ${executedTrades}`);
    logger.info(`   Lucro Total: $${totalProfit.toFixed(2)}`);
    logger.info('📊 ═══════════════════════════════════════════════════');
    logger.info('');
}

/**
 * Log de erro detalhado
 */
export function logError(context: string, error: Error | unknown): void {
    logger.error(`Erro em ${context}:`, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
}
