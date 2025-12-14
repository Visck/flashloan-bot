# 🤖 Bot de Arbitragem com Flash Loan - Arbitrum

Bot automatizado para arbitragem entre DEXs na rede Arbitrum usando Flash Loans do Aave V3.

## 📋 Índice

- [Visão Geral](#visão-geral)
- [Arquitetura](#arquitetura)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Deploy](#deploy)
- [Execução](#execução)
- [Testes](#testes)
- [Segurança](#segurança)
- [Aviso de Risco](#aviso-de-risco)

## 🎯 Visão Geral

Este projeto implementa um bot de arbitragem que:

1. **Monitora preços** em tempo real no Uniswap V3 e SushiSwap
2. **Identifica oportunidades** de arbitragem entre as DEXs
3. **Executa arbitragem** usando Flash Loans do Aave V3 (sem necessidade de capital inicial)
4. **Calcula lucratividade** considerando taxas de gas e slippage

### Como funciona o Flash Loan

```
┌─────────────────────────────────────────────────────────────────┐
│                     FLASH LOAN ARBITRAGE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Empresta USDC do Aave (sem colateral)                      │
│     └─► 100,000 USDC                                           │
│                                                                 │
│  2. Compra WETH no Uniswap (preço mais baixo)                  │
│     └─► 100,000 USDC → ~50 WETH                                │
│                                                                 │
│  3. Vende WETH no SushiSwap (preço mais alto)                  │
│     └─► ~50 WETH → ~100,500 USDC                               │
│                                                                 │
│  4. Paga empréstimo + taxa ao Aave                             │
│     └─► 100,000 + 50 USDC (0.05%)                              │
│                                                                 │
│  5. Lucro!                                                      │
│     └─► ~450 USDC (menos gas)                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 🏗️ Arquitetura

```
newflash/
├── src/                          # Contratos Solidity
│   ├── FlashLoanArbitrage.sol   # Contrato principal
│   └── interfaces/              # Interfaces dos protocolos
│       ├── IAaveV3Pool.sol
│       ├── IUniswapV3.sol
│       ├── ISushiSwap.sol
│       └── IERC20.sol
├── bot/                          # Bot TypeScript
│   ├── index.ts                 # Entrada principal
│   ├── config.ts                # Configurações
│   ├── priceService.ts          # Serviço de preços
│   └── logger.ts                # Sistema de logs
├── test/                         # Testes Foundry
│   └── FlashLoanArbitrage.t.sol
├── script/                       # Scripts de deploy
│   └── Deploy.s.sol
├── foundry.toml                  # Configuração Foundry
├── package.json                  # Dependências Node.js
└── .env.example                  # Template de variáveis
```

## 📦 Requisitos

- **Node.js** >= 18.0.0
- **Foundry** (forge, cast, anvil)
- **RPC da Arbitrum** (Alchemy, Infura, ou QuickNode)
- **ETH na Arbitrum** (para gas)

### Instalando Foundry

```bash
# Linux/Mac
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Windows (PowerShell)
# Siga: https://book.getfoundry.sh/getting-started/installation
```

## 🚀 Instalação

```bash
# 1. Clone ou entre no diretório
cd newflash

# 2. Instale dependências do Foundry
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts
forge install aave/aave-v3-core

# 3. Instale dependências Node.js
npm install

# 4. Copie o arquivo de ambiente
cp .env.example .env

# 5. Compile os contratos
forge build

# 6. Compile o TypeScript
npm run build
```

## ⚙️ Configuração

Edite o arquivo `.env` com suas configurações:

```env
# CRÍTICO - Chave privada
PRIVATE_KEY=0xsua_chave_privada_aqui

# RPC URLs (obtenha em Alchemy/Infura)
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/SUA_API_KEY
ARBITRUM_SEPOLIA_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/SUA_API_KEY

# Após deploy, adicione o endereço do contrato
FLASH_LOAN_CONTRACT_ADDRESS=

# Configurações do bot
SIMULATION_MODE=true          # Comece em simulação!
MIN_PROFIT_USD=5              # Lucro mínimo em USD
MAX_GAS_PRICE_GWEI=1          # Gas máximo
```

## 📤 Deploy

### 1. Testnet (Arbitrum Sepolia)

```bash
# Carrega variáveis de ambiente
source .env

# Deploy na testnet
forge script script/Deploy.s.sol:DeployScript \
    --rpc-url $ARBITRUM_SEPOLIA_RPC_URL \
    --broadcast \
    --verify \
    -vvvv
```

### 2. Mainnet (Arbitrum One)

```bash
# ⚠️ CUIDADO: Isso usa dinheiro real!
forge script script/Deploy.s.sol:DeployScript \
    --rpc-url $ARBITRUM_RPC_URL \
    --broadcast \
    --verify \
    -vvvv
```

Após o deploy, atualize o `.env` com o endereço do contrato.

## 🏃 Execução

### Modo Simulação (Recomendado para começar)

```bash
# Certifique-se que SIMULATION_MODE=true no .env
npm run dev
```

O bot vai monitorar preços e reportar oportunidades sem executar transações.

### Modo Produção

```bash
# Mude SIMULATION_MODE=false no .env
npm run dev

# Ou para produção
npm run build
npm start
```

## 🧪 Testes

### Testes Unitários

```bash
forge test -vvv
```

### Testes com Fork (requer RPC)

```bash
forge test --fork-url $ARBITRUM_RPC_URL -vvv
```

### Teste Específico

```bash
forge test --match-test testFork_SimulateArbitrage -vvv
```

### Coverage

```bash
forge coverage
```

## 🔒 Segurança

O contrato implementa várias medidas de segurança:

1. **Ownable** - Apenas o owner pode executar arbitragem e retirar fundos
2. **ReentrancyGuard** - Proteção contra ataques de reentrância
3. **Verificação de Initiator** - Flash loan só aceita chamadas do próprio contrato
4. **Verificação de Caller** - `executeOperation` só aceita chamadas do Aave Pool
5. **MinProfit** - Proteção contra execução sem lucro mínimo

### Auditoria

Este código NÃO foi auditado profissionalmente. Use por sua conta e risco.

## ⚠️ Aviso de Risco

**IMPORTANTE: Leia com atenção antes de usar!**

1. **Risco Financeiro**: Arbitragem é uma atividade de alto risco. Você pode perder dinheiro.

2. **Gas Fees**: Mesmo transações que falham consomem gas. Transações de arbitragem são complexas e podem custar $1-10 em gas.

3. **Competição**: Existem bots profissionais com infraestrutura avançada (Flashbots, private mempools). Competir é difícil.

4. **Slippage**: Preços mudam rapidamente. O lucro simulado pode não se materializar.

5. **Bugs**: Apesar dos testes, podem existir bugs. Nunca invista mais do que pode perder.

6. **Frontrunning**: Suas transações podem ser detectadas e frontrunned por outros bots.

### Recomendações

- ✅ Comece sempre em modo simulação
- ✅ Teste exaustivamente na testnet
- ✅ Comece com valores pequenos
- ✅ Monitore constantemente
- ❌ Nunca invista dinheiro que não pode perder
- ❌ Não use chaves privadas de carteiras com fundos significativos

## 📜 Licença

MIT License - Use por sua conta e risco.

## 🤝 Contribuições

Contribuições são bem-vindas! Por favor:

1. Fork o projeto
2. Crie uma branch para sua feature
3. Faça commit das mudanças
4. Abra um Pull Request

---

**Desenvolvido para fins educacionais. Use com responsabilidade.**
