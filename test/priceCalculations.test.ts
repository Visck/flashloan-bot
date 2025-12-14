/**
 * ============================================================================
 * TESTES UNITÁRIOS - CÁLCULOS DE PREÇO
 * ============================================================================
 *
 * Testes para validar os cálculos de preço e lucratividade do bot.
 *
 * COMO EXECUTAR:
 * ```bash
 * npm run test:bot
 * ```
 */

import { formatUnits, parseUnits } from 'ethers';

// ============================================================================
// FUNÇÕES DE CÁLCULO (simulando as do bot)
// ============================================================================

/**
 * Calcula a taxa do flash loan do Aave (0.05%)
 * @param amount Quantidade emprestada
 * @returns Taxa em wei
 */
function calculateFlashLoanFee(amount: bigint): bigint {
    return (amount * 5n) / 10000n; // 0.05%
}

/**
 * Calcula o output de um swap no SushiSwap (AMM x*y=k)
 * @param amountIn Quantidade de entrada
 * @param reserveIn Reserva do token de entrada
 * @param reserveOut Reserva do token de saída
 * @returns Quantidade de saída
 */
function calculateSushiSwapOutput(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint
): bigint {
    // Fórmula: amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 1000n + amountInWithFee;
    return numerator / denominator;
}

/**
 * Calcula o impacto no preço de um swap
 * @param amountIn Quantidade de entrada
 * @param reserveIn Reserva do token de entrada
 * @returns Impacto em porcentagem
 */
function calculatePriceImpact(amountIn: bigint, reserveIn: bigint): number {
    // Impacto ≈ amountIn / (reserveIn + amountIn) * 100
    const impact = Number(amountIn * 10000n / (reserveIn + amountIn)) / 100;
    return impact;
}

/**
 * Calcula lucro de arbitragem
 * @param amountBorrow Quantidade emprestada
 * @param amountReceived Quantidade recebida após arbitragem
 * @returns Lucro (pode ser negativo)
 */
function calculateArbitrageProfit(
    amountBorrow: bigint,
    amountReceived: bigint
): bigint {
    const flashLoanFee = calculateFlashLoanFee(amountBorrow);
    const amountOwed = amountBorrow + flashLoanFee;
    return amountReceived - amountOwed;
}

/**
 * Verifica se uma arbitragem é lucrativa
 * @param profit Lucro bruto
 * @param gasCost Custo de gas
 * @param minProfitUsd Lucro mínimo em USD
 * @param tokenPriceUsd Preço do token em USD
 * @param tokenDecimals Decimais do token
 * @returns Se é lucrativo
 */
function isArbitrageProfitable(
    profit: bigint,
    gasCost: bigint,
    minProfitUsd: number,
    tokenPriceUsd: number,
    tokenDecimals: number
): boolean {
    const profitFormatted = parseFloat(formatUnits(profit, tokenDecimals));
    const profitUsd = profitFormatted * tokenPriceUsd;

    const gasCostEth = parseFloat(formatUnits(gasCost, 18));
    const gasCostUsd = gasCostEth * 2000; // Assumindo ETH = $2000

    const netProfitUsd = profitUsd - gasCostUsd;

    return netProfitUsd >= minProfitUsd;
}

// ============================================================================
// TESTES
// ============================================================================

describe('Cálculos de Taxa de Flash Loan', () => {
    test('Taxa de 0.05% para 1000 USDC', () => {
        const amount = parseUnits('1000', 6); // 1000 USDC (6 decimais)
        const fee = calculateFlashLoanFee(amount);

        // 0.05% de 1000 = 0.5
        const expectedFee = parseUnits('0.5', 6);
        expect(fee).toBe(expectedFee);
    });

    test('Taxa de 0.05% para 100,000 USDC', () => {
        const amount = parseUnits('100000', 6);
        const fee = calculateFlashLoanFee(amount);

        // 0.05% de 100,000 = 50
        const expectedFee = parseUnits('50', 6);
        expect(fee).toBe(expectedFee);
    });

    test('Taxa para valores pequenos', () => {
        const amount = parseUnits('100', 6); // 100 USDC
        const fee = calculateFlashLoanFee(amount);

        // 0.05% de 100 = 0.05
        const expectedFee = parseUnits('0.05', 6);
        expect(fee).toBe(expectedFee);
    });

    test('Taxa para 1 ETH (18 decimais)', () => {
        const amount = parseUnits('1', 18);
        const fee = calculateFlashLoanFee(amount);

        // 0.05% de 1 ETH = 0.0005 ETH
        const expectedFee = parseUnits('0.0005', 18);
        expect(fee).toBe(expectedFee);
    });
});

describe('Cálculos de Swap SushiSwap (AMM)', () => {
    test('Swap simples com reservas iguais', () => {
        // Pool com 1M de cada token
        const reserveIn = parseUnits('1000000', 18);
        const reserveOut = parseUnits('1000000', 18);
        const amountIn = parseUnits('1000', 18); // 1000 tokens

        const amountOut = calculateSushiSwapOutput(amountIn, reserveIn, reserveOut);

        // Com taxa de 0.3%, deve receber ~996.x tokens
        // Fórmula exata: (1000 * 997 * 1M) / (1M * 1000 + 1000 * 997)
        // = 997,000,000 / 1,000,997,000 ≈ 996.006
        expect(amountOut).toBeGreaterThan(parseUnits('995', 18));
        expect(amountOut).toBeLessThan(parseUnits('997', 18));
    });

    test('Swap com desbalanceamento de reservas', () => {
        // Pool desbalanceado: 1M USDC, 500 WETH
        const reserveIn = parseUnits('1000000', 6); // USDC
        const reserveOut = parseUnits('500', 18); // WETH
        const amountIn = parseUnits('2000', 6); // 2000 USDC

        const amountOut = calculateSushiSwapOutput(amountIn, reserveIn, reserveOut);

        // Preço implícito: 2000 USDC/ETH
        // 2000 USDC deveria dar ~0.997 WETH (com taxa)
        expect(amountOut).toBeGreaterThan(parseUnits('0.99', 18));
        expect(amountOut).toBeLessThan(parseUnits('1', 18));
    });

    test('Swap grande causa alto impacto', () => {
        const reserveIn = parseUnits('100000', 18);
        const reserveOut = parseUnits('100000', 18);

        // Swap de 10% da reserva
        const smallSwap = parseUnits('1000', 18);
        const largeSwap = parseUnits('10000', 18);

        const smallOutput = calculateSushiSwapOutput(smallSwap, reserveIn, reserveOut);
        const largeOutput = calculateSushiSwapOutput(largeSwap, reserveIn, reserveOut);

        // Proporcionalmente, swap grande recebe menos por unidade
        const smallRate = Number(smallOutput) / Number(smallSwap);
        const largeRate = Number(largeOutput) / Number(largeSwap);

        expect(largeRate).toBeLessThan(smallRate);
    });
});

describe('Cálculos de Impacto no Preço', () => {
    test('Impacto para swap pequeno', () => {
        const reserveIn = parseUnits('1000000', 18);
        const amountIn = parseUnits('1000', 18); // 0.1% da reserva

        const impact = calculatePriceImpact(amountIn, reserveIn);

        // Impacto deve ser ~0.1%
        expect(impact).toBeGreaterThan(0.09);
        expect(impact).toBeLessThan(0.11);
    });

    test('Impacto para swap grande', () => {
        const reserveIn = parseUnits('1000000', 18);
        const amountIn = parseUnits('100000', 18); // 10% da reserva

        const impact = calculatePriceImpact(amountIn, reserveIn);

        // Impacto deve ser ~9%
        expect(impact).toBeGreaterThan(8);
        expect(impact).toBeLessThan(10);
    });
});

describe('Cálculos de Lucro de Arbitragem', () => {
    test('Arbitragem lucrativa', () => {
        const amountBorrow = parseUnits('10000', 6); // 10,000 USDC
        const amountReceived = parseUnits('10100', 6); // Recebeu 10,100 USDC

        const profit = calculateArbitrageProfit(amountBorrow, amountReceived);

        // Lucro = 10100 - 10000 - 5 (taxa) = 95 USDC
        expect(profit).toBe(parseUnits('95', 6));
    });

    test('Arbitragem não lucrativa', () => {
        const amountBorrow = parseUnits('10000', 6);
        const amountReceived = parseUnits('10000', 6); // Recebeu exatamente o mesmo

        const profit = calculateArbitrageProfit(amountBorrow, amountReceived);

        // Prejuízo = -5 USDC (só a taxa)
        expect(profit).toBe(-parseUnits('5', 6));
    });

    test('Arbitragem com prejuízo por slippage', () => {
        const amountBorrow = parseUnits('10000', 6);
        const amountReceived = parseUnits('9900', 6); // Perdeu 1%

        const profit = calculateArbitrageProfit(amountBorrow, amountReceived);

        // Prejuízo = 9900 - 10000 - 5 = -105 USDC
        expect(profit).toBe(-parseUnits('105', 6));
    });
});

describe('Verificação de Lucratividade', () => {
    test('Lucro suficiente após gas', () => {
        const profit = parseUnits('50', 6); // 50 USDC de lucro
        const gasCost = parseUnits('0.001', 18); // 0.001 ETH de gas (~$2)
        const minProfitUsd = 10;
        const tokenPriceUsd = 1; // USDC
        const tokenDecimals = 6;

        const isProfitable = isArbitrageProfitable(
            profit,
            gasCost,
            minProfitUsd,
            tokenPriceUsd,
            tokenDecimals
        );

        // 50 - 2 = 48 USD > 10 USD
        expect(isProfitable).toBe(true);
    });

    test('Lucro insuficiente após gas', () => {
        const profit = parseUnits('5', 6); // 5 USDC de lucro
        const gasCost = parseUnits('0.002', 18); // 0.002 ETH de gas (~$4)
        const minProfitUsd = 5;
        const tokenPriceUsd = 1;
        const tokenDecimals = 6;

        const isProfitable = isArbitrageProfitable(
            profit,
            gasCost,
            minProfitUsd,
            tokenPriceUsd,
            tokenDecimals
        );

        // 5 - 4 = 1 USD < 5 USD
        expect(isProfitable).toBe(false);
    });

    test('Lucro em ETH é lucrativo', () => {
        const profit = parseUnits('0.01', 18); // 0.01 ETH de lucro
        const gasCost = parseUnits('0.001', 18); // 0.001 ETH de gas
        const minProfitUsd = 10;
        const tokenPriceUsd = 2000; // ETH
        const tokenDecimals = 18;

        const isProfitable = isArbitrageProfitable(
            profit,
            gasCost,
            minProfitUsd,
            tokenPriceUsd,
            tokenDecimals
        );

        // 0.01 * 2000 - 0.001 * 2000 = 20 - 2 = 18 USD > 10 USD
        expect(isProfitable).toBe(true);
    });
});

describe('Cenários de Arbitragem Completos', () => {
    test('Cenário: USDC -> WETH -> USDC com 0.5% de diferença', () => {
        // Simulação simplificada:
        // Uniswap: 1 WETH = 2000 USDC
        // SushiSwap: 1 WETH = 2010 USDC (0.5% mais caro)

        const amountBorrow = parseUnits('100000', 6); // 100,000 USDC
        const flashLoanFee = calculateFlashLoanFee(amountBorrow); // 50 USDC

        // Compra no Uniswap: 100,000 USDC -> ~49.5 WETH (com taxa de 0.05%)
        const wethBought = parseUnits('49.5', 18);

        // Vende no SushiSwap: 49.5 WETH -> ~99,494 USDC (com taxa de 0.3%)
        // 49.5 * 2010 * 0.997 = ~99,494
        const usdcReceived = parseUnits('99494', 6);

        // Calcula lucro
        const amountOwed = amountBorrow + flashLoanFee;
        const grossProfit = usdcReceived - amountOwed;

        console.log('Cenário de Arbitragem:');
        console.log(`  Emprestado: ${formatUnits(amountBorrow, 6)} USDC`);
        console.log(`  Taxa Flash Loan: ${formatUnits(flashLoanFee, 6)} USDC`);
        console.log(`  WETH Comprado: ${formatUnits(wethBought, 18)} WETH`);
        console.log(`  USDC Recebido: ${formatUnits(usdcReceived, 6)} USDC`);
        console.log(`  Lucro Bruto: ${formatUnits(grossProfit, 6)} USDC`);

        // Neste cenário, não seria lucrativo porque as taxas superam a diferença
        // Em arbitragem real, você precisa de diferenças maiores ou volumes muito altos
    });
});
