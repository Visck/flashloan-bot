// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IBalancerVault
 * @notice Interface para o Vault do Balancer V2 na Arbitrum
 * @dev Balancer usa um único vault para todos os pools
 *
 * Vault Address (Arbitrum): 0xBA12222222228d8Ba445958a75a0704d566BF2C8
 *
 * Documentação: https://docs.balancer.fi/
 */
interface IBalancerVault {
    enum SwapKind { GIVEN_IN, GIVEN_OUT }

    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }

    struct BatchSwapStep {
        bytes32 poolId;
        uint256 assetInIndex;
        uint256 assetOutIndex;
        uint256 amount;
        bytes userData;
    }

    /**
     * @notice Executa um swap único
     * @param singleSwap Parâmetros do swap
     * @param funds Configuração de fundos
     * @param limit Limite de slippage (min out para GIVEN_IN, max in para GIVEN_OUT)
     * @param deadline Timestamp limite
     * @return amountCalculated Quantidade calculada
     */
    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256 amountCalculated);

    /**
     * @notice Executa múltiplos swaps em sequência
     * @param kind Tipo de swap (GIVEN_IN ou GIVEN_OUT)
     * @param swaps Array de steps de swap
     * @param assets Array de endereços de tokens
     * @param funds Configuração de fundos
     * @param limits Limites para cada asset
     * @param deadline Timestamp limite
     * @return assetDeltas Mudanças nos saldos
     */
    function batchSwap(
        SwapKind kind,
        BatchSwapStep[] memory swaps,
        address[] memory assets,
        FundManagement memory funds,
        int256[] memory limits,
        uint256 deadline
    ) external payable returns (int256[] memory assetDeltas);

    /**
     * @notice Retorna informações do pool
     * @param poolId ID do pool
     * @return tokens Array de tokens no pool
     * @return balances Saldos de cada token
     * @return lastChangeBlock Último bloco com mudança
     */
    function getPoolTokens(bytes32 poolId)
        external
        view
        returns (
            address[] memory tokens,
            uint256[] memory balances,
            uint256 lastChangeBlock
        );

    /**
     * @notice Retorna o endereço do pool a partir do ID
     */
    function getPool(bytes32 poolId) external view returns (address, uint8);

    /**
     * @notice Query para simular swap (não executa)
     */
    function querySwap(
        SingleSwap memory singleSwap,
        FundManagement memory funds
    ) external returns (uint256);

    /**
     * @notice Query para simular batch swap (não executa)
     */
    function queryBatchSwap(
        SwapKind kind,
        BatchSwapStep[] memory swaps,
        address[] memory assets,
        FundManagement memory funds
    ) external returns (int256[] memory assetDeltas);
}

/**
 * @title IBalancerPool
 * @notice Interface base para pools do Balancer
 */
interface IBalancerPool {
    function getPoolId() external view returns (bytes32);
    function getVault() external view returns (address);
    function getSwapFeePercentage() external view returns (uint256);
}

/**
 * @title IBalancerWeightedPool
 * @notice Interface para Weighted Pools do Balancer
 */
interface IBalancerWeightedPool is IBalancerPool {
    function getNormalizedWeights() external view returns (uint256[] memory);
}
