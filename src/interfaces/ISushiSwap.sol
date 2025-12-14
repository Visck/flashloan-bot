// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISushiSwapRouter
 * @author Bot de Arbitragem
 * @notice Interface para o Router do SushiSwap (baseado no Uniswap V2)
 * @dev SushiSwap na Arbitrum usa o modelo AMM clássico x*y=k
 *
 * DIFERENÇAS ENTRE UNISWAP V2/SUSHISWAP E V3:
 * - V2: Liquidez distribuída uniformemente em todo o range de preços
 * - V2: Mais simples de usar, menos eficiente em capital
 * - V2: Taxa fixa de 0.3%
 * - V3: Liquidez concentrada, mais complexo, mais eficiente
 *
 * O SushiSwap é um fork do Uniswap V2, então as interfaces são compatíveis
 */
interface ISushiSwapRouter {
    /**
     * @notice Troca quantidade exata de tokens por outro token
     * @dev Usado quando você sabe exatamente quanto quer vender
     *
     * @param amountIn Quantidade exata de tokens a vender
     * @param amountOutMin Quantidade mínima aceitável de tokens a receber
     * @param path Array de endereços definindo a rota: [tokenIn, ..., tokenOut]
     * @param to Endereço que receberá os tokens de saída
     * @param deadline Timestamp Unix limite para a transação
     * @return amounts Array com as quantidades em cada etapa da rota
     *
     * EXEMPLO:
     * Para trocar 1 WETH por USDC:
     * - amountIn: 1e18
     * - amountOutMin: quantidade mínima de USDC esperada (com slippage)
     * - path: [WETH, USDC]
     * - to: seu endereço
     * - deadline: block.timestamp + 300 (5 minutos)
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Troca tokens por quantidade exata de outro token
     * @dev Usado quando você sabe exatamente quanto quer comprar
     *
     * @param amountOut Quantidade exata de tokens a receber
     * @param amountInMax Quantidade máxima de tokens a gastar
     * @param path Rota do swap
     * @param to Destinatário
     * @param deadline Prazo limite
     * @return amounts Quantidades em cada etapa
     */
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Troca ETH exato por tokens
     * @dev Envia ETH junto com a transação (msg.value)
     */
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    /**
     * @notice Troca tokens por ETH exato
     */
    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Troca tokens exatos por ETH
     */
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice Troca ETH por quantidade exata de tokens
     */
    function swapETHForExactTokens(
        uint256 amountOut,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    /**
     * @notice Calcula quantidade de saída dado uma entrada
     * @dev Fórmula: amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
     *
     * @param amountIn Quantidade de entrada
     * @param reserveIn Reserva do token de entrada no pool
     * @param reserveOut Reserva do token de saída no pool
     * @return amountOut Quantidade de saída esperada
     *
     * NOTA: A taxa de 0.3% está embutida na fórmula (997/1000)
     */
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256 amountOut);

    /**
     * @notice Calcula quantidade de entrada necessária para uma saída desejada
     * @param amountOut Quantidade de saída desejada
     * @param reserveIn Reserva do token de entrada
     * @param reserveOut Reserva do token de saída
     * @return amountIn Quantidade de entrada necessária
     */
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256 amountIn);

    /**
     * @notice Calcula quantidades ao longo de uma rota multi-hop
     * @param amountIn Quantidade inicial
     * @param path Rota completa do swap
     * @return amounts Array de quantidades em cada etapa
     *
     * EXEMPLO:
     * Se path = [WETH, USDC, ARB] e amountIn = 1 WETH:
     * amounts[0] = 1 WETH
     * amounts[1] = USDC recebido após primeiro swap
     * amounts[2] = ARB recebido após segundo swap
     */
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    /**
     * @notice Calcula quantidades de entrada necessárias ao longo de uma rota
     * @param amountOut Quantidade final desejada
     * @param path Rota do swap
     * @return amounts Array de quantidades necessárias em cada etapa
     */
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    /**
     * @notice Retorna o endereço da factory
     * @return Endereço do contrato Factory
     */
    function factory() external view returns (address);

    /**
     * @notice Retorna o endereço do WETH
     * @return Endereço do Wrapped ETH
     */
    function WETH() external view returns (address);
}

/**
 * @title ISushiSwapFactory
 * @notice Interface para a Factory do SushiSwap
 * @dev Usada para encontrar pares e criar novos
 */
interface ISushiSwapFactory {
    /**
     * @notice Retorna o endereço do par para dois tokens
     * @param tokenA Primeiro token
     * @param tokenB Segundo token
     * @return pair Endereço do par (address(0) se não existir)
     *
     * NOTA: A ordem dos tokens não importa, o resultado será o mesmo
     */
    function getPair(address tokenA, address tokenB) external view returns (address pair);

    /**
     * @notice Cria um novo par de tokens
     * @param tokenA Primeiro token
     * @param tokenB Segundo token
     * @return pair Endereço do par criado
     */
    function createPair(address tokenA, address tokenB) external returns (address pair);

    /**
     * @notice Retorna o número total de pares
     * @return Quantidade de pares criados
     */
    function allPairsLength() external view returns (uint256);

    /**
     * @notice Retorna o endereço do par por índice
     * @param index Índice do par
     * @return Endereço do par
     */
    function allPairs(uint256 index) external view returns (address);
}

/**
 * @title ISushiSwapPair
 * @notice Interface para pares (pools) do SushiSwap
 * @dev Cada par é um contrato ERC20 que representa liquidez
 */
interface ISushiSwapPair {
    /**
     * @notice Retorna as reservas atuais do par
     * @return reserve0 Reserva do token0
     * @return reserve1 Reserva do token1
     * @return blockTimestampLast Timestamp da última atualização
     *
     * FÓRMULA DO AMM:
     * reserve0 * reserve1 = k (constante)
     * Após um swap: (reserve0 + amountIn) * (reserve1 - amountOut) = k
     */
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

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
     * @notice Calcula o preço cumulativo do token0
     * @dev Usado para calcular TWAP (Time-Weighted Average Price)
     */
    function price0CumulativeLast() external view returns (uint256);

    /**
     * @notice Calcula o preço cumulativo do token1
     */
    function price1CumulativeLast() external view returns (uint256);

    /**
     * @notice Retorna o produto k da última interação de liquidez
     */
    function kLast() external view returns (uint256);

    /**
     * @notice Executa um swap de baixo nível
     * @dev Usado internamente pelo router, requer transferência prévia
     *
     * @param amount0Out Quantidade de token0 a receber
     * @param amount1Out Quantidade de token1 a receber
     * @param to Destinatário
     * @param data Dados para callback (flash swap se não vazio)
     *
     * IMPORTANTE: Você deve transferir tokens para o par ANTES de chamar swap
     * O par verifica se o invariante k foi mantido
     */
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;

    /**
     * @notice Sincroniza as reservas com os saldos reais
     * @dev Chame se alguém enviou tokens diretamente para o par
     */
    function sync() external;

    /**
     * @notice Força atualização das reservas
     */
    function skim(address to) external;
}
