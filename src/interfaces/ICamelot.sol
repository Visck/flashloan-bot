// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICamelotRouter
 * @author Bot de Arbitragem
 * @notice Interface para o Router do Camelot DEX na Arbitrum
 * @dev Camelot é a maior DEX nativa da Arbitrum
 *
 * Camelot usa um modelo AMM similar ao Uniswap V2, mas com algumas diferenças:
 * - Taxas dinâmicas por par
 * - Suporte a referral
 * - Pools direcionais (taxas diferentes para compra/venda)
 *
 * Documentação: https://docs.camelot.exchange/
 */
interface ICamelotRouter {
    /**
     * @notice Troca quantidade exata de tokens por outro token (suporta tokens com taxa)
     * @param amountIn Quantidade exata de tokens a vender
     * @param amountOutMin Quantidade mínima aceitável de tokens a receber
     * @param path Array de endereços definindo a rota
     * @param to Endereço que receberá os tokens de saída
     * @param referrer Endereço de referência (pode ser address(0))
     * @param deadline Timestamp Unix limite para a transação
     */
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        address referrer,
        uint256 deadline
    ) external;

    /**
     * @notice Versão que retorna amounts
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        address referrer,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Calcula quantidade de saída dado uma entrada
     * @param amountIn Quantidade de entrada
     * @param reserveIn Reserva do token de entrada no pool
     * @param reserveOut Reserva do token de saída no pool
     * @param feePercent Taxa do pool em porcentagem (base 100000)
     * @return amountOut Quantidade de saída esperada
     */
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 feePercent
    ) external pure returns (uint256 amountOut);

    /**
     * @notice Calcula quantidades ao longo de uma rota
     * @param amountIn Quantidade inicial
     * @param path Rota completa do swap
     * @return amounts Array de quantidades em cada etapa
     */
    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);

    /**
     * @notice Retorna o endereço da factory
     */
    function factory() external view returns (address);

    /**
     * @notice Retorna o endereço do WETH
     */
    function WETH() external view returns (address);
}

/**
 * @title ICamelotFactory
 * @notice Interface para a Factory do Camelot
 */
interface ICamelotFactory {
    /**
     * @notice Retorna o endereço do par para dois tokens
     * @param tokenA Primeiro token
     * @param tokenB Segundo token
     * @return pair Endereço do par
     */
    function getPair(
        address tokenA,
        address tokenB
    ) external view returns (address pair);

    /**
     * @notice Retorna informações de taxa do par
     */
    function feeInfo() external view returns (uint256 ownerFeeShare, address feeTo);
}

/**
 * @title ICamelotPair
 * @notice Interface para pares (pools) do Camelot
 */
interface ICamelotPair {
    /**
     * @notice Retorna as reservas atuais do par
     * @return reserve0 Reserva do token0
     * @return reserve1 Reserva do token1
     * @return token0FeePercent Taxa para swaps de token0 para token1
     * @return token1FeePercent Taxa para swaps de token1 para token0
     */
    function getReserves()
        external
        view
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint16 token0FeePercent,
            uint16 token1FeePercent
        );

    /**
     * @notice Retorna o token0 do par
     */
    function token0() external view returns (address);

    /**
     * @notice Retorna o token1 do par
     */
    function token1() external view returns (address);

    /**
     * @notice Retorna a taxa para swaps de token0 para token1
     */
    function token0FeePercent() external view returns (uint16);

    /**
     * @notice Retorna a taxa para swaps de token1 para token0
     */
    function token1FeePercent() external view returns (uint16);

    /**
     * @notice Retorna se as taxas estão ativas
     */
    function stableSwap() external view returns (bool);
}

// Nota: IBalancerVault movido para IBalancer.sol
// Nota: ICurvePool movido para ICurve.sol
