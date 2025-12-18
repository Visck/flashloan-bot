// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAaveV3Pool
 * @author Bot de Arbitragem
 * @notice Interface para interagir com o Pool do Aave V3 na Arbitrum
 * @dev Esta interface contém apenas as funções necessárias para flash loans
 *
 * Documentação oficial: https://docs.aave.com/developers/core-contracts/pool
 *
 * CONCEITO DE FLASH LOAN:
 * - Flash loans permitem emprestar ativos sem colateral
 * - O empréstimo DEVE ser pago na mesma transação
 * - Se não for pago, toda a transação é revertida
 * - Taxa padrão do Aave V3: 0.05% (5 basis points)
 */
interface IAaveV3Pool {
    /**
     * @notice Executa um flash loan simples (um único ativo)
     * @dev O receiver deve implementar IFlashLoanSimpleReceiver
     *
     * @param receiverAddress Endereço do contrato que receberá os fundos e executará a operação
     * @param asset Endereço do token ERC20 a ser emprestado
     * @param amount Quantidade do token a ser emprestada (em wei/unidades mínimas)
     * @param params Dados extras codificados para passar ao receiver (usado para lógica de arbitragem)
     * @param referralCode Código de referência (use 0 se não tiver)
     *
     * FLUXO DE EXECUÇÃO:
     * 1. Pool transfere `amount` de `asset` para `receiverAddress`
     * 2. Pool chama `executeOperation()` no receiver
     * 3. Receiver executa sua lógica (arbitragem)
     * 4. Receiver aprova Pool para retirar amount + premium
     * 5. Pool retira os fundos + taxa
     * 6. Se qualquer etapa falhar, toda transação reverte
     */
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @notice Executa um flash loan com múltiplos ativos
     * @dev Permite emprestar vários tokens em uma única transação
     *
     * @param receiverAddress Endereço do contrato receiver
     * @param assets Array de endereços dos tokens a emprestar
     * @param amounts Array de quantidades correspondentes
     * @param interestRateModes Array de modos de taxa (0=nenhum, 1=estável, 2=variável)
     *        Use 0 para flash loan puro (sem abrir posição de dívida)
     * @param onBehalfOf Endereço em nome de quem a dívida será aberta (use address(0) para flash loan puro)
     * @param params Dados extras para o receiver
     * @param referralCode Código de referência
     */
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata interestRateModes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @notice Retorna a taxa premium do flash loan
     * @dev Taxa em basis points (1 = 0.01%, 100 = 1%)
     * @return Premium total do flash loan em basis points
     *
     * EXEMPLO:
     * Se FLASHLOAN_PREMIUM_TOTAL = 5, a taxa é 0.05%
     * Para um empréstimo de 1000 USDC, a taxa seria 0.5 USDC
     */
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);

    /**
     * @notice Retorna a porção do premium que vai para o protocolo
     * @return Premium do protocolo em basis points
     */
    function FLASHLOAN_PREMIUM_TO_PROTOCOL() external view returns (uint128);

    /**
     * @notice Retorna os dados de configuração de um ativo específico
     * @param asset Endereço do token
     * @return Configuração do ativo (estrutura complexa com múltiplos dados)
     */
    function getConfiguration(address asset) external view returns (DataTypes.ReserveConfigurationMap memory);

    /**
     * @notice Retorna os dados completos de reserva de um ativo
     * @param asset Endereço do token
     * @return Dados da reserva incluindo liquidez, taxas, etc.
     */
    function getReserveData(address asset) external view returns (DataTypes.ReserveData memory);

    /**
     * @notice Executa liquidação de uma posição
     * @param collateralAsset Token de colateral a receber
     * @param debtAsset Token de dívida a pagar
     * @param user Endereço do usuário a ser liquidado
     * @param debtToCover Quantidade de dívida a cobrir
     * @param receiveAToken Se true, recebe aToken ao invés do token subjacente
     */
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

/**
 * @title DataTypes
 * @notice Biblioteca com tipos de dados usados pelo Aave V3
 */
library DataTypes {
    /**
     * @notice Mapa de configuração de reserva
     * @dev Dados compactados em um uint256 para economia de gas
     */
    struct ReserveConfigurationMap {
        uint256 data;
    }

    /**
     * @notice Dados completos de uma reserva
     */
    struct ReserveData {
        // Configuração compactada
        ReserveConfigurationMap configuration;
        // Taxa de liquidez (índice de rendimento dos depositantes)
        uint128 liquidityIndex;
        // Taxa de empréstimo de taxa variável atual
        uint128 currentLiquidityRate;
        // Taxa de empréstimo variável
        uint128 variableBorrowIndex;
        // Taxa atual de empréstimo variável
        uint128 currentVariableBorrowRate;
        // Taxa atual de empréstimo estável
        uint128 currentStableBorrowRate;
        // Timestamp da última atualização
        uint40 lastUpdateTimestamp;
        // ID do token aToken (token de depósito)
        uint16 id;
        // Endereço do aToken
        address aTokenAddress;
        // Endereço do token de dívida estável
        address stableDebtTokenAddress;
        // Endereço do token de dívida variável
        address variableDebtTokenAddress;
        // Endereço da estratégia de taxa de juros
        address interestRateStrategyAddress;
        // Liquidez disponível atualmente (accrued to treasury)
        uint128 accruedToTreasury;
        // Total de empréstimos unbacked
        uint128 unbacked;
        // Total isolado de dívida
        uint128 isolationModeTotalDebt;
    }
}

/**
 * @title IFlashLoanSimpleReceiver
 * @notice Interface que deve ser implementada para receber flash loans simples
 * @dev Seu contrato DEVE implementar esta interface para usar flashLoanSimple()
 */
interface IFlashLoanSimpleReceiver {
    /**
     * @notice Função chamada pelo Pool após transferir os fundos do flash loan
     * @dev Esta é onde você implementa sua lógica de arbitragem
     *
     * @param asset Endereço do token emprestado
     * @param amount Quantidade emprestada
     * @param premium Taxa a ser paga (amount * premium / 10000)
     * @param initiator Endereço que iniciou o flash loan
     * @param params Dados extras passados na chamada inicial
     * @return true se a operação foi bem sucedida
     *
     * IMPORTANTE:
     * - Você DEVE aprovar o Pool para retirar (amount + premium) antes de retornar
     * - Se retornar false ou reverter, toda a transação será cancelada
     * - O gas deve ser suficiente para completar toda a operação
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);

    /**
     * @notice Retorna o endereço do Pool do Aave
     * @return Endereço do contrato Pool
     */
    function POOL() external view returns (address);

    /**
     * @notice Retorna o endereço do provedor de endereços
     * @return Endereço do PoolAddressesProvider
     */
    function ADDRESSES_PROVIDER() external view returns (address);
}

/**
 * @title IFlashLoanReceiver
 * @notice Interface para flash loans com múltiplos ativos
 */
interface IFlashLoanReceiver {
    /**
     * @notice Função chamada para flash loans com múltiplos ativos
     *
     * @param assets Array de tokens emprestados
     * @param amounts Array de quantidades emprestadas
     * @param premiums Array de taxas para cada ativo
     * @param initiator Endereço que iniciou o flash loan
     * @param params Dados extras
     * @return true se bem sucedido
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool);

    function POOL() external view returns (address);
    function ADDRESSES_PROVIDER() external view returns (address);
}

/**
 * @title IPoolAddressesProvider
 * @notice Interface para obter endereços dos contratos do Aave
 */
interface IPoolAddressesProvider {
    /**
     * @notice Retorna o endereço do Pool
     * @return Endereço do contrato Pool
     */
    function getPool() external view returns (address);

    /**
     * @notice Retorna o endereço do Price Oracle
     * @return Endereço do oracle de preços
     */
    function getPriceOracle() external view returns (address);
}
