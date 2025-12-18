/**
 * PM2 Configuration - Liquidation Bot
 *
 * USO:
 *   pm2 start ecosystem.liquidation.config.js
 *   pm2 start ecosystem.liquidation.config.js --env production
 *
 * COMANDOS:
 *   pm2 logs liquidation-bot
 *   pm2 monit liquidation-bot
 *   pm2 restart liquidation-bot
 *   pm2 stop liquidation-bot
 */

module.exports = {
    apps: [
        {
            name: 'liquidation-bot',
            script: 'bot/liquidation/liquidationBot.ts',
            interpreter: 'ts-node',
            interpreter_args: '--transpile-only',
            cwd: __dirname,

            // Restart settings
            watch: false,
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,

            // Memory management
            max_memory_restart: '500M',

            // Logging
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            error_file: 'logs/liquidation-error.log',
            out_file: 'logs/liquidation-out.log',
            merge_logs: true,

            // Environment - Development (default)
            env: {
                NODE_ENV: 'development',
                SIMULATION_MODE: 'true',
                LOG_LEVEL: 'debug'
            },

            // Environment - Production
            env_production: {
                NODE_ENV: 'production',
                SIMULATION_MODE: 'false',
                LOG_LEVEL: 'info'
            },

            // Environment - Simulation
            env_simulation: {
                NODE_ENV: 'development',
                SIMULATION_MODE: 'true',
                LOG_LEVEL: 'info'
            }
        }
    ]
};
