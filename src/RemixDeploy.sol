// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

library DataTypes {
    struct ReserveConfigurationMap { uint256 data; }
    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }
}

interface IAaveV3Pool {
    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
    function getConfiguration(address asset) external view returns (DataTypes.ReserveConfigurationMap memory);
    function getReserveData(address asset) external view returns (DataTypes.ReserveData memory);
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool);
    function POOL() external view returns (address);
    function ADDRESSES_PROVIDER() external view returns (address);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface ISushiSwapRouter {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts);
}

interface ICamelotRouter {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, address referrer, uint256 deadline) external;
}

interface IBalancerVault {
    enum SwapKind { GIVEN_IN, GIVEN_OUT }
    struct SingleSwap { bytes32 poolId; SwapKind kind; address assetIn; address assetOut; uint256 amount; bytes userData; }
    struct FundManagement { address sender; bool fromInternalBalance; address payable recipient; bool toInternalBalance; }
    function swap(SingleSwap memory singleSwap, FundManagement memory funds, uint256 limit, uint256 deadline) external payable returns (uint256);
}

interface ICurvePool {
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external returns (uint256);
}

contract FlashLoanArbitrageV2 is IFlashLoanSimpleReceiver {
    address public constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant AAVE_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant SUSHISWAP_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    address public constant CAMELOT_ROUTER = 0xc873fEcbd354f5A56E00E710B90EF4201db2448d;
    address public constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address public constant CURVE_2POOL = 0x7f90122BF0700F9E7e1F688fe926940E8839F353;
    address public constant CURVE_TRICRYPTO = 0x960ea3e3C7FB317332d990873d354E18d7645590;

    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant USDC = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address public constant USDC_NATIVE = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address public constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address public constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;
    address public constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;

    address private _owner;
    uint256 private _locked = 1;

    enum DEX { UNISWAP_V3, SUSHISWAP, CAMELOT, BALANCER, CURVE_2POOL, CURVE_TRICRYPTO }

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

    struct TriangularParams {
        address tokenBorrow;
        address tokenMiddle;
        address tokenTarget;
        uint256 amountBorrow;
        DEX dex1;
        DEX dex2;
        DEX dex3;
        uint24 fee1;
        uint24 fee2;
        uint24 fee3;
        uint256 minProfit;
    }

    event ArbitrageExecuted(address indexed tokenBorrow, address indexed tokenTarget, uint256 amountBorrowed, uint256 profit, DEX dexBuy, DEX dexSell);
    event TriangularArbitrageExecuted(address indexed tokenBorrow, address tokenMiddle, address tokenTarget, uint256 amountBorrowed, uint256 profit);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error InsufficientProfit(uint256 expected, uint256 actual);
    error InvalidAmount();
    error SwapFailed();
    error Reentrancy();

    modifier onlyOwner() { if (msg.sender != _owner) revert Unauthorized(); _; }
    modifier nonReentrant() { if (_locked != 1) revert Reentrancy(); _locked = 2; _; _locked = 1; }

    constructor() { _owner = msg.sender; emit OwnershipTransferred(address(0), msg.sender); }

    function owner() public view returns (address) { return _owner; }
    function POOL() external pure override returns (address) { return AAVE_POOL; }
    function ADDRESSES_PROVIDER() external pure override returns (address) { return AAVE_ADDRESSES_PROVIDER; }

    function executeArbitrage(ArbitrageParams calldata params) external onlyOwner nonReentrant {
        if (params.amountBorrow == 0) revert InvalidAmount();
        bytes memory encodedParams = abi.encode(params, false);
        IAaveV3Pool(AAVE_POOL).flashLoanSimple(address(this), params.tokenBorrow, params.amountBorrow, encodedParams, 0);
    }

    function executeTriangularArbitrage(TriangularParams calldata params) external onlyOwner nonReentrant {
        if (params.amountBorrow == 0) revert InvalidAmount();
        bytes memory encodedParams = abi.encode(params, true);
        IAaveV3Pool(AAVE_POOL).flashLoanSimple(address(this), params.tokenBorrow, params.amountBorrow, encodedParams, 0);
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external override returns (bool) {
        if (msg.sender != AAVE_POOL) revert Unauthorized();
        if (initiator != address(this)) revert Unauthorized();
        (, bool isTriangular) = abi.decode(params, (bytes, bool));
        if (isTriangular) { _executeTriangular(params, amount); } else { _executeSimple(params, amount); }
        uint256 amountOwed = amount + premium;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance < amountOwed) revert InsufficientProfit(amountOwed, balance);
        IERC20(asset).approve(AAVE_POOL, amountOwed);
        return true;
    }

    function _executeSimple(bytes calldata params, uint256 amount) internal returns (uint256) {
        (ArbitrageParams memory arbParams,) = abi.decode(params, (ArbitrageParams, bool));
        uint256 amountBought = _swap(arbParams.dexBuy, arbParams.tokenBorrow, arbParams.tokenTarget, amount, 0, arbParams.uniswapFeeBuy);
        uint256 amountReceived = _swap(arbParams.dexSell, arbParams.tokenTarget, arbParams.tokenBorrow, amountBought, 0, arbParams.uniswapFeeSell);
        uint256 flashLoanFee = (amount * 5) / 10000;
        uint256 profit = amountReceived > (amount + flashLoanFee) ? amountReceived - amount - flashLoanFee : 0;
        if (profit < arbParams.minProfit) revert InsufficientProfit(arbParams.minProfit, profit);
        emit ArbitrageExecuted(arbParams.tokenBorrow, arbParams.tokenTarget, amount, profit, arbParams.dexBuy, arbParams.dexSell);
        return profit;
    }

    function _executeTriangular(bytes calldata params, uint256 amount) internal returns (uint256) {
        (TriangularParams memory triParams,) = abi.decode(params, (TriangularParams, bool));
        uint256 amountMiddle = _swap(triParams.dex1, triParams.tokenBorrow, triParams.tokenMiddle, amount, 0, triParams.fee1);
        uint256 amountTarget = _swap(triParams.dex2, triParams.tokenMiddle, triParams.tokenTarget, amountMiddle, 0, triParams.fee2);
        uint256 amountFinal = _swap(triParams.dex3, triParams.tokenTarget, triParams.tokenBorrow, amountTarget, 0, triParams.fee3);
        uint256 flashLoanFee = (amount * 5) / 10000;
        uint256 profit = amountFinal > (amount + flashLoanFee) ? amountFinal - amount - flashLoanFee : 0;
        if (profit < triParams.minProfit) revert InsufficientProfit(triParams.minProfit, profit);
        emit TriangularArbitrageExecuted(triParams.tokenBorrow, triParams.tokenMiddle, triParams.tokenTarget, amount, profit);
        return profit;
    }

    function _swap(DEX dex, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint24 fee) internal returns (uint256) {
        if (dex == DEX.UNISWAP_V3) return _swapUniswapV3(tokenIn, tokenOut, amountIn, amountOutMin, fee);
        if (dex == DEX.SUSHISWAP) return _swapSushiSwap(tokenIn, tokenOut, amountIn, amountOutMin);
        if (dex == DEX.CAMELOT) return _swapCamelot(tokenIn, tokenOut, amountIn, amountOutMin);
        if (dex == DEX.BALANCER) return _swapBalancer(tokenIn, tokenOut, amountIn, amountOutMin);
        if (dex == DEX.CURVE_2POOL) return _swapCurve2Pool(tokenIn, tokenOut, amountIn, amountOutMin);
        if (dex == DEX.CURVE_TRICRYPTO) return _swapCurveTricrypto(tokenIn, tokenOut, amountIn, amountOutMin);
        revert SwapFailed();
    }

    function _swapUniswapV3(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint24 fee) internal returns (uint256) {
        IERC20(tokenIn).approve(UNISWAP_V3_ROUTER, amountIn);
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, recipient: address(this),
            deadline: block.timestamp, amountIn: amountIn, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0
        });
        return ISwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(params);
    }

    function _swapSushiSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) internal returns (uint256) {
        IERC20(tokenIn).approve(SUSHISWAP_ROUTER, amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn; path[1] = tokenOut;
        uint256[] memory amounts = ISushiSwapRouter(SUSHISWAP_ROUTER).swapExactTokensForTokens(amountIn, amountOutMin, path, address(this), block.timestamp);
        return amounts[amounts.length - 1];
    }

    function _swapCamelot(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) internal returns (uint256) {
        IERC20(tokenIn).approve(CAMELOT_ROUTER, amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn; path[1] = tokenOut;
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));
        ICamelotRouter(CAMELOT_ROUTER).swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn, amountOutMin, path, address(this), address(0), block.timestamp);
        return IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
    }

    function _swapBalancer(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) internal returns (uint256) {
        IERC20(tokenIn).approve(BALANCER_VAULT, amountIn);
        bytes32 poolId = _getBalancerPoolId(tokenIn, tokenOut);
        IBalancerVault.SingleSwap memory singleSwap = IBalancerVault.SingleSwap({
            poolId: poolId, kind: IBalancerVault.SwapKind.GIVEN_IN, assetIn: tokenIn, assetOut: tokenOut, amount: amountIn, userData: ""
        });
        IBalancerVault.FundManagement memory funds = IBalancerVault.FundManagement({
            sender: address(this), fromInternalBalance: false, recipient: payable(address(this)), toInternalBalance: false
        });
        return IBalancerVault(BALANCER_VAULT).swap(singleSwap, funds, amountOutMin, block.timestamp);
    }

    function _getBalancerPoolId(address tokenA, address tokenB) internal pure returns (bytes32) {
        if ((tokenA == WETH && tokenB == USDC) || (tokenA == USDC && tokenB == WETH)) return 0x64541216bafffeec8ea535bb71fbc927831d0595000100000000000000000002;
        if ((tokenA == WETH && tokenB == USDC_NATIVE) || (tokenA == USDC_NATIVE && tokenB == WETH)) return 0x0c8972437a38b389ec83d1e666b69b8a4fcf8bfd00000000000000000000049e;
        if ((tokenA == WETH && tokenB == WBTC) || (tokenA == WBTC && tokenB == WETH)) return 0x64541216bafffeec8ea535bb71fbc927831d0595000100000000000000000002;
        if ((tokenA == ARB && tokenB == WETH) || (tokenA == WETH && tokenB == ARB)) return 0xcc65a812ce382ab909a11e434dbf75b34f1cc59d000200000000000000000001;
        revert SwapFailed();
    }

    function _swapCurve2Pool(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) internal returns (uint256) {
        IERC20(tokenIn).approve(CURVE_2POOL, amountIn);
        int128 i = tokenIn == USDC || tokenIn == USDC_NATIVE ? int128(0) : int128(1);
        int128 j = tokenOut == USDC || tokenOut == USDC_NATIVE ? int128(0) : int128(1);
        return ICurvePool(CURVE_2POOL).exchange(i, j, amountIn, amountOutMin);
    }

    function _swapCurveTricrypto(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) internal returns (uint256) {
        IERC20(tokenIn).approve(CURVE_TRICRYPTO, amountIn);
        uint256 i = _getCurveTriIndex(tokenIn);
        uint256 j = _getCurveTriIndex(tokenOut);
        return ICurvePool(CURVE_TRICRYPTO).exchange(i, j, amountIn, amountOutMin);
    }

    function _getCurveTriIndex(address token) internal pure returns (uint256) {
        if (token == USDT) return 0;
        if (token == WBTC) return 1;
        if (token == WETH) return 2;
        revert SwapFailed();
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(to, amount == 0 ? balance : amount);
    }

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        uint256 balance = address(this).balance;
        (bool success,) = to.call{value: amount == 0 ? balance : amount}("");
        require(success, "ETH transfer failed");
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    receive() external payable {}
    fallback() external payable {}
}
