// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FlashLoanArbitrageV2
 * @author Bot de Arbitragem - Arbitrum
 * @notice Contrato otimizado para arbitragem com múltiplas DEXs
 * @dev Versão 2.0 com suporte a:
 *      - Uniswap V3
 *      - SushiSwap
 *      - Camelot (maior DEX nativa Arbitrum)
 *      - Arbitragem triangular
 *      - Otimizações de gas
 */

import "./interfaces/IAaveV3Pool.sol";
import "./interfaces/IUniswapV3.sol";
import "./interfaces/ISushiSwap.sol";
import "./interfaces/ICamelot.sol";
import "./interfaces/IBalancer.sol";
import "./interfaces/ICurve.sol";
import "./interfaces/IERC20.sol";

/**
 * @title FlashLoanArbitrageV2
 * @notice Contrato principal de arbitragem V2
 */
contract FlashLoanArbitrageV2 is IFlashLoanSimpleReceiver {
    // ============================================================================
    // CONSTANTES - ENDEREÇOS NA ARBITRUM MAINNET
    // ============================================================================

    /// @notice Aave V3
    address public constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant AAVE_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;

    /// @notice Uniswap V3
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant UNISWAP_V3_QUOTER = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;

    /// @notice SushiSwap
    address public constant SUSHISWAP_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;

    /// @notice Camelot
    address public constant CAMELOT_ROUTER = 0xc873fEcbd354f5A56E00E710B90EF4201db2448d;

    /// @notice Balancer V2
    address public constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    /// @notice Curve Finance
    address public constant CURVE_2POOL = 0x7f90122BF0700F9E7e1F688fe926940E8839F353; // USDC/USDT
    address public constant CURVE_TRICRYPTO = 0x960ea3e3C7FB317332d990873d354E18d7645590; // USDT/WBTC/WETH

    /// @notice Tokens comuns
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant USDC = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address public constant USDC_NATIVE = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address public constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address public constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;
    address public constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
    address public constant DAI = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address public constant GMX = 0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a;
    address public constant MAGIC = 0x539bdE0d7Dbd336b79148AA742883198BBF60342;

    // ============================================================================
    // ESTADO
    // ============================================================================

    address private _owner;
    uint256 private _locked = 1;

    // ============================================================================
    // ENUMS
    // ============================================================================

    enum DEX {
        UNISWAP_V3,    // 0
        SUSHISWAP,     // 1
        CAMELOT,       // 2
        BALANCER,      // 3
        CURVE_2POOL,   // 4 (USDC/USDT)
        CURVE_TRICRYPTO // 5 (USDT/WBTC/WETH)
    }

    // ============================================================================
    // STRUCTS
    // ============================================================================

    /// @notice Parâmetros para arbitragem simples (2 swaps)
    struct ArbitrageParams {
        address tokenBorrow;
        address tokenTarget;
        uint256 amountBorrow;
        DEX dexBuy;
        DEX dexSell;
        uint24 uniswapFeeBuy;
        uint24 uniswapFeeSell;
        uint256 minProfit;
    }

    /// @notice Parâmetros para arbitragem triangular (3 swaps)
    struct TriangularParams {
        address tokenBorrow;      // Token emprestado (ex: USDC)
        address tokenMiddle;      // Token intermediário (ex: WETH)
        address tokenTarget;      // Token final antes de voltar (ex: ARB)
        uint256 amountBorrow;
        DEX dex1;                 // DEX para swap 1: borrow -> middle
        DEX dex2;                 // DEX para swap 2: middle -> target
        DEX dex3;                 // DEX para swap 3: target -> borrow
        uint24 fee1;
        uint24 fee2;
        uint24 fee3;
        uint256 minProfit;
    }

    // ============================================================================
    // EVENTOS
    // ============================================================================

    event ArbitrageExecuted(
        address indexed tokenBorrow,
        address indexed tokenTarget,
        uint256 amountBorrowed,
        uint256 profit,
        DEX dexBuy,
        DEX dexSell
    );

    event TriangularArbitrageExecuted(
        address indexed tokenBorrow,
        address tokenMiddle,
        address tokenTarget,
        uint256 amountBorrowed,
        uint256 profit
    );

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ============================================================================
    // ERROS
    // ============================================================================

    error Unauthorized();
    error InsufficientProfit(uint256 expected, uint256 actual);
    error InvalidAmount();
    error SwapFailed();
    error Reentrancy();

    // ============================================================================
    // MODIFIERS
    // ============================================================================

    modifier onlyOwner() {
        if (msg.sender != _owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ============================================================================
    // CONSTRUCTOR
    // ============================================================================

    constructor() {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ============================================================================
    // FUNÇÕES PÚBLICAS DE LEITURA
    // ============================================================================

    function owner() public view returns (address) {
        return _owner;
    }

    function POOL() external pure override returns (address) {
        return AAVE_POOL;
    }

    function ADDRESSES_PROVIDER() external pure override returns (address) {
        return AAVE_ADDRESSES_PROVIDER;
    }

    // ============================================================================
    // ARBITRAGEM SIMPLES (2 SWAPS)
    // ============================================================================

    function executeArbitrage(ArbitrageParams calldata params) external onlyOwner nonReentrant {
        if (params.amountBorrow == 0) revert InvalidAmount();

        bytes memory encodedParams = abi.encode(params, false); // false = não é triangular

        IAaveV3Pool(AAVE_POOL).flashLoanSimple(
            address(this),
            params.tokenBorrow,
            params.amountBorrow,
            encodedParams,
            0
        );
    }

    // ============================================================================
    // ARBITRAGEM TRIANGULAR (3 SWAPS)
    // ============================================================================

    function executeTriangularArbitrage(TriangularParams calldata params) external onlyOwner nonReentrant {
        if (params.amountBorrow == 0) revert InvalidAmount();

        bytes memory encodedParams = abi.encode(params, true); // true = é triangular

        IAaveV3Pool(AAVE_POOL).flashLoanSimple(
            address(this),
            params.tokenBorrow,
            params.amountBorrow,
            encodedParams,
            0
        );
    }

    // ============================================================================
    // CALLBACK DO FLASH LOAN
    // ============================================================================

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != AAVE_POOL) revert Unauthorized();
        if (initiator != address(this)) revert Unauthorized();

        // Decodifica para verificar se é triangular
        (, bool isTriangular) = abi.decode(params, (bytes, bool));

        uint256 profit;
        if (isTriangular) {
            profit = _executeTriangular(params, amount);
        } else {
            profit = _executeSimple(params, amount);
        }

        uint256 amountOwed = amount + premium;

        // Verifica lucro
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance < amountOwed) revert InsufficientProfit(amountOwed, balance);

        // Aprova Aave
        IERC20(asset).approve(AAVE_POOL, amountOwed);

        return true;
    }

    // ============================================================================
    // EXECUÇÃO INTERNA - SIMPLES
    // ============================================================================

    function _executeSimple(bytes calldata params, uint256 amount) internal returns (uint256) {
        (ArbitrageParams memory arbParams,) = abi.decode(params, (ArbitrageParams, bool));

        // Swap 1: tokenBorrow -> tokenTarget
        uint256 amountBought = _swap(
            arbParams.dexBuy,
            arbParams.tokenBorrow,
            arbParams.tokenTarget,
            amount,
            0,
            arbParams.uniswapFeeBuy
        );

        // Swap 2: tokenTarget -> tokenBorrow
        uint256 amountReceived = _swap(
            arbParams.dexSell,
            arbParams.tokenTarget,
            arbParams.tokenBorrow,
            amountBought,
            0,
            arbParams.uniswapFeeSell
        );

        uint256 flashLoanFee = (amount * 5) / 10000;
        uint256 profit = amountReceived > (amount + flashLoanFee)
            ? amountReceived - amount - flashLoanFee
            : 0;

        if (profit < arbParams.minProfit) revert InsufficientProfit(arbParams.minProfit, profit);

        emit ArbitrageExecuted(
            arbParams.tokenBorrow,
            arbParams.tokenTarget,
            amount,
            profit,
            arbParams.dexBuy,
            arbParams.dexSell
        );

        return profit;
    }

    // ============================================================================
    // EXECUÇÃO INTERNA - TRIANGULAR
    // ============================================================================

    function _executeTriangular(bytes calldata params, uint256 amount) internal returns (uint256) {
        (TriangularParams memory triParams,) = abi.decode(params, (TriangularParams, bool));

        // Swap 1: tokenBorrow -> tokenMiddle
        uint256 amountMiddle = _swap(
            triParams.dex1,
            triParams.tokenBorrow,
            triParams.tokenMiddle,
            amount,
            0,
            triParams.fee1
        );

        // Swap 2: tokenMiddle -> tokenTarget
        uint256 amountTarget = _swap(
            triParams.dex2,
            triParams.tokenMiddle,
            triParams.tokenTarget,
            amountMiddle,
            0,
            triParams.fee2
        );

        // Swap 3: tokenTarget -> tokenBorrow
        uint256 amountFinal = _swap(
            triParams.dex3,
            triParams.tokenTarget,
            triParams.tokenBorrow,
            amountTarget,
            0,
            triParams.fee3
        );

        uint256 flashLoanFee = (amount * 5) / 10000;
        uint256 profit = amountFinal > (amount + flashLoanFee)
            ? amountFinal - amount - flashLoanFee
            : 0;

        if (profit < triParams.minProfit) revert InsufficientProfit(triParams.minProfit, profit);

        emit TriangularArbitrageExecuted(
            triParams.tokenBorrow,
            triParams.tokenMiddle,
            triParams.tokenTarget,
            amount,
            profit
        );

        return profit;
    }

    // ============================================================================
    // SWAP ROUTER
    // ============================================================================

    function _swap(
        DEX dex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 fee
    ) internal returns (uint256) {
        if (dex == DEX.UNISWAP_V3) {
            return _swapUniswapV3(tokenIn, tokenOut, amountIn, amountOutMin, fee);
        } else if (dex == DEX.SUSHISWAP) {
            return _swapSushiSwap(tokenIn, tokenOut, amountIn, amountOutMin);
        } else if (dex == DEX.CAMELOT) {
            return _swapCamelot(tokenIn, tokenOut, amountIn, amountOutMin);
        } else if (dex == DEX.BALANCER) {
            return _swapBalancer(tokenIn, tokenOut, amountIn, amountOutMin);
        } else if (dex == DEX.CURVE_2POOL) {
            return _swapCurve2Pool(tokenIn, tokenOut, amountIn, amountOutMin);
        } else if (dex == DEX.CURVE_TRICRYPTO) {
            return _swapCurveTricrypto(tokenIn, tokenOut, amountIn, amountOutMin);
        }
        revert SwapFailed();
    }

    // ============================================================================
    // SWAP UNISWAP V3
    // ============================================================================

    function _swapUniswapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint24 fee
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(UNISWAP_V3_ROUTER, amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });

        return ISwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(params);
    }

    // ============================================================================
    // SWAP SUSHISWAP
    // ============================================================================

    function _swapSushiSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(SUSHISWAP_ROUTER, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = ISushiSwapRouter(SUSHISWAP_ROUTER).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            block.timestamp
        );

        return amounts[amounts.length - 1];
    }

    // ============================================================================
    // SWAP CAMELOT
    // ============================================================================

    function _swapCamelot(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(CAMELOT_ROUTER, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        ICamelotRouter(CAMELOT_ROUTER).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            address(0), // sem referral
            block.timestamp
        );

        uint256 balanceAfter = IERC20(tokenOut).balanceOf(address(this));
        return balanceAfter - balanceBefore;
    }

    // ============================================================================
    // SWAP BALANCER V2
    // ============================================================================

    /// @notice Pool IDs conhecidos no Balancer Arbitrum
    /// WETH/USDC: 0x64541216bafffeec8ea535bb71fbc927831d0595000100000000000000000002
    /// WETH/wstETH: 0x36bf227d6bac96e2ab1ebb5492ecec69c691943f000200000000000000000316

    function _swapBalancer(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(BALANCER_VAULT, amountIn);

        // Encontrar pool ID dinamicamente baseado nos tokens
        bytes32 poolId = _getBalancerPoolId(tokenIn, tokenOut);

        IBalancerVault.SingleSwap memory singleSwap = IBalancerVault.SingleSwap({
            poolId: poolId,
            kind: IBalancerVault.SwapKind.GIVEN_IN,
            assetIn: tokenIn,
            assetOut: tokenOut,
            amount: amountIn,
            userData: ""
        });

        IBalancerVault.FundManagement memory funds = IBalancerVault.FundManagement({
            sender: address(this),
            fromInternalBalance: false,
            recipient: payable(address(this)),
            toInternalBalance: false
        });

        return IBalancerVault(BALANCER_VAULT).swap(
            singleSwap,
            funds,
            amountOutMin,
            block.timestamp
        );
    }

    /// @notice Retorna o Pool ID do Balancer para um par de tokens
    function _getBalancerPoolId(address tokenA, address tokenB) internal pure returns (bytes32) {
        // WETH/USDC Pool (Weighted Pool)
        if ((tokenA == WETH && tokenB == USDC) || (tokenA == USDC && tokenB == WETH)) {
            return 0x64541216bafffeec8ea535bb71fbc927831d0595000100000000000000000002;
        }
        // WETH/USDC.e Native Pool
        if ((tokenA == WETH && tokenB == USDC_NATIVE) || (tokenA == USDC_NATIVE && tokenB == WETH)) {
            return 0x0c8972437a38b389ec83d1e666b69b8a4fcf8bfd00000000000000000000049e;
        }
        // WETH/WBTC Pool
        if ((tokenA == WETH && tokenB == WBTC) || (tokenA == WBTC && tokenB == WETH)) {
            return 0x64541216bafffeec8ea535bb71fbc927831d0595000100000000000000000002;
        }
        // ARB/WETH Pool
        if ((tokenA == ARB && tokenB == WETH) || (tokenA == WETH && tokenB == ARB)) {
            return 0xcc65a812ce382ab909a11e434dbf75b34f1cc59d000200000000000000000001;
        }
        // Default: revert se pool não encontrado
        revert SwapFailed();
    }

    // ============================================================================
    // SWAP CURVE 2POOL (USDC/USDT)
    // ============================================================================

    function _swapCurve2Pool(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(CURVE_2POOL, amountIn);

        // Índices: USDC = 0, USDT = 1
        int128 i = tokenIn == USDC || tokenIn == USDC_NATIVE ? int128(0) : int128(1);
        int128 j = tokenOut == USDC || tokenOut == USDC_NATIVE ? int128(0) : int128(1);

        return ICurvePool(CURVE_2POOL).exchange(i, j, amountIn, amountOutMin);
    }

    // ============================================================================
    // SWAP CURVE TRICRYPTO (USDT/WBTC/WETH)
    // ============================================================================

    function _swapCurveTricrypto(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(CURVE_TRICRYPTO, amountIn);

        // Índices: USDT = 0, WBTC = 1, WETH = 2
        uint256 i = _getCurveTriIndex(tokenIn);
        uint256 j = _getCurveTriIndex(tokenOut);

        return ICurvePool(CURVE_TRICRYPTO).exchange(i, j, amountIn, amountOutMin);
    }

    /// @notice Retorna o índice do token no Curve Tricrypto
    function _getCurveTriIndex(address token) internal pure returns (uint256) {
        if (token == USDT) return 0;
        if (token == WBTC) return 1;
        if (token == WETH) return 2;
        revert SwapFailed();
    }

    // ============================================================================
    // FUNÇÕES DE ADMINISTRAÇÃO
    // ============================================================================

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = amount == 0 ? balance : amount;
        IERC20(token).transfer(to, withdrawAmount);
    }

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        uint256 balance = address(this).balance;
        uint256 withdrawAmount = amount == 0 ? balance : amount;
        (bool success,) = to.call{value: withdrawAmount}("");
        require(success, "ETH transfer failed");
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    // ============================================================================
    // RECEIVE
    // ============================================================================

    receive() external payable {}
    fallback() external payable {}
}
