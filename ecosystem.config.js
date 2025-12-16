module.exports = {
  apps: [
    {
      name: 'liquidation-bot',
      script: 'npm',
      args: 'run dev:liquidation',
      cwd: '/root/liquidation-bot', // Ajuste para seu diretório no VPS

      // Reiniciar automaticamente
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',

      // Reiniciar em caso de crash
      restart_delay: 5000, // 5 segundos entre restarts
      max_restarts: 10, // Máximo de restarts em caso de crash loop

      // Logs
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Variáveis de ambiente (produção)
      env: {
        NODE_ENV: 'production',
      },

      // Ambiente de desenvolvimento
      env_development: {
        NODE_ENV: 'development',
      },
    },
  ],
};
