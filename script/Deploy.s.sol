// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ============================================================================
 * SCRIPT DE DEPLOY - FLASH LOAN ARBITRAGE
 * ============================================================================
 *
 * Este script faz o deploy do contrato FlashLoanArbitrage na Arbitrum.
 *
 * COMO USAR:
 *
 * 1. Testnet (Arbitrum Sepolia):
 * ```bash
 * source .env
 * forge script script/Deploy.s.sol:DeployScript \
 *     --rpc-url $ARBITRUM_SEPOLIA_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     -vvvv
 * ```
 *
 * 2. Mainnet (Arbitrum One):
 * ```bash
 * source .env
 * forge script script/Deploy.s.sol:DeployScript \
 *     --rpc-url $ARBITRUM_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     -vvvv
 * ```
 *
 * IMPORTANTE:
 * - Certifique-se de ter ETH suficiente para gas
 * - Verifique as configurações antes de fazer deploy em mainnet
 * - Teste exaustivamente na testnet primeiro
 *
 * ============================================================================
 */

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/FlashLoanArbitrage.sol";

/**
 * @title DeployScript
 * @notice Script para deploy do contrato de arbitragem
 */
contract DeployScript is Script {
    // Endereço do contrato deployado
    FlashLoanArbitrage public arbitrage;

    /**
     * @notice Função principal de deploy
     */
    function run() external {
        // ========== CONFIGURAÇÃO ==========

        // Obtém a chave privada do ambiente
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("===========================================");
        console.log("DEPLOY - FLASH LOAN ARBITRAGE");
        console.log("===========================================");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("Block:", block.number);
        console.log("===========================================");

        // ========== VERIFICAÇÕES PRÉ-DEPLOY ==========

        // Verifica saldo do deployer
        uint256 balance = deployer.balance;
        console.log("Saldo do deployer:", balance / 1e18, "ETH");

        require(balance > 0.001 ether, "Saldo insuficiente para deploy");

        // Verifica chain ID (Arbitrum One = 42161, Arbitrum Sepolia = 421614)
        require(
            block.chainid == 42161 || block.chainid == 421614,
            "Chain ID invalido - use Arbitrum One ou Sepolia"
        );

        // ========== DEPLOY ==========

        vm.startBroadcast(deployerPrivateKey);

        // Deploy do contrato
        arbitrage = new FlashLoanArbitrage();

        vm.stopBroadcast();

        // ========== VERIFICAÇÃO PÓS-DEPLOY ==========

        console.log("===========================================");
        console.log("DEPLOY CONCLUIDO!");
        console.log("===========================================");
        console.log("Contrato:", address(arbitrage));
        console.log("Owner:", arbitrage.owner());
        console.log("===========================================");

        // Verifica que o owner está correto
        require(arbitrage.owner() == deployer, "Owner incorreto apos deploy");

        // Verifica endereços constantes
        console.log("");
        console.log("Verificando configuracao...");
        console.log("Aave Pool:", arbitrage.AAVE_POOL());
        console.log("Pool (interface):", arbitrage.POOL());

        // ========== INSTRUÇÕES PÓS-DEPLOY ==========

        console.log("");
        console.log("===========================================");
        console.log("PROXIMOS PASSOS:");
        console.log("===========================================");
        console.log("1. Atualize FLASH_LOAN_CONTRACT_ADDRESS no .env:");
        console.log("   FLASH_LOAN_CONTRACT_ADDRESS=", address(arbitrage));
        console.log("");
        console.log("2. Verifique o contrato no Arbiscan:");
        if (block.chainid == 42161) {
            console.log("   https://arbiscan.io/address/", address(arbitrage));
        } else {
            console.log("   https://sepolia.arbiscan.io/address/", address(arbitrage));
        }
        console.log("");
        console.log("3. Execute os testes para validar o deploy:");
        console.log("   forge test --fork-url $ARBITRUM_RPC_URL -vvv");
        console.log("");
        console.log("4. Inicie o bot:");
        console.log("   npm run dev");
        console.log("===========================================");
    }
}

/**
 * @title VerifyDeployment
 * @notice Script para verificar um deploy existente
 */
contract VerifyDeployment is Script {
    function run() external view {
        // Obtém endereço do contrato do ambiente
        address contractAddress = vm.envAddress("FLASH_LOAN_CONTRACT_ADDRESS");

        console.log("===========================================");
        console.log("VERIFICACAO DE DEPLOY");
        console.log("===========================================");
        console.log("Contrato:", contractAddress);

        // Cria instância do contrato
        FlashLoanArbitrage arbitrage = FlashLoanArbitrage(payable(contractAddress));

        // Verifica configurações
        console.log("Owner:", arbitrage.owner());
        console.log("Aave Pool:", arbitrage.AAVE_POOL());
        console.log("Chain ID:", block.chainid);

        // Verifica se o código existe
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(contractAddress)
        }
        console.log("Code size:", codeSize, "bytes");
        require(codeSize > 0, "Contrato nao encontrado!");

        console.log("===========================================");
        console.log("VERIFICACAO CONCLUIDA COM SUCESSO!");
        console.log("===========================================");
    }
}

/**
 * @title TestExecution
 * @notice Script para testar execução após deploy
 */
contract TestExecution is Script {
    function run() external {
        // Este script faz uma simulação de arbitragem para validar o deploy

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address contractAddress = vm.envAddress("FLASH_LOAN_CONTRACT_ADDRESS");

        FlashLoanArbitrage arbitrage = FlashLoanArbitrage(payable(contractAddress));

        console.log("===========================================");
        console.log("TESTE DE EXECUCAO");
        console.log("===========================================");

        // Configura parâmetros de teste
        FlashLoanArbitrage.ArbitrageParams memory params = FlashLoanArbitrage.ArbitrageParams({
            tokenBorrow: 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8, // USDC.e
            tokenTarget: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1, // WETH
            amountBorrow: 1000 * 1e6, // 1000 USDC
            dexBuy: FlashLoanArbitrage.DEX.UNISWAP_V3,
            dexSell: FlashLoanArbitrage.DEX.SUSHISWAP,
            uniswapFeeBuy: 500,
            uniswapFeeSell: 0,
            minProfit: 0
        });

        // Simula arbitragem (não executa, apenas calcula)
        console.log("Simulando arbitragem...");
        (uint256 expectedProfit, bool isProfitable) = arbitrage.simulateArbitrage(params);

        console.log("Lucro esperado:", expectedProfit);
        console.log("E lucrativo:", isProfitable);

        console.log("===========================================");
        console.log("TESTE CONCLUIDO!");
        console.log("===========================================");
    }
}
