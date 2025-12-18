#!/bin/bash
# ==============================================================================
# Script de Instalação do Nó Arbitrum Nitro
# Para VPS com 8+ cores, 32GB RAM, 1TB+ disco
# Localização ideal: Ashburn, VA (US East) - perto do sequencer
# ==============================================================================

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "🚀 INSTALAÇÃO DO NÓ ARBITRUM NITRO"
echo "═══════════════════════════════════════════════════════════════"

# Variáveis
ARBITRUM_DIR="/opt/arbitrum"
DATA_DIR="/opt/arbitrum/data"
L1_RPC="${L1_RPC_URL:-https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY}"

# Verificar requisitos
echo ""
echo "📋 Verificando requisitos do sistema..."

# RAM
RAM_GB=$(free -g | awk '/^Mem:/{print $2}')
if [ "$RAM_GB" -lt 16 ]; then
    echo "⚠️  AVISO: Recomendado 32GB RAM, você tem ${RAM_GB}GB"
else
    echo "✅ RAM: ${RAM_GB}GB"
fi

# Disco
DISK_GB=$(df -BG / | awk 'NR==2 {print $4}' | tr -d 'G')
if [ "$DISK_GB" -lt 500 ]; then
    echo "⚠️  AVISO: Recomendado 1TB disco, você tem ${DISK_GB}GB livres"
else
    echo "✅ Disco: ${DISK_GB}GB livres"
fi

# CPU
CPU_CORES=$(nproc)
echo "✅ CPU: ${CPU_CORES} cores"

# ==============================================================================
# 1. Instalar dependências
# ==============================================================================
echo ""
echo "📦 Instalando dependências..."

sudo apt-get update
sudo apt-get install -y \
    docker.io \
    docker-compose \
    git \
    curl \
    wget \
    jq \
    htop \
    screen

# Adicionar usuário ao grupo docker
sudo usermod -aG docker $USER

# ==============================================================================
# 2. Criar diretórios
# ==============================================================================
echo ""
echo "📁 Criando diretórios..."

sudo mkdir -p $ARBITRUM_DIR
sudo mkdir -p $DATA_DIR
sudo chown -R $USER:$USER $ARBITRUM_DIR

# ==============================================================================
# 3. Criar docker-compose.yml para Nitro
# ==============================================================================
echo ""
echo "🐳 Configurando Docker Compose..."

cat > $ARBITRUM_DIR/docker-compose.yml << 'EOF'
version: '3.8'

services:
  nitro:
    image: offchainlabs/nitro-node:v3.1.0-beta.3
    container_name: arbitrum-nitro
    restart: unless-stopped
    ports:
      - "8547:8547"   # HTTP RPC
      - "8548:8548"   # WebSocket
      - "9642:9642"   # Metrics
    volumes:
      - ./data:/home/user/.arbitrum
    command:
      - --parent-chain.connection.url=${L1_RPC_URL}
      - --chain.id=42161
      - --chain.name=arb1
      - --http.addr=0.0.0.0
      - --http.port=8547
      - --http.vhosts=*
      - --http.corsdomain=*
      - --http.api=net,web3,eth,arb,debug
      - --ws.addr=0.0.0.0
      - --ws.port=8548
      - --ws.origins=*
      - --ws.api=net,web3,eth,arb,debug
      - --execution.caching.archive
      - --node.feed.input.url=wss://arb1.arbitrum.io/feed
      - --node.data-availability.enable=false
      - --metrics
      - --metrics.addr=0.0.0.0
      - --metrics.port=9642
    environment:
      - L1_RPC_URL=${L1_RPC_URL}
    logging:
      driver: "json-file"
      options:
        max-size: "100m"
        max-file: "5"
    deploy:
      resources:
        limits:
          memory: 28G
        reservations:
          memory: 16G

  # Opcional: Prometheus para métricas
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    restart: unless-stopped
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
    profiles:
      - monitoring

  # Opcional: Grafana para dashboards
  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - grafana_data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    profiles:
      - monitoring

volumes:
  prometheus_data:
  grafana_data:
EOF

# ==============================================================================
# 4. Criar arquivo .env
# ==============================================================================
echo ""
echo "🔧 Criando arquivo de configuração..."

cat > $ARBITRUM_DIR/.env << EOF
# RPC do Ethereum L1 (obrigatório)
# Use Alchemy, Infura ou seu próprio nó
L1_RPC_URL=${L1_RPC}

# Configurações opcionais
# NITRO_VERSION=v3.1.0-beta.3
EOF

# ==============================================================================
# 5. Criar prometheus.yml
# ==============================================================================
cat > $ARBITRUM_DIR/prometheus.yml << 'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'arbitrum-nitro'
    static_configs:
      - targets: ['nitro:9642']
        labels:
          instance: 'arbitrum-node'
EOF

# ==============================================================================
# 6. Criar script de inicialização
# ==============================================================================
cat > $ARBITRUM_DIR/start.sh << 'EOF'
#!/bin/bash
cd /opt/arbitrum
docker-compose up -d nitro
echo "Nó Arbitrum iniciado!"
echo "HTTP RPC: http://localhost:8547"
echo "WebSocket: ws://localhost:8548"
echo ""
echo "Para ver logs: docker logs -f arbitrum-nitro"
EOF
chmod +x $ARBITRUM_DIR/start.sh

# ==============================================================================
# 7. Criar script de parada
# ==============================================================================
cat > $ARBITRUM_DIR/stop.sh << 'EOF'
#!/bin/bash
cd /opt/arbitrum
docker-compose down
echo "Nó Arbitrum parado!"
EOF
chmod +x $ARBITRUM_DIR/stop.sh

# ==============================================================================
# 8. Criar script de status
# ==============================================================================
cat > $ARBITRUM_DIR/status.sh << 'EOF'
#!/bin/bash

echo "═══════════════════════════════════════════════════════════════"
echo "📊 STATUS DO NÓ ARBITRUM"
echo "═══════════════════════════════════════════════════════════════"

# Verificar se está rodando
if docker ps | grep -q arbitrum-nitro; then
    echo "✅ Container: RUNNING"
else
    echo "❌ Container: STOPPED"
    exit 1
fi

# Verificar sincronização
LOCAL_BLOCK=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    http://localhost:8547 | jq -r '.result' | xargs printf "%d")

REMOTE_BLOCK=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    https://arb1.arbitrum.io/rpc | jq -r '.result' | xargs printf "%d")

DIFF=$((REMOTE_BLOCK - LOCAL_BLOCK))

echo "📦 Local block:  $LOCAL_BLOCK"
echo "📦 Remote block: $REMOTE_BLOCK"
echo "📊 Blocks behind: $DIFF"

if [ "$DIFF" -lt 10 ]; then
    echo "✅ Status: SYNCED"
else
    echo "⏳ Status: SYNCING ($DIFF blocks behind)"
fi

# Verificar latência
START=$(date +%s%N)
curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    http://localhost:8547 > /dev/null
END=$(date +%s%N)
LATENCY=$(( (END - START) / 1000000 ))
echo "⚡ Latência local: ${LATENCY}ms"

# Uso de recursos
echo ""
echo "📊 Uso de recursos:"
docker stats arbitrum-nitro --no-stream --format "CPU: {{.CPUPerc}} | Memory: {{.MemUsage}}"

# Espaço em disco
echo ""
echo "💾 Espaço em disco:"
du -sh /opt/arbitrum/data 2>/dev/null || echo "Dados ainda não sincronizados"

echo "═══════════════════════════════════════════════════════════════"
EOF
chmod +x $ARBITRUM_DIR/status.sh

# ==============================================================================
# 9. Criar serviço systemd
# ==============================================================================
echo ""
echo "🔧 Criando serviço systemd..."

sudo tee /etc/systemd/system/arbitrum-node.service > /dev/null << EOF
[Unit]
Description=Arbitrum Nitro Node
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ARBITRUM_DIR
ExecStart=/usr/bin/docker-compose up -d nitro
ExecStop=/usr/bin/docker-compose down
User=$USER

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

# ==============================================================================
# 10. Instruções finais
# ==============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "✅ INSTALAÇÃO CONCLUÍDA!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "📝 PRÓXIMOS PASSOS:"
echo ""
echo "1. Configure o RPC L1 no arquivo .env:"
echo "   nano $ARBITRUM_DIR/.env"
echo "   L1_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/SUA_API_KEY"
echo ""
echo "2. Inicie o nó:"
echo "   $ARBITRUM_DIR/start.sh"
echo ""
echo "3. Monitore a sincronização:"
echo "   docker logs -f arbitrum-nitro"
echo ""
echo "4. Verifique status:"
echo "   $ARBITRUM_DIR/status.sh"
echo ""
echo "📌 ENDPOINTS LOCAIS (após sincronização):"
echo "   HTTP RPC:  http://localhost:8547"
echo "   WebSocket: ws://localhost:8548"
echo ""
echo "⏱️  TEMPO DE SINCRONIZAÇÃO:"
echo "   - Sincronização completa: ~12-24 horas"
echo "   - Com snapshot: ~2-4 horas"
echo ""
echo "💡 DICA: Para sincronização mais rápida, use um snapshot:"
echo "   https://snapshot.arbitrum.io/mainnet/nitro.tar"
echo ""
echo "═══════════════════════════════════════════════════════════════"
