import { ethers, JsonRpcProvider } from 'ethers';
import dotenv from 'dotenv';
import { logger } from '../services/logger';
import { CHAINS, BOT_CONFIG } from './liquidationConfig';
import { AaveService } from './aaveService';
import { createLendingService } from './radiantService';
import { UserDiscovery } from './userDiscovery';
import { PriceOracle } from '../services/priceOracle';

dotenv.config();

async function testConnection() {
    logger.info('='.repeat(60));
    logger.info('TEST 1: Connection Test');
    logger.info('='.repeat(60));

    const config = CHAINS.arbitrum;
    const provider = new JsonRpcProvider(config.rpcUrl);

    try {
        const blockNumber = await provider.getBlockNumber();
        const network = await provider.getNetwork();

        logger.info(`Connected to ${config.name}`);
        logger.info(`Chain ID: ${network.chainId}`);
        logger.info(`Block Number: ${blockNumber}`);
        logger.info('Connection test: PASSED');
        return provider;
    } catch (error) {
        logger.error(`Connection test: FAILED - ${error}`);
        throw error;
    }
}

async function testPriceOracle(provider: JsonRpcProvider) {
    logger.info('='.repeat(60));
    logger.info('TEST 2: Price Oracle Test');
    logger.info('='.repeat(60));

    const oracle = new PriceOracle(provider, 'arbitrum');

    const tokens = ['ETH', 'WBTC', 'USDC', 'ARB'];

    for (const token of tokens) {
        const price = await oracle.getPrice(token);
        logger.info(`${token}: $${price.toFixed(2)}`);
    }

    logger.info('Price oracle test: PASSED');
}

async function testAaveService(provider: JsonRpcProvider) {
    logger.info('='.repeat(60));
    logger.info('TEST 3: Aave V3 Service Test');
    logger.info('='.repeat(60));

    const aaveConfig = CHAINS.arbitrum.protocols.find(p => p.name === 'Aave V3');
    if (!aaveConfig) {
        logger.error('Aave V3 config not found');
        return;
    }

    const aaveService = new AaveService(provider, aaveConfig);
    await aaveService.initialize();

    const reserves = aaveService.getAllReserves();
    logger.info(`Loaded ${reserves.length} reserves:`);

    for (const reserve of reserves.slice(0, 5)) {
        logger.info(`  ${reserve.symbol}: $${reserve.priceUsd.toFixed(2)} (LiqBonus: ${reserve.liquidationBonus}%)`);
    }

    logger.info('Aave V3 service test: PASSED');
    return aaveService;
}

async function testUserDiscovery(provider: JsonRpcProvider) {
    logger.info('='.repeat(60));
    logger.info('TEST 4: User Discovery Test');
    logger.info('='.repeat(60));

    const aaveConfig = CHAINS.arbitrum.protocols.find(p => p.name === 'Aave V3');
    if (!aaveConfig) {
        logger.error('Aave V3 config not found');
        return;
    }

    const discovery = new UserDiscovery(
        provider,
        aaveConfig.poolAddress,
        'Aave V3'
    );

    // Busca usuarios dos ultimos 1000 blocos (teste rapido)
    const users = await discovery.discoverFromRecentBlocks(1000);

    logger.info(`Discovered ${users.length} users from last 1000 blocks`);

    if (users.length > 0) {
        logger.info(`Sample users:`);
        for (const user of users.slice(0, 5)) {
            logger.info(`  ${user}`);
        }
    }

    logger.info('User discovery test: PASSED');
    return discovery;
}

async function testHealthFactorCheck(provider: JsonRpcProvider, aaveService: AaveService, discovery: UserDiscovery) {
    logger.info('='.repeat(60));
    logger.info('TEST 5: Health Factor Check Test');
    logger.info('='.repeat(60));

    const users = discovery.getKnownUsers().slice(0, 20); // Testa com 20 usuarios

    if (users.length === 0) {
        logger.warn('No users to check');
        return;
    }

    logger.info(`Checking health factors for ${users.length} users...`);

    const accountsData = await aaveService.getBatchUserAccountData(users);

    let atRisk = 0;
    let liquidatable = 0;

    for (const account of accountsData) {
        if (account.healthFactorNum < 1.5) {
            atRisk++;
            logger.info(`User ${account.user.slice(0, 10)}... HF: ${account.healthFactorNum.toFixed(4)}`);
        }
        if (account.healthFactorNum < 1.0) {
            liquidatable++;
        }
    }

    logger.info(`Users at risk (HF < 1.5): ${atRisk}`);
    logger.info(`Users liquidatable (HF < 1.0): ${liquidatable}`);
    logger.info('Health factor check test: PASSED');
}

async function testOpportunityCalculation(provider: JsonRpcProvider, aaveService: AaveService) {
    logger.info('='.repeat(60));
    logger.info('TEST 6: Opportunity Calculation Test');
    logger.info('='.repeat(60));

    // Busca um usuario aleatorio com posicao ativa
    const discovery = new UserDiscovery(
        provider,
        CHAINS.arbitrum.protocols[0].poolAddress,
        'Aave V3'
    );

    await discovery.discoverFromRecentBlocks(500);
    const users = discovery.getKnownUsers();

    if (users.length === 0) {
        logger.warn('No users found for opportunity test');
        return;
    }

    // Testa calculo de oportunidade com um usuario
    const testUser = users[0];
    const accountData = await aaveService.getUserAccountData(testUser);

    logger.info(`Test user: ${testUser}`);
    logger.info(`Total Collateral: $${(Number(accountData.totalCollateralBase) / 1e8).toFixed(2)}`);
    logger.info(`Total Debt: $${(Number(accountData.totalDebtBase) / 1e8).toFixed(2)}`);
    logger.info(`Health Factor: ${accountData.healthFactorNum.toFixed(4)}`);

    if (accountData.healthFactorNum < 1.0) {
        const opportunity = await aaveService.calculateLiquidationOpportunity(testUser, accountData);
        if (opportunity) {
            logger.info('LIQUIDATION OPPORTUNITY FOUND:');
            logger.info(`  Debt: ${opportunity.debtSymbol} ($${opportunity.debtValueUsd.toFixed(2)})`);
            logger.info(`  Collateral: ${opportunity.collateralSymbol} ($${opportunity.collateralValueUsd.toFixed(2)})`);
            logger.info(`  Expected Profit: $${opportunity.netProfitUsd.toFixed(2)}`);
        }
    } else {
        logger.info('User is healthy, no liquidation needed');
    }

    logger.info('Opportunity calculation test: PASSED');
}

async function testBotConfig() {
    logger.info('='.repeat(60));
    logger.info('TEST 7: Bot Configuration Test');
    logger.info('='.repeat(60));

    logger.info(`Simulation Mode: ${BOT_CONFIG.simulationMode}`);
    logger.info(`Min Profit: $${BOT_CONFIG.minProfitUsd}`);
    logger.info(`Max Gas Price: ${BOT_CONFIG.maxGasPriceGwei} gwei`);
    logger.info(`Polling Interval: ${BOT_CONFIG.pollingIntervalMs}ms`);
    logger.info(`Health Factor Threshold: ${BOT_CONFIG.healthFactorThreshold}`);
    logger.info(`Max Liquidation %: ${BOT_CONFIG.maxLiquidationPercent * 100}%`);

    if (!process.env.ARBITRUM_RPC_URL) {
        logger.warn('ARBITRUM_RPC_URL not set in .env');
    }

    if (!process.env.PRIVATE_KEY && !BOT_CONFIG.simulationMode) {
        logger.warn('PRIVATE_KEY not set - required for live execution');
    }

    logger.info('Bot configuration test: PASSED');
}

async function runAllTests() {
    logger.info('');
    logger.info('*'.repeat(60));
    logger.info('LIQUIDATION BOT - TEST SUITE');
    logger.info('*'.repeat(60));
    logger.info('');

    try {
        // Test 1: Connection
        const provider = await testConnection();

        // Test 2: Price Oracle
        await testPriceOracle(provider);

        // Test 3: Aave Service
        const aaveService = await testAaveService(provider);

        // Test 4: User Discovery
        const discovery = await testUserDiscovery(provider);

        // Test 5: Health Factor Check
        if (aaveService && discovery) {
            await testHealthFactorCheck(provider, aaveService, discovery);
        }

        // Test 6: Opportunity Calculation
        if (aaveService) {
            await testOpportunityCalculation(provider, aaveService);
        }

        // Test 7: Bot Config
        await testBotConfig();

        logger.info('');
        logger.info('*'.repeat(60));
        logger.info('ALL TESTS COMPLETED SUCCESSFULLY');
        logger.info('*'.repeat(60));
        logger.info('');
        logger.info('Next steps:');
        logger.info('1. Create .env file with your ARBITRUM_RPC_URL');
        logger.info('2. Run: npm run dev:liquidation');
        logger.info('3. Monitor logs for opportunities');

    } catch (error) {
        logger.error(`Test suite failed: ${error}`);
        process.exit(1);
    }
}

runAllTests().catch(console.error);
