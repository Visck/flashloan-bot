#!/bin/bash
# ==============================================================================
# Script de Deploy - Liquidation Bot V2
# Executa no VPS para instalar/atualizar o bot
# ==============================================================================

set -e

# Configurações
BOT_DIR="/opt/liquidation-bot"
SERVICE_NAME="liquidation-bot"
NODE_VERSION="20"

echo "═══════════════════════════════════════════════════════════════"
echo "🚀 DEPLOY - LIQUIDATION BOT V2"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Verificar se é root
if [ "$EUID" -ne 0 ]; then
    echo "❌ Execute como root: sudo ./deploy-to-vps.sh"
    exit 1
fi

# ==============================================================================
# 1. Instalar Node.js se necessário
# ==============================================================================
echo "📦 Verificando Node.js..."

if ! command -v node &> /dev/null; then
    echo "   Instalando Node.js $NODE_VERSION..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt install -y nodejs
fi

NODE_VER=$(node --version)
echo "   ✅ Node.js: $NODE_VER"

# ==============================================================================
# 2. Instalar dependências do sistema
# ==============================================================================
echo ""
echo "📦 Instalando dependências do sistema..."
apt install -y git build-essential

# ==============================================================================
# 3. Criar diretórios
# ==============================================================================
echo ""
echo "📁 Configurando diretórios..."
mkdir -p $BOT_DIR/data
mkdir -p $BOT_DIR/logs

# ==============================================================================
# 4. Copiar arquivos (se executado via SCP)
# ==============================================================================
if [ -f "./package.json" ]; then
    echo ""
    echo "📂 Copiando arquivos do projeto..."
    cp -r ./* $BOT_DIR/
fi

# ==============================================================================
# 5. Instalar dependências do projeto
# ==============================================================================
echo ""
echo "📦 Instalando dependências do projeto..."
cd $BOT_DIR
npm install --production=false

# ==============================================================================
# 6. Verificar .env
# ==============================================================================
echo ""
echo "🔧 Verificando configuração..."
if [ ! -f "$BOT_DIR/.env" ]; then
    echo "   ⚠️  Arquivo .env não encontrado!"
    echo "   Criando a partir do exemplo..."
    cp $BOT_DIR/.env.example $BOT_DIR/.env
    echo ""
    echo "   🔴 IMPORTANTE: Edite o arquivo .env com suas configurações:"
    echo "      nano $BOT_DIR/.env"
    echo ""
fi

# ==============================================================================
# 7. Instalar serviço systemd
# ==============================================================================
echo ""
echo "⚙️  Configurando serviço systemd..."

cp $BOT_DIR/scripts/liquidation-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable $SERVICE_NAME

echo "   ✅ Serviço configurado"

# ==============================================================================
# 8. Buscar usuários (opcional)
# ==============================================================================
echo ""
read -p "🔍 Deseja buscar todos os usuários agora? (pode demorar alguns minutos) [y/N]: " fetch_users

if [[ "$fetch_users" =~ ^[Yy]$ ]]; then
    echo "   Buscando usuários..."
    cd $BOT_DIR
    npm run fetch:users:all || echo "   ⚠️ Falha ao buscar usuários (pode ser feito depois)"
fi

# ==============================================================================
# 9. Iniciar bot
# ==============================================================================
echo ""
read -p "🚀 Deseja iniciar o bot agora? [y/N]: " start_bot

if [[ "$start_bot" =~ ^[Yy]$ ]]; then
    systemctl start $SERVICE_NAME
    sleep 3
    systemctl status $SERVICE_NAME --no-pager
fi

# ==============================================================================
# 10. Instruções finais
# ==============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "✅ DEPLOY CONCLUÍDO!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "📌 COMANDOS ÚTEIS:"
echo ""
echo "   # Gerenciar o bot"
echo "   systemctl start $SERVICE_NAME     # Iniciar"
echo "   systemctl stop $SERVICE_NAME      # Parar"
echo "   systemctl restart $SERVICE_NAME   # Reiniciar"
echo "   systemctl status $SERVICE_NAME    # Status"
echo ""
echo "   # Ver logs"
echo "   journalctl -u $SERVICE_NAME -f    # Logs em tempo real"
echo "   journalctl -u $SERVICE_NAME -n 100 # Últimas 100 linhas"
echo ""
echo "   # Editar configuração"
echo "   nano $BOT_DIR/.env"
echo ""
echo "   # Buscar mais usuários"
echo "   cd $BOT_DIR && npm run fetch:users:all"
echo ""
echo "═══════════════════════════════════════════════════════════════"
