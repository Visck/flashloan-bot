/**
 * Script para buscar usuários com posições ativas no Aave V3 Arbitrum
 *
 * Execute: npx ts-node bot/scripts/fetchUsers.ts
 *
 * Este script busca eventos históricos para encontrar endereços de usuários
 * com posições de empréstimo ativas.
 */

import { ethers, JsonRpcProvider, Contract } from 'ethers';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

const AAVE_POOL_ABI = [
    'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
    'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
    'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
];

// RPCs para usar (fallback)
const RPCS = [
    'https://arbitrum.meowrpc.com',
    'https://arbitrum.drpc.org',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://1rpc.io/arb',
    process.env.ARBITRUM_RPC_URL,
].filter(Boolean) as string[];

async function fetchUsersFromEvents(
    provider: JsonRpcProvider,
    contract: Contract,
    fromBlock: number,
    toBlock: number,
    batchSize: number = 10
): Promise<Set<string>> {
    const users = new Set<string>();

    console.log(`Fetching events from block ${fromBlock} to ${toBlock}...`);

    for (let start = fromBlock; start <= toBlock; start += batchSize) {
        const end = Math.min(start + batchSize - 1, toBlock);

        try {
            const [supplyEvents, borrowEvents] = await Promise.all([
                contract.queryFilter(contract.filters.Supply(), start, end),
                contract.queryFilter(contract.filters.Borrow(), start, end),
            ]);

            for (const event of supplyEvents) {
                const args = (event as any).args;
                if (args?.onBehalfOf) {
                    users.add(args.onBehalfOf.toLowerCase());
                }
            }

            for (const event of borrowEvents) {
                const args = (event as any).args;
                if (args?.onBehalfOf) {
                    users.add(args.onBehalfOf.toLowerCase());
                }
            }

            // Progress
            const progress = ((start - fromBlock) / (toBlock - fromBlock) * 100).toFixed(1);
            process.stdout.write(`\rProgress: ${progress}% | Users found: ${users.size}`);

        } catch (error) {
            // Ignora erros em batches individuais
        }

        // Rate limiting
        await new Promise(r => setTimeout(r, 100));
    }

    console.log('');
    return users;
}

async function filterActiveUsers(
    provider: JsonRpcProvider,
    contract: Contract,
    users: string[]
): Promise<{ address: string; debt: number; collateral: number; healthFactor: number }[]> {
    const activeUsers: { address: string; debt: number; collateral: number; healthFactor: number }[] = [];

    console.log(`\nVerifying ${users.length} users for active positions...`);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];

        try {
            const data = await contract.getUserAccountData(user);
            const debt = Number(data[1]) / 1e8; // USD
            const collateral = Number(data[0]) / 1e8;
            const healthFactor = Number(data[5]) / 1e18;

            if (debt > 10) { // Pelo menos $10 de dívida
                activeUsers.push({
                    address: user,
                    debt,
                    collateral,
                    healthFactor,
                });
            }
        } catch (error) {
            // Ignora erros
        }

        // Progress
        const progress = ((i + 1) / users.length * 100).toFixed(1);
        process.stdout.write(`\rVerifying: ${progress}% | Active users: ${activeUsers.length}`);

        // Rate limiting
        if (i % 10 === 0) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    console.log('');
    return activeUsers;
}

async function main() {
    console.log('='.repeat(60));
    console.log('AAVE V3 USER FETCHER - ARBITRUM');
    console.log('='.repeat(60));

    // Tenta cada RPC até encontrar um que funcione
    let provider: JsonRpcProvider | null = null;

    for (const rpc of RPCS) {
        try {
            const testProvider = new JsonRpcProvider(rpc);
            await testProvider.getBlockNumber();
            provider = testProvider;
            console.log(`Using RPC: ${rpc.slice(0, 40)}...`);
            break;
        } catch {
            continue;
        }
    }

    if (!provider) {
        console.error('No working RPC found!');
        process.exit(1);
    }

    const contract = new Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);

    // Busca blocos recentes
    const currentBlock = await provider.getBlockNumber();
    const blocksToFetch = 50000; // ~1-2 dias de blocos
    const fromBlock = currentBlock - blocksToFetch;

    console.log(`\nCurrent block: ${currentBlock}`);
    console.log(`Fetching from block: ${fromBlock}`);
    console.log(`Blocks to process: ${blocksToFetch}`);
    console.log('');

    // Busca usuários dos eventos
    const users = await fetchUsersFromEvents(provider, contract, fromBlock, currentBlock);

    console.log(`\nTotal unique users from events: ${users.size}`);

    // Verifica quais têm posições ativas
    const activeUsers = await filterActiveUsers(provider, contract, Array.from(users));

    // Ordena por dívida (maior primeiro)
    activeUsers.sort((a, b) => b.debt - a.debt);

    // Salva resultados
    const outputPath = path.join(__dirname, '../../data/active-users.json');
    const outputDir = path.dirname(outputPath);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const output = {
        fetchedAt: new Date().toISOString(),
        chain: 'arbitrum',
        protocol: 'aave-v3',
        totalUsers: activeUsers.length,
        users: activeUsers,
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log('RESULTS');
    console.log('='.repeat(60));
    console.log(`Active users found: ${activeUsers.length}`);
    console.log(`Output saved to: ${outputPath}`);

    // Top 10 usuários por dívida
    console.log('\nTop 10 users by debt:');
    for (const user of activeUsers.slice(0, 10)) {
        console.log(`  ${user.address.slice(0, 10)}... | Debt: $${user.debt.toFixed(2)} | HF: ${user.healthFactor.toFixed(4)}`);
    }

    // Usuários em risco (HF < 1.5)
    const atRisk = activeUsers.filter(u => u.healthFactor < 1.5);
    console.log(`\nUsers at risk (HF < 1.5): ${atRisk.length}`);

    // Gera código para copiar pro userDiscovery.ts
    const addressesCode = activeUsers
        .slice(0, 200) // Top 200
        .map(u => `    '${u.address}',`)
        .join('\n');

    const codeOutputPath = path.join(__dirname, '../../data/users-code.txt');
    fs.writeFileSync(codeOutputPath, `// Paste this in userDiscovery.ts KNOWN_AAVE_USERS\n${addressesCode}`);

    console.log(`\nCode snippet saved to: ${codeOutputPath}`);
    console.log('Copy the addresses to bot/liquidation/userDiscovery.ts');
}

main().catch(console.error);
