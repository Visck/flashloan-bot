// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FlashLoanArbitrage
 * @author Bot de Arbitragem - Arbitrum
 * @notice Contrato para executar arbitragem usando Flash Loans do Aave V3
 * @dev Integra Aave V3, Uniswap V3 e SushiSwap na rede Arbitrum
 *
 * ============================================================================
 * CONCEITO DE ARBITRAGEM COM FLASH LOAN
 * ============================================================================
 *
 * Flash Loan Arbitragem é uma estratégia que:
 * 1. Empresta uma grande quantidade de tokens SEM colateral (flash loan)
 * 2. Compra um ativo em uma DEX onde está mais barato
 * 3. Vende o ativo em outra DEX onde está mais caro
 * 4. Paga o empréstimo + taxa
 * 5. Mantém o lucro
 *
 * EXEMPLO PRÁTICO:
 * - WETH custa 2000 USDC no Uniswap
 * - WETH custa 2010 USDC no SushiSwap
 * - Diferença de 10 USDC por WETH (0.5%)
 *
 * Operação:
 * 1. Flash loan de 100,000 USDC do Aave
 * 2. Compra ~50 WETH no Uniswap por 100,000 USDC
 * 3. Vende 50 WETH no SushiSwap por ~100,500 USDC
 * 4. Paga 100,000 + 50 USDC (taxa 0.05%) ao Aave
 * 5. Lucro: ~450 USDC (menos gas)
 *
 * RISCOS:
 * - Slippage pode eliminar o lucro
 * - Frontrunning por bots MEV
 * - Preços podem mudar entre simulação e execução
 * - Bugs no contrato podem resultar em perda total
 *
 * ============================================================================
 */

import "./interfaces/IAaveV3Pool.sol";
import "./interfaces/IUniswapV3.sol";
import "./interfaces/ISushiSwap.sol";
import "./interfaces/IERC20.sol";

/**
 * @title ReentrancyGuard
 * @notice Proteção contra ataques de reentrância
 * @dev Previne que funções sejam chamadas recursivamente
 *
 * ATAQUE DE REENTRÂNCIA:
 * Um contrato malicioso pode chamar de volta seu contrato antes
 * da primeira execução terminar, manipulando o estado.
 *
 * Este modifier garante que a função complete antes de poder ser chamada novamente.
 */
abstract contract ReentrancyGuard {
    // Estado do lock: 1 = não bloqueado, 2 = bloqueado
    // Usamos 1 e 2 ao invés de 0 e 1 para economizar gas (SSTORE de 0->1 é mais caro)
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status;

    constructor() {
        _status = _NOT_ENTERED;
    }

    /**
     * @notice Modifier que previne reentrância
     * @dev Bloqueia a função durante sua execução
     */
    modifier nonReentrant() {
        // Verifica se já está em execução
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");

        // Bloqueia
        _status = _ENTERED;

        // Executa a função
        _;

        // Desbloqueia
        _status = _NOT_ENTERED;
    }
}

/**
 * @title Ownable
 * @notice Controle de acesso básico com um único proprietário
 * @dev Permite restringir funções críticas ao dono do contrato
 */
abstract contract Ownable {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        _transferOwnership(msg.sender);
    }

    /**
     * @notice Retorna o endereço do proprietário atual
     */
    function owner() public view virtual returns (address) {
        return _owner;
    }

    /**
     * @notice Modifier que restringe acesso ao proprietário
     */
    modifier onlyOwner() {
        require(owner() == msg.sender, "Ownable: caller is not the owner");
        _;
    }

    /**
     * @notice Renuncia à propriedade do contrato
     * @dev CUIDADO: Isso torna o contrato sem dono permanentemente!
     */
    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    /**
     * @notice Transfere a propriedade para um novo endereço
     * @param newOwner Novo proprietário
     */
    function transferOwnership(address newOwner) public virtual onlyOwner {
        require(newOwner != address(0), "Ownable: new owner is the zero address");
        _transferOwnership(newOwner);
    }

    /**
     * @notice Função interna para transferir propriedade
     */
    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

/**
 * @title FlashLoanArbitrage
 * @notice Contrato principal de arbitragem
 */
contract FlashLoanArbitrage is IFlashLoanSimpleReceiver, ReentrancyGuard, Ownable {
    // ============================================================================
    // CONSTANTES - Endereços na Arbitrum Mainnet
    // ============================================================================

    /// @notice Endereço do Pool do Aave V3 na Arbitrum
    /// @dev Fonte: https://docs.aave.com/developers/deployed-contracts/v3-mainnet/arbitrum
    address public constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    /// @notice Endereço do PoolAddressesProvider do Aave V3
    address public constant AAVE_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;

    /// @notice Endereço do SwapRouter do Uniswap V3 na Arbitrum
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    /// @notice Endereço do QuoterV2 do Uniswap V3
    address public constant UNISWAP_V3_QUOTER = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;

    /// @notice Endereço do Router do SushiSwap na Arbitrum
    address public constant SUSHISWAP_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;

    /// @notice Endereço do WETH na Arbitrum
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    /// @notice Endereço do USDC na Arbitrum (USDC.e - bridged)
    address public constant USDC = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;

    /// @notice Endereço do USDC nativo na Arbitrum
    address public constant USDC_NATIVE = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    /// @notice Endereço do ARB token
    address public constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;

    // ============================================================================
    // ENUMS E STRUCTS
    // ============================================================================

    /**
     * @notice Identificador das DEXs suportadas
     */
    enum DEX {
        UNISWAP_V3, // 0
        SUSHISWAP // 1

    }

    /**
     * @notice Parâmetros para uma operação de arbitragem
     * @dev Codificado em bytes e passado para o flash loan
     */
    struct ArbitrageParams {
        address tokenBorrow; // Token emprestado via flash loan
        address tokenTarget; // Token intermediário (comprar/vender)
        uint256 amountBorrow; // Quantidade emprestada
        DEX dexBuy; // DEX para comprar o tokenTarget
        DEX dexSell; // DEX para vender o tokenTarget
        uint24 uniswapFeeBuy; // Taxa do pool Uniswap para compra (se aplicável)
        uint24 uniswapFeeSell; // Taxa do pool Uniswap para venda (se aplicável)
        uint256 minProfit; // Lucro mínimo esperado (proteção contra slippage)
    }

    // ============================================================================
    // EVENTOS
    // ============================================================================

    /// @notice Emitido quando uma arbitragem é executada com sucesso
    event ArbitrageExecuted(
        address indexed tokenBorrow,
        address indexed tokenTarget,
        uint256 amountBorrowed,
        uint256 profit,
        uint256 timestamp
    );

    /// @notice Emitido quando tokens são resgatados pelo owner
    event TokensWithdrawn(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitido quando ETH é resgatado pelo owner
    event ETHWithdrawn(address indexed to, uint256 amount);

    // ============================================================================
    // ERROS CUSTOMIZADOS (mais eficientes em gas que require com string)
    // ============================================================================

    /// @notice Flash loan só pode ser iniciado pelo próprio contrato
    error UnauthorizedInitiator();

    /// @notice Callback só pode ser chamado pelo Pool do Aave
    error UnauthorizedCaller();

    /// @notice Lucro insuficiente após a arbitragem
    error InsufficientProfit(uint256 expected, uint256 actual);

    /// @notice DEX não suportada
    error UnsupportedDEX();

    /// @notice Quantidade inválida
    error InvalidAmount();

    /// @notice Falha no swap
    error SwapFailed();

    // ============================================================================
    // FUNÇÕES PÚBLICAS DE LEITURA
    // ============================================================================

    /**
     * @notice Retorna o endereço do Pool do Aave (requerido pela interface)
     */
    function POOL() external pure override returns (address) {
        return AAVE_POOL;
    }

    /**
     * @notice Retorna o endereço do AddressesProvider (requerido pela interface)
     */
    function ADDRESSES_PROVIDER() external pure override returns (address) {
        return AAVE_ADDRESSES_PROVIDER;
    }

    // ============================================================================
    // FUNÇÃO PRINCIPAL DE ARBITRAGEM
    // ============================================================================

    /**
     * @notice Inicia uma operação de arbitragem usando flash loan
     * @dev Só pode ser chamada pelo owner para prevenir uso não autorizado
     *
     * @param params Parâmetros da arbitragem codificados em struct
     *
     * FLUXO DE EXECUÇÃO:
     * 1. Esta função inicia o flash loan no Aave
     * 2. Aave transfere os tokens para este contrato
     * 3. Aave chama executeOperation() neste contrato
     * 4. executeOperation() executa a arbitragem
     * 5. Este contrato aprova Aave para retirar amount + fee
     * 6. Aave retira os fundos
     * 7. Se houver lucro, fica no contrato para o owner retirar
     */
    function executeArbitrage(ArbitrageParams calldata params) external onlyOwner nonReentrant {
        // Validação básica
        if (params.amountBorrow == 0) revert InvalidAmount();

        // Codifica os parâmetros para passar ao callback
        bytes memory encodedParams = abi.encode(params);

        // Inicia o flash loan
        // O Aave vai chamar executeOperation() após transferir os tokens
        IAaveV3Pool(AAVE_POOL).flashLoanSimple(
            address(this), // receiver: este contrato
            params.tokenBorrow, // asset: token a emprestar
            params.amountBorrow, // amount: quantidade
            encodedParams, // params: dados para o callback
            0 // referralCode: não usado
        );
    }

    // ============================================================================
    // CALLBACK DO FLASH LOAN
    // ============================================================================

    /**
     * @notice Callback chamado pelo Aave após transferir os fundos
     * @dev Esta função executa a lógica de arbitragem
     *
     * @param asset Token emprestado
     * @param amount Quantidade emprestada
     * @param premium Taxa a pagar (0.05% no Aave V3)
     * @param initiator Endereço que iniciou o flash loan
     * @param params Parâmetros codificados da arbitragem
     * @return true se a operação foi bem sucedida
     *
     * IMPORTANTE:
     * - Esta função DEVE aprovar o Pool para retirar (amount + premium)
     * - Se falhar, toda a transação reverte e nenhum fundo é perdido
     * - O lucro fica no contrato após a execução
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // ========== VERIFICAÇÕES DE SEGURANÇA ==========

        // Apenas o Pool do Aave pode chamar esta função
        if (msg.sender != AAVE_POOL) revert UnauthorizedCaller();

        // Apenas este contrato pode iniciar o flash loan
        if (initiator != address(this)) revert UnauthorizedInitiator();

        // ========== DECODIFICA PARÂMETROS ==========

        ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageParams));

        // ========== EXECUTA A ARBITRAGEM ==========

        // Saldo inicial do token emprestado
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));

        // Passo 1: Compra tokenTarget na primeira DEX
        uint256 amountBought = _swap(
            arbParams.dexBuy,
            arbParams.tokenBorrow,
            arbParams.tokenTarget,
            amount,
            0, // amountOutMin = 0, confiamos no minProfit no final
            arbParams.uniswapFeeBuy
        );

        // Passo 2: Vende tokenTarget na segunda DEX
        uint256 amountReceived = _swap(
            arbParams.dexSell,
            arbParams.tokenTarget,
            arbParams.tokenBorrow,
            amountBought,
            0,
            arbParams.uniswapFeeSell
        );

        // ========== VERIFICA LUCRO ==========

        // Quantidade total a pagar ao Aave
        uint256 amountOwed = amount + premium;

        // Saldo atual
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));

        // Calcula o lucro real
        // balanceAfter deve ser >= balanceBefore - amount (o que tinhamos) + amountReceived
        // Simplificando: lucro = balanceAfter - amountOwed - (balanceBefore - amount)
        // Como começamos com 0 de balance extra: lucro = balanceAfter - amountOwed

        if (balanceAfter < amountOwed) {
            // Não temos nem para pagar o empréstimo - isso vai reverter
            revert InsufficientProfit(arbParams.minProfit, 0);
        }

        uint256 profit = balanceAfter - amountOwed;

        // Verifica se atingiu o lucro mínimo
        if (profit < arbParams.minProfit) {
            revert InsufficientProfit(arbParams.minProfit, profit);
        }

        // ========== APROVA O AAVE PARA RETIRAR ==========

        // O Aave vai chamar transferFrom após esta função retornar
        IERC20(asset).approve(AAVE_POOL, amountOwed);

        // ========== EMITE EVENTO ==========

        emit ArbitrageExecuted(arbParams.tokenBorrow, arbParams.tokenTarget, amount, profit, block.timestamp);

        return true;
    }

    // ============================================================================
    // FUNÇÕES INTERNAS DE SWAP
    // ============================================================================

    /**
     * @notice Executa um swap na DEX especificada
     * @dev Rota para a implementação correta baseado na DEX
     *
     * @param dex DEX a usar (Uniswap V3 ou SushiSwap)
     * @param tokenIn Token de entrada
     * @param tokenOut Token de saída
     * @param amountIn Quantidade de entrada
     * @param amountOutMin Quantidade mínima de saída
     * @param uniswapFee Taxa do pool (apenas para Uniswap V3)
     * @return amountOut Quantidade recebida
     */
    function _swap(
        DEX dex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 uniswapFee
    ) internal returns (uint256 amountOut) {
        if (dex == DEX.UNISWAP_V3) {
            return _swapUniswapV3(tokenIn, tokenOut, amountIn, amountOutMin, uniswapFee);
        } else if (dex == DEX.SUSHISWAP) {
            return _swapSushiSwap(tokenIn, tokenOut, amountIn, amountOutMin);
        } else {
            revert UnsupportedDEX();
        }
    }

    /**
     * @notice Executa swap no Uniswap V3
     * @dev Usa exactInputSingle para swap direto
     *
     * @param tokenIn Token de entrada
     * @param tokenOut Token de saída
     * @param amountIn Quantidade de entrada
     * @param amountOutMin Mínimo de saída
     * @param fee Taxa do pool (500, 3000, ou 10000)
     * @return amountOut Quantidade recebida
     */
    function _swapUniswapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        // Aprova o router para gastar nossos tokens
        IERC20(tokenIn).approve(UNISWAP_V3_ROUTER, amountIn);

        // Configura os parâmetros do swap
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp, // Executa imediatamente
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0 // Sem limite de preço
        });

        // Executa o swap
        amountOut = ISwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(params);

        if (amountOut == 0) revert SwapFailed();
    }

    /**
     * @notice Executa swap no SushiSwap
     * @dev Usa swapExactTokensForTokens (estilo Uniswap V2)
     *
     * @param tokenIn Token de entrada
     * @param tokenOut Token de saída
     * @param amountIn Quantidade de entrada
     * @param amountOutMin Mínimo de saída
     * @return amountOut Quantidade recebida
     */
    function _swapSushiSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin)
        internal
        returns (uint256 amountOut)
    {
        // Aprova o router
        IERC20(tokenIn).approve(SUSHISWAP_ROUTER, amountIn);

        // Define a rota (swap direto)
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        // Executa o swap
        uint256[] memory amounts = ISushiSwapRouter(SUSHISWAP_ROUTER).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            block.timestamp // deadline
        );

        // O último elemento é a quantidade final recebida
        amountOut = amounts[amounts.length - 1];

        if (amountOut == 0) revert SwapFailed();
    }

    // ============================================================================
    // FUNÇÕES DE SIMULAÇÃO (VIEW) - Úteis para o bot
    // ============================================================================

    /**
     * @notice Simula uma arbitragem e retorna o lucro estimado
     * @dev Chame via eth_call para não gastar gas
     *
     * @param params Parâmetros da arbitragem
     * @return expectedProfit Lucro esperado
     * @return isProfitable Se a operação é lucrativa
     *
     * NOTA: Esta é uma estimativa. O valor real pode variar devido a:
     * - Mudanças de preço entre blocos
     * - Slippage em swaps grandes
     * - Frontrunning
     */
    function simulateArbitrage(ArbitrageParams calldata params)
        external
        view
        returns (uint256 expectedProfit, bool isProfitable)
    {
        // Calcula a taxa do flash loan
        uint256 flashLoanFee = (params.amountBorrow * 5) / 10000; // 0.05%

        // Simula compra no primeira DEX
        uint256 amountAfterBuy = _getAmountOut(
            params.dexBuy, params.tokenBorrow, params.tokenTarget, params.amountBorrow, params.uniswapFeeBuy
        );

        // Simula venda na segunda DEX
        uint256 amountAfterSell =
            _getAmountOut(params.dexSell, params.tokenTarget, params.tokenBorrow, amountAfterBuy, params.uniswapFeeSell);

        // Calcula lucro
        uint256 totalCost = params.amountBorrow + flashLoanFee;

        if (amountAfterSell > totalCost) {
            expectedProfit = amountAfterSell - totalCost;
            isProfitable = expectedProfit >= params.minProfit;
        } else {
            expectedProfit = 0;
            isProfitable = false;
        }
    }

    /**
     * @notice Obtém cotação de swap sem executar
     * @dev Usa getAmountsOut do SushiSwap ou QuoterV2 do Uniswap
     */
    function _getAmountOut(DEX dex, address tokenIn, address tokenOut, uint256 amountIn, uint24 uniswapFee)
        internal
        view
        returns (uint256 amountOut)
    {
        if (dex == DEX.SUSHISWAP) {
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;

            try ISushiSwapRouter(SUSHISWAP_ROUTER).getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
                amountOut = amounts[1];
            } catch {
                amountOut = 0;
            }
        } else {
            // Para Uniswap V3, usamos uma estimativa baseada no pool
            // Nota: QuoterV2 não é view, então usamos uma aproximação
            // Em produção, chame o Quoter via eth_call
            amountOut = (amountIn * 997) / 1000; // Estimativa conservadora
        }
    }

    // ============================================================================
    // FUNÇÕES DE ADMINISTRAÇÃO - Apenas Owner
    // ============================================================================

    /**
     * @notice Retira tokens ERC20 do contrato
     * @dev Usado para retirar lucros ou tokens enviados por engano
     *
     * @param token Endereço do token a retirar
     * @param to Endereço destinatário
     * @param amount Quantidade a retirar (0 = tudo)
     *
     * SEGURANÇA:
     * - Apenas o owner pode chamar
     * - Protegido contra reentrância
     * - Emite evento para rastreamento
     */
    function withdrawToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid recipient");

        uint256 balance = IERC20(token).balanceOf(address(this));

        // Se amount é 0, retira tudo
        uint256 withdrawAmount = amount == 0 ? balance : amount;

        require(withdrawAmount <= balance, "Insufficient balance");

        IERC20(token).transfer(to, withdrawAmount);

        emit TokensWithdrawn(token, to, withdrawAmount);
    }

    /**
     * @notice Retira ETH do contrato
     * @dev Pode receber ETH se alguém enviar por engano
     *
     * @param to Destinatário
     * @param amount Quantidade (0 = tudo)
     */
    function withdrawETH(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid recipient");

        uint256 balance = address(this).balance;
        uint256 withdrawAmount = amount == 0 ? balance : amount;

        require(withdrawAmount <= balance, "Insufficient balance");

        (bool success,) = to.call{value: withdrawAmount}("");
        require(success, "ETH transfer failed");

        emit ETHWithdrawn(to, withdrawAmount);
    }

    /**
     * @notice Aprova um token para um spender específico
     * @dev Útil para preparar aprovações antes de operações
     *
     * @param token Token a aprovar
     * @param spender Endereço autorizado
     * @param amount Quantidade a aprovar
     */
    function approveToken(address token, address spender, uint256 amount) external onlyOwner {
        IERC20(token).approve(spender, amount);
    }

    /**
     * @notice Executa uma chamada arbitrária
     * @dev PERIGOSO - use apenas se souber o que está fazendo
     *      Útil para recuperar fundos presos ou interagir com novos contratos
     *
     * @param target Contrato alvo
     * @param data Dados da chamada
     * @return result Resultado da chamada
     */
    function executeCall(address target, bytes calldata data)
        external
        onlyOwner
        nonReentrant
        returns (bytes memory result)
    {
        require(target != address(0), "Invalid target");

        (bool success, bytes memory returnData) = target.call(data);
        require(success, "Call failed");

        return returnData;
    }

    // ============================================================================
    // FUNÇÕES DE RECEBIMENTO
    // ============================================================================

    /**
     * @notice Permite receber ETH
     */
    receive() external payable {}

    /**
     * @notice Fallback para chamadas não reconhecidas
     */
    fallback() external payable {}
}
