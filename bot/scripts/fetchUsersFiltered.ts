import { ethers, JsonRpcProvider, Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const AAVE_POOL_ABI = [
    'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
];

const MULTICALL3_ABI = [
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])',
];

const EVENT_SIGNATURES = {
    Supply: '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61',
    Borrow: '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0',
};

const RPC_ENDPOINTS = [
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.drpc.org',
    'https://arbitrum.meowrpc.com',
    'https://arb1.arbitrum.io/rpc',
];

interface UserWithDebt {
    address: string;
    debt: number;
    collateral: number;
    healthFactor: number;
}

async function getProvider(): Promise<JsonRpcProvider> {
    for (const url of RPC_ENDPOINTS) {
        try {
            const provider = new JsonRpcProvider(url, 42161, { staticNetwork: true });
            await provider.getBlockNumber();
            console.log(`✅ Using RPC: ${url.split('/')[2]}`);
            return provider;
        } catch {
            continue;
        }
    }
    throw new Error('No working RPC');
}

async function fetchUserAddresses(provider: JsonRpcProvider, blocksBack: number): Promise<Set<string>> {
    const users = new Set<string>();
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = currentBlock - blocksBack;

    console.log(`\n📊 Fetching users from last ${blocksBack.toLocaleString()} blocks...`);

    const BATCH_SIZE = 100000;
    for (let start = fromBlock; start < currentBlock; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE - 1, currentBlock);
        const progress = ((start - fromBlock) / blocksBack * 100).toFixed(0);
        process.stdout.write(`\r   Progress: ${progress}% | Users found: ${users.size}`);

        try {
            const logs = await provider.getLogs({
                address: AAVE_POOL,
                topics: [[EVENT_SIGNATURES.Supply, EVENT_SIGNATURES.Borrow]],
                fromBlock: start,
                toBlock: end,
            });

            for (const log of logs) {
                if (log.topics.length >= 3) {
                    users.add('0x' + log.topics[2].slice(26).toLowerCase());
                }
            }
        } catch (error: any) {
            // Split if range too large
            if (error.code === -32005 || error.message?.includes('range')) {
                const mid = Math.floor((start + end) / 2);
                try {
                    const [logs1, logs2] = await Promise.all([
                        provider.getLogs({ address: AAVE_POOL, topics: [[EVENT_SIGNATURES.Supply, EVENT_SIGNATURES.Borrow]], fromBlock: start, toBlock: mid }),
                        provider.getLogs({ address: AAVE_POOL, topics: [[EVENT_SIGNATURES.Supply, EVENT_SIGNATURES.Borrow]], fromBlock: mid + 1, toBlock: end }),
                    ]);
                    for (const log of [...logs1, ...logs2]) {
                        if (log.topics.length >= 3) {
                            users.add('0x' + log.topics[2].slice(26).toLowerCase());
                        }
                    }
                } catch {
                    // Skip on error
                }
            }
        }
    }

    console.log(`\n   ✅ Found ${users.size} unique addresses\n`);
    return users;
}

async function filterUsersWithDebt(
    provider: JsonRpcProvider,
    users: string[]
): Promise<UserWithDebt[]> {
    const poolContract = new Contract(AAVE_POOL, AAVE_POOL_ABI, provider);
    const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider);
    const usersWithDebt: UserWithDebt[] = [];

    console.log(`🔍 Filtering users with active debt...`);

    const BATCH_SIZE = 100;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
        const batch = users.slice(i, i + BATCH_SIZE);
        const progress = ((i / users.length) * 100).toFixed(0);
        process.stdout.write(`\r   Progress: ${progress}% | With debt: ${usersWithDebt.length}`);

        try {
            // Prepare multicall
            const calls = batch.map(user => ({
                target: AAVE_POOL,
                allowFailure: true,
                callData: poolContract.interface.encodeFunctionData('getUserAccountData', [user]),
            }));

            const results = await multicall.aggregate3.staticCall(calls);

            for (let j = 0; j < results.length; j++) {
                if (results[j].success) {
                    try {
                        const decoded = poolContract.interface.decodeFunctionResult(
                            'getUserAccountData',
                            results[j].returnData
                        );

                        const totalDebt = Number(decoded[1]) / 1e8; // USD with 8 decimals
                        const totalCollateral = Number(decoded[0]) / 1e8;
                        const healthFactor = Number(decoded[5]) / 1e18;

                        // Só salva se tem dívida > $10
                        if (totalDebt > 10) {
                            usersWithDebt.push({
                                address: batch[j],
                                debt: totalDebt,
                                collateral: totalCollateral,
                                healthFactor: healthFactor > 100 ? 999 : healthFactor,
                            });
                        }
                    } catch {
                        // Skip decode errors
                    }
                }
            }
        } catch (error) {
            // Skip batch on error
        }

        // Small delay
        await new Promise(r => setTimeout(r, 50));
    }

    console.log(`\n   ✅ Found ${usersWithDebt.length} users with active debt\n`);

    // Sort by debt (highest first)
    return usersWithDebt.sort((a, b) => b.debt - a.debt);
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('   Aave V3 Arbitrum - FILTERED User Discovery');
    console.log('   (Only users with active debt)');
    console.log('═══════════════════════════════════════════════════════════\n');

    const startTime = Date.now();
    const provider = await getProvider();

    // Busca 3 milhões de blocos (~3 meses)
    const allUsers = await fetchUserAddresses(provider, 3_000_000);
    const usersArray = Array.from(allUsers);

    // Filtra apenas os com dívida
    const usersWithDebt = await filterUsersWithDebt(provider, usersArray);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Prepara dados
    const outputData = {
        timestamp: new Date().toISOString(),
        source: 'Filtered Discovery (only users with debt)',
        network: 'Arbitrum',
        protocol: 'Aave V3',
        fetchDuration: `${elapsed}s`,
        totalAddressesScanned: usersArray.length,
        usersWithDebt: usersWithDebt.length,
        users: usersWithDebt,
    };

    // Salva
    const dataDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const filePath = path.join(dataDir, 'active-users.json');
    fs.writeFileSync(filePath, JSON.stringify(outputData, null, 2));

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`✅ SUCCESS!`);
    console.log(`   Total addresses scanned: ${usersArray.length.toLocaleString()}`);
    console.log(`   Users with active debt: ${usersWithDebt.length}`);
    console.log(`   Time: ${elapsed}s`);
    console.log(`   Saved to: ${filePath}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Top 10
    console.log('Top 10 users by debt:');
    usersWithDebt.slice(0, 10).forEach((u, i) => {
        console.log(`  ${i + 1}. ${u.address}`);
        console.log(`     Debt: $${u.debt.toLocaleString()} | HF: ${u.healthFactor.toFixed(2)}`);
    });

    // Users with low HF
    const lowHF = usersWithDebt.filter(u => u.healthFactor < 1.5);
    console.log(`\n⚠️ Users with HF < 1.5: ${lowHF.length}`);
    lowHF.slice(0, 5).forEach((u, i) => {
        console.log(`  ${i + 1}. ${u.address} | HF: ${u.healthFactor.toFixed(3)} | Debt: $${u.debt.toLocaleString()}`);
    });
}

main().catch(console.error);
