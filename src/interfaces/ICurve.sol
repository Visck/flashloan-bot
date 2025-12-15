// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICurvePool
 * @notice Interface para pools do Curve Finance na Arbitrum
 * @dev Otimizado para stablecoins com baixo slippage
 *
 * Pools principais no Arbitrum:
 * - 2pool (USDC/USDT): 0x7f90122BF0700F9E7e1F688fe926940E8839F353
 * - tricrypto (USDT/WBTC/WETH): 0x960ea3e3C7FB317332d990873d354E18d7645590
 * - fraxbp (FRAX/USDC): 0xC9B8a3FDECB9D5b218d02555a8Baf332E5B740d5
 *
 * Documentação: https://docs.curve.fi/
 */
interface ICurvePool {
    /**
     * @notice Executa swap entre tokens do pool (versão int128)
     * @param i Índice do token de entrada
     * @param j Índice do token de saída
     * @param dx Quantidade de entrada
     * @param min_dy Quantidade mínima de saída
     * @return Quantidade recebida
     */
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256);

    /**
     * @notice Executa swap entre tokens do pool (versão uint256)
     * @dev Alguns pools usam uint256 em vez de int128
     */
    function exchange(
        uint256 i,
        uint256 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256);

    /**
     * @notice Calcula quantidade de saída esperada (versão int128)
     * @param i Índice do token de entrada
     * @param j Índice do token de saída
     * @param dx Quantidade de entrada
     * @return Quantidade de saída esperada
     */
    function get_dy(
        int128 i,
        int128 j,
        uint256 dx
    ) external view returns (uint256);

    /**
     * @notice Calcula quantidade de saída esperada (versão uint256)
     */
    function get_dy(
        uint256 i,
        uint256 j,
        uint256 dx
    ) external view returns (uint256);

    /**
     * @notice Retorna o endereço de um token pelo índice
     * @param i Índice do token (0, 1, 2...)
     * @return Endereço do token
     */
    function coins(uint256 i) external view returns (address);

    /**
     * @notice Retorna o saldo de um token pelo índice
     * @param i Índice do token
     * @return Saldo do token no pool
     */
    function balances(uint256 i) external view returns (uint256);

    /**
     * @notice Retorna o número de tokens no pool
     */
    function N_COINS() external view returns (uint256);

    /**
     * @notice Retorna a taxa do pool
     */
    function fee() external view returns (uint256);

    /**
     * @notice Retorna o amplification coefficient (A)
     */
    function A() external view returns (uint256);

    /**
     * @notice Retorna o virtual price do LP token
     */
    function get_virtual_price() external view returns (uint256);
}

/**
 * @title ICurvePoolUnderlying
 * @notice Interface para pools que usam underlying tokens (metapools)
 */
interface ICurvePoolUnderlying {
    /**
     * @notice Swap usando underlying tokens
     */
    function exchange_underlying(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256);

    /**
     * @notice Calcula quantidade de saída para underlying
     */
    function get_dy_underlying(
        int128 i,
        int128 j,
        uint256 dx
    ) external view returns (uint256);

    /**
     * @notice Retorna underlying coin pelo índice
     */
    function underlying_coins(uint256 i) external view returns (address);
}

/**
 * @title ICurveRegistry
 * @notice Interface para o Registry do Curve
 * @dev Registry Address (Arbitrum): 0x0000000022D53366457F9d5E68Ec105046FC4383
 */
interface ICurveRegistry {
    /**
     * @notice Encontra o melhor pool para um par de tokens
     */
    function find_pool_for_coins(
        address _from,
        address _to
    ) external view returns (address);

    /**
     * @notice Encontra pool com índice específico
     */
    function find_pool_for_coins(
        address _from,
        address _to,
        uint256 i
    ) external view returns (address);

    /**
     * @notice Retorna índices dos tokens em um pool
     */
    function get_coin_indices(
        address _pool,
        address _from,
        address _to
    ) external view returns (int128, int128, bool);

    /**
     * @notice Retorna o número de pools
     */
    function pool_count() external view returns (uint256);

    /**
     * @notice Retorna pool pelo índice
     */
    function pool_list(uint256 i) external view returns (address);
}

/**
 * @title ICurveRouter
 * @notice Interface para o Router do Curve (swaps cross-pool)
 * @dev Router Address (Arbitrum): 0xF0d4c12A5768D806021F80a262B4d39d26C58b8D
 */
interface ICurveRouter {
    /**
     * @notice Executa swap através de múltiplos pools
     * @param _route Array de endereços [token, pool, token, pool, ...]
     * @param _swap_params Parâmetros para cada swap
     * @param _amount Quantidade de entrada
     * @param _expected Quantidade mínima esperada
     * @return Quantidade recebida
     */
    function exchange(
        address[11] calldata _route,
        uint256[5][5] calldata _swap_params,
        uint256 _amount,
        uint256 _expected
    ) external returns (uint256);

    /**
     * @notice Calcula quantidade de saída para uma rota
     */
    function get_dy(
        address[11] calldata _route,
        uint256[5][5] calldata _swap_params,
        uint256 _amount
    ) external view returns (uint256);

    /**
     * @notice Calcula quantidade de saída simples
     */
    function get_exchange_amount(
        address _pool,
        address _from,
        address _to,
        uint256 _amount
    ) external view returns (uint256);
}

/**
 * @title ICurve3Pool
 * @notice Interface específica para o 3pool/2pool (stablecoins)
 */
interface ICurve2Pool {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256);

    function get_dy(
        int128 i,
        int128 j,
        uint256 dx
    ) external view returns (uint256);

    function coins(uint256 i) external view returns (address);
    function balances(uint256 i) external view returns (uint256);
}
