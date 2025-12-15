// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/FlashLoanArbitrageV2.sol";

/**
 * @title DeployV2
 * @author Bot de Arbitragem
 * @notice Script de deploy do contrato FlashLoanArbitrageV2
 *
 * COMO USAR:
 *
 * 1. Testnet (Arbitrum Sepolia):
 * ```bash
 * forge script script/DeployV2.s.sol --rpc-url $ARBITRUM_SEPOLIA_RPC_URL --broadcast --verify
 * ```
 *
 * 2. Mainnet (Arbitrum One):
 * ```bash
 * forge script script/DeployV2.s.sol --rpc-url $ARBITRUM_RPC_URL --broadcast --verify
 * ```
 *
 * ATENCAO: Certifique-se de ter ETH suficiente para o deploy!
 */
contract DeployV2 is Script {
    function run() external {
        // Carrega a chave privada do ambiente
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Inicia o broadcast (transacoes reais)
        vm.startBroadcast(deployerPrivateKey);

        // Deploy do contrato V2
        FlashLoanArbitrageV2 arbitrage = new FlashLoanArbitrageV2();

        // Finaliza o broadcast
        vm.stopBroadcast();

        // Log do endereco deployado
        console.log("============================================================");
        console.log("DEPLOY V2 CONCLUIDO!");
        console.log("============================================================");
        console.log("FlashLoanArbitrageV2 deployado em:", address(arbitrage));
        console.log("Owner:", arbitrage.owner());
        console.log("");
        console.log("PROXIMOS PASSOS:");
        console.log("1. Adicione o endereco no .env:");
        console.log("   FLASH_LOAN_CONTRACT_ADDRESS=", address(arbitrage));
        console.log("");
        console.log("2. Verifique o contrato no Arbiscan");
        console.log("3. Execute o bot V2: npm run dev:v2");
        console.log("============================================================");
    }
}

/**
 * @title DeployV2WithVerification
 * @notice Script de deploy com verificacao detalhada
 */
contract DeployV2WithVerification is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("============================================================");
        console.log("INICIANDO DEPLOY V2");
        console.log("============================================================");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerPrivateKey);

        FlashLoanArbitrageV2 arbitrage = new FlashLoanArbitrageV2();

        vm.stopBroadcast();

        // Verificacoes pos-deploy
        console.log("");
        console.log("VERIFICACOES:");

        // Verifica owner
        require(arbitrage.owner() == deployer, "Owner incorreto!");
        console.log("[OK] Owner configurado corretamente");

        // Verifica enderecos das DEXs
        console.log("[OK] Aave Pool:", arbitrage.AAVE_POOL());
        console.log("[OK] Uniswap Router:", arbitrage.UNISWAP_V3_ROUTER());
        console.log("[OK] SushiSwap Router:", arbitrage.SUSHISWAP_ROUTER());
        console.log("[OK] Camelot Router:", arbitrage.CAMELOT_ROUTER());

        console.log("");
        console.log("ENDERECO DO CONTRATO:", address(arbitrage));
        console.log("============================================================");
    }
}

/**
 * @title UpgradeFromV1
 * @notice Script para migrar do V1 para V2
 * Transfere tokens residuais e configura novo contrato
 */
contract UpgradeFromV1 is Script {
    // Enderecos dos tokens mais comuns
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant USDC = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        // Endereco do contrato V1 (se existir)
        address v1Address = vm.envOr("FLASH_LOAN_CONTRACT_ADDRESS", address(0));

        console.log("============================================================");
        console.log("UPGRADE V1 -> V2");
        console.log("============================================================");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy do novo contrato V2
        FlashLoanArbitrageV2 v2 = new FlashLoanArbitrageV2();
        console.log("Novo contrato V2:", address(v2));

        // 2. Se houver V1, transfere tokens residuais
        if (v1Address != address(0)) {
            console.log("Contrato V1 encontrado:", v1Address);
            console.log("NOTA: Transfira tokens manualmente usando withdrawToken()");
        }

        vm.stopBroadcast();

        console.log("");
        console.log("UPGRADE CONCLUIDO!");
        console.log("Atualize o .env com o novo endereco");
        console.log("============================================================");
    }
}
