import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const customFormat = printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
});

export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        customFormat
    ),
    transports: [
        new winston.transports.Console({
            format: combine(
                colorize(),
                timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                customFormat
            )
        }),
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error'
        }),
        new winston.transports.File({
            filename: 'logs/combined.log'
        })
    ]
});

export function logOpportunity(data: {
    protocol: string;
    user: string;
    healthFactor: number;
    profitUsd: number;
    debtAsset: string;
    collateralAsset: string;
}) {
    logger.info('LIQUIDATION OPPORTUNITY FOUND', {
        protocol: data.protocol,
        user: data.user.slice(0, 10) + '...',
        healthFactor: data.healthFactor.toFixed(4),
        profitUsd: `$${data.profitUsd.toFixed(2)}`,
        debt: data.debtAsset,
        collateral: data.collateralAsset
    });
}

export function logExecution(data: {
    txHash: string;
    profitUsd: number;
    gasUsed: string;
    success: boolean;
}) {
    if (data.success) {
        logger.info('LIQUIDATION EXECUTED', {
            txHash: data.txHash,
            profit: `$${data.profitUsd.toFixed(2)}`,
            gasUsed: data.gasUsed
        });
    } else {
        logger.error('LIQUIDATION FAILED', {
            txHash: data.txHash
        });
    }
}
