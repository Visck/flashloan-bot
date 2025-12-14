// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISwapRouter
 * @author Bot de Arbitragem
 * @notice Interface para o SwapRouter do Uniswap V3
 * @dev Usado para executar swaps em pools do Uniswap V3
 *
 * Documentação oficial: https://docs.uniswap.org/contracts/v3/reference/periphery/SwapRouter
 *
 * CONCEITOS DO UNISWAP V3:
 * - Liquidity concentrada: LPs podem concentrar liquidez em faixas de preço específicas
 * - Múltiplas taxas: Pools com 0.01%, 0.05%, 0.3% e 1% de taxa
 * - Tick-based: Preços são discretizados em "ticks"
 */
interface ISwapRouter {
    /**
     * @notice Parâmetros para swap exato de entrada (você sabe quanto quer vender)
     * @dev Use quando você tem uma quantidade específica do token de entrada
     */
    struct ExactInputSingleParams {
        address tokenIn; // Token que você está vendendo
        address tokenOut; // Token que você está comprando
        uint24 fee; // Taxa do pool (500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
        address recipient; // Endereço que receberá os tokens de saída
        uint256 deadline; // Timestamp limite para a transação
        uint256 amountIn; // Quantidade exata do token de entrada
        uint256 amountOutMinimum; // Quantidade mínima aceitável de saída (proteção contra slippage)
        uint160 sqrtPriceLimitX96; // Limite de preço para o swap (0 = sem limite)
    }

    /**
     * @notice Executa um swap exato de entrada em um único pool
     * @param params Estrutura com todos os parâmetros do swap
     * @return amountOut Quantidade recebida do token de saída
     *
     * EXEMPLO DE USO:
     * Para trocar 1 WETH por USDC:
     * - tokenIn: endereço do WETH
     * - tokenOut: endereço do USDC
     * - fee: 500 (pool de 0.05%)
     * - amountIn: 1e18 (1 WETH em wei)
     * - amountOutMinimum: quantidade mínima de USDC esperada
     */
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    /**
     * @notice Parâmetros para swap exato de entrada com múltiplos hops
     * @dev Use para rotear através de múltiplos pools
     */
    struct ExactInputParams {
        bytes path; // Caminho codificado: token0, fee0, token1, fee1, token2...
        address recipient; // Quem recebe os tokens
        uint256 deadline; // Prazo limite
        uint256 amountIn; // Quantidade de entrada
        uint256 amountOutMinimum; // Mínimo de saída
    }

    /**
     * @notice Executa swap exato de entrada através de múltiplos pools
     * @param params Parâmetros incluindo o caminho codificado
     * @return amountOut Quantidade final recebida
     *
     * NOTA SOBRE O PATH:
     * O path é codificado como: abi.encodePacked(tokenA, feeAB, tokenB, feeBC, tokenC)
     * Exemplo: WETH -> USDC -> ARB seria:
     * abi.encodePacked(WETH, uint24(500), USDC, uint24(3000), ARB)
     */
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);

    /**
     * @notice Parâmetros para swap com saída exata (você sabe quanto quer comprar)
     */
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut; // Quantidade EXATA que você quer receber
        uint256 amountInMaximum; // Máximo que você aceita gastar
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Executa swap com quantidade exata de saída
     * @param params Parâmetros do swap
     * @return amountIn Quantidade gasta do token de entrada
     */
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);

    /**
     * @notice Parâmetros para swap de saída exata com múltiplos hops
     */
    struct ExactOutputParams {
        bytes path; // Caminho REVERSO: tokenOut, fee, ..., tokenIn
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    /**
     * @notice Executa swap de saída exata através de múltiplos pools
     */
    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
}

/**
 * @title IQuoterV2
 * @notice Interface para simular swaps e obter cotações sem executar
 * @dev Usado pelo bot para calcular preços antes de executar arbitragem
 *
 * IMPORTANTE: Estas funções são view mas consomem muito gas
 * Use apenas para simulação off-chain ou em calls estáticas
 */
interface IQuoterV2 {
    /**
     * @notice Parâmetros para cotação de swap único
     */
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Simula um swap e retorna a quantidade de saída esperada
     * @param params Parâmetros da cotação
     * @return amountOut Quantidade que seria recebida
     * @return sqrtPriceX96After Preço após o swap
     * @return initializedTicksCrossed Número de ticks cruzados
     * @return gasEstimate Estimativa de gas para o swap
     *
     * NOTA: Esta função reverte intencionalmente para retornar os valores
     * Use eth_call para obter os resultados
     */
    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);

    /**
     * @notice Simula swap com múltiplos hops
     * @param path Caminho codificado do swap
     * @param amountIn Quantidade de entrada
     * @return amountOut Quantidade de saída esperada
     * @return sqrtPriceX96AfterList Preços após cada hop
     * @return initializedTicksCrossedList Ticks cruzados em cada hop
     * @return gasEstimate Estimativa total de gas
     */
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (
            uint256 amountOut,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );

    /**
     * @notice Parâmetros para cotação de saída exata
     */
    struct QuoteExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amount;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Simula swap de saída exata
     */
    function quoteExactOutputSingle(QuoteExactOutputSingleParams memory params)
        external
        returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);

    /**
     * @notice Simula swap de saída exata com múltiplos hops
     */
    function quoteExactOutput(bytes memory path, uint256 amountOut)
        external
        returns (
            uint256 amountIn,
            uint160[] memory sqrtPriceX96AfterList,
            uint32[] memory initializedTicksCrossedList,
            uint256 gasEstimate
        );
}

/**
 * @title IUniswapV3Pool
 * @notice Interface para interagir diretamente com pools do Uniswap V3
 * @dev Usado para obter informações de preço e liquidez
 */
interface IUniswapV3Pool {
    /**
     * @notice Retorna o estado atual do pool
     * @return sqrtPriceX96 Raiz quadrada do preço atual (formato Q64.96)
     * @return tick Tick atual do pool
     * @return observationIndex Índice da última observação
     * @return observationCardinality Cardinalidade atual das observações
     * @return observationCardinalityNext Próxima cardinalidade
     * @return feeProtocol Taxa do protocolo
     * @return unlocked Se o pool está desbloqueado para operações
     *
     * SOBRE sqrtPriceX96:
     * - Representa sqrt(preço) * 2^96
     * - Para converter: preço = (sqrtPriceX96 / 2^96)^2
     * - Leva em conta os decimais dos tokens
     */
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /**
     * @notice Retorna o token0 do par
     * @return Endereço do token0 (sempre o de endereço menor)
     */
    function token0() external view returns (address);

    /**
     * @notice Retorna o token1 do par
     * @return Endereço do token1
     */
    function token1() external view returns (address);

    /**
     * @notice Retorna a taxa do pool
     * @return Taxa em centésimos de basis point (500 = 0.05%)
     */
    function fee() external view returns (uint24);

    /**
     * @notice Retorna a liquidez ativa atual
     * @return Liquidez total na faixa de preço atual
     */
    function liquidity() external view returns (uint128);

    /**
     * @notice Retorna o espaçamento de ticks do pool
     * @return Espaçamento mínimo entre ticks (depende da taxa)
     */
    function tickSpacing() external view returns (int24);
}

/**
 * @title IUniswapV3Factory
 * @notice Interface para a fábrica de pools do Uniswap V3
 * @dev Usado para encontrar endereços de pools existentes
 */
interface IUniswapV3Factory {
    /**
     * @notice Retorna o endereço de um pool para um par de tokens e taxa
     * @param tokenA Primeiro token do par
     * @param tokenB Segundo token do par
     * @param fee Taxa do pool
     * @return pool Endereço do pool (address(0) se não existir)
     */
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);

    /**
     * @notice Cria um novo pool
     * @param tokenA Primeiro token
     * @param tokenB Segundo token
     * @param fee Taxa do pool
     * @return pool Endereço do pool criado
     */
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}
