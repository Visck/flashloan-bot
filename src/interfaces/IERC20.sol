// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IERC20
 * @author OpenZeppelin (adaptado)
 * @notice Interface padrão para tokens ERC20
 * @dev Padrão EIP-20: https://eips.ethereum.org/EIPS/eip-20
 *
 * ERC20 é o padrão mais comum para tokens fungíveis em Ethereum e L2s.
 * Quase todos os tokens DeFi seguem este padrão.
 */
interface IERC20 {
    /**
     * @notice Retorna o supply total de tokens em circulação
     * @return Quantidade total de tokens existentes
     */
    function totalSupply() external view returns (uint256);

    /**
     * @notice Retorna o saldo de uma conta
     * @param account Endereço para consultar
     * @return Saldo de tokens do endereço
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @notice Transfere tokens para outro endereço
     * @dev Emite evento Transfer. Reverte se saldo insuficiente.
     *
     * @param to Destinatário
     * @param amount Quantidade a transferir
     * @return success True se a transferência foi bem sucedida
     *
     * IMPORTANTE: Alguns tokens não retornam valor (USDT por exemplo)
     * Use SafeERC20 para lidar com esses casos
     */
    function transfer(address to, uint256 amount) external returns (bool);

    /**
     * @notice Retorna quanto um spender pode gastar em nome do owner
     * @param owner Dono dos tokens
     * @param spender Endereço autorizado a gastar
     * @return Quantidade autorizada restante
     *
     * NOTA: Aprovals são gastos conforme transferFrom é chamado
     */
    function allowance(address owner, address spender) external view returns (uint256);

    /**
     * @notice Autoriza um endereço a gastar seus tokens
     * @dev Emite evento Approval. CUIDADO com race conditions!
     *
     * @param spender Endereço a ser autorizado
     * @param amount Quantidade máxima que pode gastar
     * @return success True se a aprovação foi bem sucedida
     *
     * SEGURANÇA:
     * - Aprovar 0 primeiro, depois o valor desejado (evita race condition)
     * - Ou use increaseAllowance/decreaseAllowance se disponível
     * - Nunca aprove mais do que necessário
     */
    function approve(address spender, uint256 amount) external returns (bool);

    /**
     * @notice Transfere tokens de uma conta para outra usando allowance
     * @dev Requer aprovação prévia. Emite evento Transfer.
     *
     * @param from Conta de origem (deve ter aprovado msg.sender)
     * @param to Destinatário
     * @param amount Quantidade a transferir
     * @return success True se bem sucedido
     *
     * FLUXO:
     * 1. Owner chama approve(spender, amount)
     * 2. Spender chama transferFrom(owner, to, amount)
     * 3. Allowance é decrementado em amount
     */
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /**
     * @notice Emitido quando tokens são transferidos
     * @param from Endereço de origem (address(0) para mint)
     * @param to Endereço de destino (address(0) para burn)
     * @param value Quantidade transferida
     */
    event Transfer(address indexed from, address indexed to, uint256 value);

    /**
     * @notice Emitido quando uma aprovação é definida
     * @param owner Dono dos tokens
     * @param spender Endereço autorizado
     * @param value Nova quantidade autorizada
     */
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

/**
 * @title IERC20Metadata
 * @notice Extensão do ERC20 com metadados
 * @dev Fornece informações sobre nome, símbolo e decimais do token
 */
interface IERC20Metadata is IERC20 {
    /**
     * @notice Retorna o nome do token
     * @return Nome completo (ex: "USD Coin")
     */
    function name() external view returns (string memory);

    /**
     * @notice Retorna o símbolo do token
     * @return Símbolo curto (ex: "USDC")
     */
    function symbol() external view returns (string memory);

    /**
     * @notice Retorna o número de casas decimais
     * @return Decimais (geralmente 18, mas USDC usa 6)
     *
     * IMPORTANTE PARA ARBITRAGEM:
     * - ETH/WETH: 18 decimais (1 ETH = 1e18 wei)
     * - USDC/USDT: 6 decimais (1 USDC = 1e6)
     * - WBTC: 8 decimais (1 WBTC = 1e8 satoshis)
     *
     * Sempre considere decimais ao calcular preços e lucros!
     */
    function decimals() external view returns (uint8);
}

/**
 * @title IWETH
 * @notice Interface para Wrapped ETH
 * @dev WETH permite usar ETH como token ERC20
 *
 * Por que WETH existe:
 * - ETH nativo não segue ERC20
 * - Muitos protocolos DeFi só aceitam ERC20
 * - WETH é um wrapper 1:1 de ETH
 */
interface IWETH is IERC20 {
    /**
     * @notice Deposita ETH e recebe WETH
     * @dev Envia ETH via msg.value, recebe mesma quantidade de WETH
     *
     * EXEMPLO:
     * Para converter 1 ETH em WETH:
     * weth.deposit{value: 1 ether}();
     */
    function deposit() external payable;

    /**
     * @notice Saca WETH e recebe ETH
     * @param amount Quantidade de WETH a converter
     *
     * EXEMPLO:
     * Para converter 1 WETH em ETH:
     * weth.withdraw(1 ether);
     */
    function withdraw(uint256 amount) external;
}
