#!/bin/bash

# =============================================================================
# SCRIPT DE DEPLOY - LIQUIDATION BOT
# =============================================================================
# Execute este script no VPS após fazer upload do projeto
# =============================================================================

set -e

echo "🚀 Iniciando deploy do Liquidation Bot..."

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Diretório do projeto (ajuste conforme necessário)
PROJECT_DIR="/root/liquidation-bot"

# -----------------------------------------------------------------------------
# 1. Verificar Node.js
# -----------------------------------------------------------------------------
echo -e "${YELLOW}[1/6] Verificando Node.js...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js não encontrado. Instalando...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# -----------------------------------------------------------------------------
# 2. Instalar PM2 globalmente
# -----------------------------------------------------------------------------
echo -e "${YELLOW}[2/6] Verificando PM2...${NC}"
if ! command -v pm2 &> /dev/null; then
    echo "Instalando PM2..."
    npm install -g pm2
fi
echo -e "${GREEN}✓ PM2 instalado${NC}"

# -----------------------------------------------------------------------------
# 3. Ir para diretório do projeto
# -----------------------------------------------------------------------------
echo -e "${YELLOW}[3/6] Acessando diretório do projeto...${NC}"
cd $PROJECT_DIR
echo -e "${GREEN}✓ Diretório: $(pwd)${NC}"

# -----------------------------------------------------------------------------
# 4. Instalar dependências
# -----------------------------------------------------------------------------
echo -e "${YELLOW}[4/6] Instalando dependências...${NC}"
npm install --production=false
echo -e "${GREEN}✓ Dependências instaladas${NC}"

# -----------------------------------------------------------------------------
# 5. Verificar arquivo .env
# -----------------------------------------------------------------------------
echo -e "${YELLOW}[5/6] Verificando configuração...${NC}"
if [ ! -f ".env" ]; then
    echo -e "${RED}ERRO: Arquivo .env não encontrado!${NC}"
    echo "Copie o arquivo .env.example para .env e configure:"
    echo "  cp .env.example .env"
    echo "  nano .env"
    exit 1
fi

# Verificar variáveis essenciais
if ! grep -q "ARBITRUM_RPC_URL" .env || grep -q "YOUR_API_KEY" .env; then
    echo -e "${YELLOW}⚠️  Verifique se ARBITRUM_RPC_URL está configurado corretamente${NC}"
fi

if ! grep -q "PRIVATE_KEY" .env || grep -q "your_private_key" .env; then
    echo -e "${YELLOW}⚠️  Verifique se PRIVATE_KEY está configurado corretamente${NC}"
fi

echo -e "${GREEN}✓ Configuração verificada${NC}"

# -----------------------------------------------------------------------------
# 6. Criar diretório de logs
# -----------------------------------------------------------------------------
mkdir -p logs

# -----------------------------------------------------------------------------
# 7. Iniciar com PM2
# -----------------------------------------------------------------------------
echo -e "${YELLOW}[6/6] Iniciando bot com PM2...${NC}"

# Para processo existente (se houver)
pm2 stop liquidation-bot 2>/dev/null || true
pm2 delete liquidation-bot 2>/dev/null || true

# Inicia o bot
pm2 start ecosystem.config.js

# Salva configuração para reiniciar após reboot
pm2 save

# Configura startup automático
pm2 startup

echo ""
echo -e "${GREEN}=============================================${NC}"
echo -e "${GREEN}✅ DEPLOY CONCLUÍDO COM SUCESSO!${NC}"
echo -e "${GREEN}=============================================${NC}"
echo ""
echo "Comandos úteis:"
echo "  pm2 status              - Ver status do bot"
echo "  pm2 logs liquidation-bot - Ver logs em tempo real"
echo "  pm2 restart liquidation-bot - Reiniciar bot"
echo "  pm2 stop liquidation-bot   - Parar bot"
echo ""
echo "Logs salvos em:"
echo "  ./logs/pm2-out.log"
echo "  ./logs/pm2-error.log"
echo ""
