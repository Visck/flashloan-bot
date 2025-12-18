# Guia de Deploy - Liquidation Bot V2

## Especificações do VPS
- **CPU**: 8 vCPU
- **RAM**: 32 GB
- **Disco**: 240GB + 1000GB
- **Localização**: Ashburn, VA (US East)
- **IP**: 5.161.41.167

## 1. Preparação Inicial

### Conectar ao VPS
```bash
ssh root@5.161.41.167
```

### Instalar Dependências
```bash
# Atualizar sistema
apt update && apt upgrade -y

# Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt install -y nodejs

# Verificar versão
node --version  # v20.x.x
npm --version   # 10.x.x

# Instalar git e build tools
apt install -y git build-essential

# Instalar Docker (para nó próprio)
apt install -y docker.io docker-compose
systemctl enable docker
systemctl start docker
```

## 2. Deploy do Bot

### Clonar Repositório
```bash
# Criar diretório
mkdir -p /opt/liquidation-bot
cd /opt/liquidation-bot

# Clonar (ou copiar arquivos)
git clone https://github.com/Visck/flashloan-bot.git .

# OU copiar do local via SCP:
# scp -r ./Liquidationbot/* root@5.161.41.167:/opt/liquidation-bot/
```

### Configurar Ambiente
```bash
# Copiar .env
cp .env.example .env
nano .env

# Editar as seguintes variáveis:
# - PRIVATE_KEY (sua chave privada)
# - ARBITRUM_RPC_URL (Alchemy)
# - TELEGRAM_BOT_TOKEN
# - TELEGRAM_CHAT_ID
# - SIMULATION_MODE=false (quando pronto para produção)
```

### Instalar Dependências
```bash
npm install
```

### Buscar Todos os Usuários
```bash
# Primeiro, busque todos os usuários do Aave
npm run fetch:users:all

# Isso vai criar/atualizar data/active-users.json com 50.000+ usuários
```

## 3. Executar o Bot

### Modo Desenvolvimento (teste)
```bash
# Bot V1 (single chain)
npm run dev:liquidation

# Bot V2 (multi-chain)
npm run dev:liquidation:v2
```

### Modo Produção (systemd)

Criar serviço:
```bash
cat > /etc/systemd/system/liquidation-bot.service << 'EOF'
[Unit]
Description=Liquidation Bot V2
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/liquidation-bot
ExecStart=/usr/bin/node --max-old-space-size=8192 -r ts-node/register bot/liquidation/liquidationBotV2.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

Ativar e iniciar:
```bash
systemctl daemon-reload
systemctl enable liquidation-bot
systemctl start liquidation-bot

# Ver logs
journalctl -u liquidation-bot -f
```

### Modo PM2 (alternativo)
```bash
# Instalar PM2
npm install -g pm2

# Iniciar
pm2 start npm --name "liquidation-bot" -- run dev:liquidation:v2

# Configurar auto-restart
pm2 startup
pm2 save

# Ver logs
pm2 logs liquidation-bot
```

## 4. Configurar Nó Próprio (Opcional)

O nó próprio elimina dependência de RPCs externos e reduz latência.

### Executar Script de Instalação
```bash
# Copiar script para o VPS
scp scripts/setup-arbitrum-node.sh root@5.161.41.167:/opt/

# No VPS
chmod +x /opt/setup-arbitrum-node.sh
/opt/setup-arbitrum-node.sh
```

### Configurar L1 RPC
```bash
nano /opt/arbitrum/.env

# Adicionar:
L1_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/SUA_API_KEY
```

### Iniciar Nó
```bash
/opt/arbitrum/start.sh

# Monitorar sincronização
docker logs -f arbitrum-nitro

# Verificar status
/opt/arbitrum/status.sh
```

### Usar Nó no Bot
Após sincronização (~12-24h):
```bash
# Editar .env do bot
nano /opt/liquidation-bot/.env

# Atualizar:
USE_LOCAL_NODE=true
LOCAL_NODE_RPC_URL=http://localhost:8547
LOCAL_NODE_WSS_URL=ws://localhost:8548
POLLING_INTERVAL_MS=200  # Reduzir para 200ms com nó próprio
```

## 5. Otimizações de Performance

### Para seu VPS (8 vCPU, 32GB RAM)

Editar `.env`:
```env
# Performance otimizada
POLLING_INTERVAL_MS=300          # 300ms com nó próprio, 500ms sem
MAX_USERS_PER_BATCH=300          # Mais usuários por batch
PARALLEL_BATCHES=30              # Mais paralelismo
FAST_DISCOVERY_INTERVAL=2000     # 2 segundos
USER_DISCOVERY_BLOCKS=20000      # Mais blocos na descoberta
```

### Aumentar Limite de Memória Node.js
```bash
# No serviço systemd, adicionar:
ExecStart=/usr/bin/node --max-old-space-size=16384 ...
```

## 6. Monitoramento

### Verificar Status do Bot
```bash
# Logs em tempo real
journalctl -u liquidation-bot -f

# Status do serviço
systemctl status liquidation-bot

# Uso de recursos
htop
```

### Verificar Telegram
O bot envia notificações automáticas:
- Startup/Shutdown
- Oportunidades encontradas
- Execuções realizadas
- Estatísticas periódicas

### Verificar Latência
```bash
# Testar latência para Alchemy
time curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  https://arb-mainnet.g.alchemy.com/v2/SUA_API_KEY

# Testar latência para nó próprio
time curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://localhost:8547
```

## 7. Troubleshooting

### Bot não inicia
```bash
# Verificar logs
journalctl -u liquidation-bot -n 100

# Verificar .env
cat /opt/liquidation-bot/.env | grep -v PRIVATE

# Testar manualmente
cd /opt/liquidation-bot
npm run dev:liquidation:v2
```

### Muitos erros de RPC
```bash
# Verificar endpoints
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  https://arb1.arbitrum.io/rpc

# Considerar iniciar nó próprio
```

### Nó Arbitrum não sincroniza
```bash
# Verificar logs
docker logs arbitrum-nitro --tail 100

# Verificar espaço em disco
df -h

# Reiniciar nó
/opt/arbitrum/stop.sh
/opt/arbitrum/start.sh
```

### Sem oportunidades encontradas
- Liquidações são raras (talvez 1-5 por dia no Aave Arbitrum)
- Verifique se tem usuários suficientes: `wc -l data/active-users.json`
- Reduza MIN_PROFIT_USD para ver mais oportunidades
- Habilite outras chains (Base, Optimism)

## 8. Custos Estimados

| Recurso | Custo Mensal |
|---------|-------------|
| VPS (8 vCPU, 32GB) | $68.25 |
| Alchemy (Growth) | $49/mês ou Free |
| Nó próprio storage | +~$20 se precisar mais disco |
| **Total** | ~$70-120/mês |

## 9. Comandos Úteis

```bash
# Reiniciar bot
systemctl restart liquidation-bot

# Parar bot
systemctl stop liquidation-bot

# Ver últimas oportunidades
grep "OPPORTUNITY" /opt/liquidation-bot/logs/*.log | tail -20

# Atualizar código
cd /opt/liquidation-bot
git pull
npm install
systemctl restart liquidation-bot

# Backup de usuários
cp data/active-users.json data/active-users.backup.json

# Limpar logs antigos
find /opt/liquidation-bot/logs -name "*.log" -mtime +7 -delete
```

## 10. Segurança

- [ ] Use uma carteira dedicada para o bot
- [ ] Mantenha pouco ETH na carteira (apenas para gas)
- [ ] Configure firewall: `ufw allow 22/tcp && ufw enable`
- [ ] Não exponha RPC do nó próprio na internet
- [ ] Faça backup das chaves privadas offline
- [ ] Monitore a carteira para transações suspeitas
