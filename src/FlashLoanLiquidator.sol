// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FlashLoanLiquidator
 * @notice Contrato para liquidações usando Flash Loan do Aave V3
 * @dev Fluxo:
 *      1. Pega flash loan do token de dívida
 *      2. Executa liquidação no Aave
 *      3. Recebe colateral com bônus (5-10%)
 *      4. Vende colateral por token de dívida
 *      5. Paga flash loan + fee
 *      6. Lucro fica no contrato
 */

import "./interfaces/IAaveV3Pool.sol";
import "./interfaces/IUniswapV3.sol";
import "./interfaces/IERC20.sol";

contract FlashLoanLiquidator is IFlashLoanSimpleReceiver {
    // ============================================================================
    // CONSTANTES - ARBITRUM MAINNET
    // ============================================================================

    address public constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant AAVE_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    // Tokens comuns
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address public constant USDC_BRIDGED = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address public constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    address public constant WBTC = 0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f;
    address public constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;
    address public constant DAI = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;

    // ============================================================================
    // ESTADO
    // ============================================================================

    address private _owner;
    uint256 private _locked = 1;

    // ============================================================================
    // STRUCTS
    // ============================================================================

    struct LiquidationParams {
        address collateralAsset;    // Token que vamos receber
        address debtAsset;          // Token que vamos pagar (flash loan)
        address user;               // Usuário a ser liquidado
        uint256 debtToCover;        // Quantidade de dívida a cobrir
        uint24 swapFee;             // Fee do Uniswap (500, 3000, 10000)
        uint256 minProfit;          // Lucro mínimo esperado
    }

    // ============================================================================
    // EVENTOS
    // ============================================================================

    event LiquidationExecuted(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 debtCovered,
        uint256 collateralReceived,
        uint256 profit
    );

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ============================================================================
    // ERROS
    // ============================================================================

    error Unauthorized();
    error InsufficientProfit(uint256 expected, uint256 actual);
    error LiquidationFailed();
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
    // FUNÇÕES PÚBLICAS
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
    // LIQUIDAÇÃO COM FLASH LOAN
    // ============================================================================

    /**
     * @notice Executa liquidação usando flash loan
     * @param params Parâmetros da liquidação
     */
    function executeLiquidation(LiquidationParams calldata params) external onlyOwner nonReentrant {
        if (params.debtToCover == 0) revert LiquidationFailed();

        // Codifica parâmetros para o callback
        bytes memory data = abi.encode(params);

        // Pega flash loan do token de dívida
        IAaveV3Pool(AAVE_POOL).flashLoanSimple(
            address(this),
            params.debtAsset,
            params.debtToCover,
            data,
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
        // Verificações de segurança
        if (msg.sender != AAVE_POOL) revert Unauthorized();
        if (initiator != address(this)) revert Unauthorized();

        // Decodifica parâmetros
        LiquidationParams memory liqParams = abi.decode(params, (LiquidationParams));

        // 1. Aprova Aave Pool para gastar o token de dívida
        IERC20(asset).approve(AAVE_POOL, amount);

        // 2. Executa liquidação
        uint256 collateralBefore = IERC20(liqParams.collateralAsset).balanceOf(address(this));

        IAaveV3Pool(AAVE_POOL).liquidationCall(
            liqParams.collateralAsset,
            liqParams.debtAsset,
            liqParams.user,
            amount,
            false // receiveAToken = false (queremos o token subjacente)
        );

        uint256 collateralReceived = IERC20(liqParams.collateralAsset).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert LiquidationFailed();

        // 3. Calcula quanto precisa pagar (flash loan + fee)
        uint256 amountOwed = amount + premium;

        // 4. Se colateral != dívida, precisa fazer swap
        uint256 debtBalance = IERC20(asset).balanceOf(address(this));

        if (liqParams.collateralAsset != liqParams.debtAsset && debtBalance < amountOwed) {
            // Precisa vender colateral para pagar dívida
            uint256 amountNeeded = amountOwed - debtBalance;

            _swapCollateralForDebt(
                liqParams.collateralAsset,
                liqParams.debtAsset,
                collateralReceived,
                amountNeeded,
                liqParams.swapFee
            );
        }

        // 5. Verifica se temos o suficiente para pagar
        debtBalance = IERC20(asset).balanceOf(address(this));
        if (debtBalance < amountOwed) revert InsufficientProfit(amountOwed, debtBalance);

        // 6. Calcula lucro
        uint256 profit = debtBalance - amountOwed;
        if (profit < liqParams.minProfit) revert InsufficientProfit(liqParams.minProfit, profit);

        // 7. Aprova pagamento do flash loan
        IERC20(asset).approve(AAVE_POOL, amountOwed);

        emit LiquidationExecuted(
            liqParams.user,
            liqParams.collateralAsset,
            liqParams.debtAsset,
            amount,
            collateralReceived,
            profit
        );

        return true;
    }

    // ============================================================================
    // SWAP INTERNO
    // ============================================================================

    function _swapCollateralForDebt(
        address collateral,
        address debt,
        uint256 collateralAmount,
        uint256 minDebtAmount,
        uint24 fee
    ) internal returns (uint256) {
        IERC20(collateral).approve(UNISWAP_V3_ROUTER, collateralAmount);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: collateral,
            tokenOut: debt,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: collateralAmount,
            amountOutMinimum: minDebtAmount,
            sqrtPriceLimitX96: 0
        });

        return ISwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(params);
    }

    // ============================================================================
    // FUNÇÕES DE ADMINISTRAÇÃO
    // ============================================================================

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = amount == 0 ? balance : amount;
        if (withdrawAmount > 0) {
            IERC20(token).transfer(to, withdrawAmount);
        }
    }

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        uint256 balance = address(this).balance;
        uint256 withdrawAmount = amount == 0 ? balance : amount;
        if (withdrawAmount > 0) {
            (bool success,) = to.call{value: withdrawAmount}("");
            require(success, "ETH transfer failed");
        }
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
