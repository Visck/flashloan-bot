import { ethers, JsonRpcProvider } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Aave V3 Pool on Arbitrum
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

// Event signatures (keccak256 hashes)
const EVENT_SIGNATURES = {
    Supply: '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61',
    Borrow: '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0',
};

// Multiple RPC endpoints for parallel fetching
const RPC_ENDPOINTS = [
    'https://arbitrum-one-rpc.publicnode.com',
    'https://1rpc.io/arb',
    'https://arbitrum.drpc.org',
    'https://arbitrum.meowrpc.com',
    'https://arb1.arbitrum.io/rpc',
];

interface UserData {
    address: string;
    lastSeen: number;
    eventCount: number;
}

const users = new Map<string, UserData>();
let totalLogsProcessed = 0;

async function fetchLogsInRange(
    provider: JsonRpcProvider,
    fromBlock: number,
    toBlock: number,
    retries = 3
): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const logs = await provider.getLogs({
                address: AAVE_POOL,
                topics: [[EVENT_SIGNATURES.Supply, EVENT_SIGNATURES.Borrow]],
                fromBlock,
                toBlock,
            });

            for (const log of logs) {
                if (log.topics.length >= 3) {
                    const userAddress = '0x' + log.topics[2].slice(26).toLowerCase();
                    const existing = users.get(userAddress);
                    if (existing) {
                        existing.eventCount++;
                        existing.lastSeen = Math.max(existing.lastSeen, log.blockNumber);
                    } else {
                        users.set(userAddress, {
                            address: userAddress,
                            lastSeen: log.blockNumber,
                            eventCount: 1,
                        });
                    }
                }
            }
            totalLogsProcessed += logs.length;
            return;
        } catch (error: any) {
            if (error.message?.includes('range') || error.message?.includes('limit') || error.code === -32005) {
                // Range too large, split in half
                const midBlock = Math.floor((fromBlock + toBlock) / 2);
                await fetchLogsInRange(provider, fromBlock, midBlock, retries);
                await fetchLogsInRange(provider, midBlock + 1, toBlock, retries);
                return;
            }
            if (attempt === retries - 1) {
                // Skip this range on final failure
                return;
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

async function getWorkingProviders(): Promise<JsonRpcProvider[]> {
    const providers: JsonRpcProvider[] = [];

    for (const url of RPC_ENDPOINTS) {
        try {
            const provider = new JsonRpcProvider(url, 42161, { staticNetwork: true });
            await provider.getBlockNumber();
            providers.push(provider);
        } catch {
            continue;
        }
    }

    return providers;
}

async function main() {
    const MAX_RUNTIME_MS = 10 * 60 * 1000; // 10 minutes
    const startTime = Date.now();

    console.log('═══════════════════════════════════════════════════════════');
    console.log('   Aave V3 Arbitrum - MAXIMUM User Discovery (10 min)');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('🔍 Finding working RPC endpoints...');
    const providers = await getWorkingProviders();
    console.log(`✅ Found ${providers.length} working RPCs\n`);

    if (providers.length === 0) {
        console.error('❌ No working RPC found');
        process.exit(1);
    }

    const currentBlock = await providers[0].getBlockNumber();

    // Fetch as much history as possible - 3 million blocks (~3 months on Arbitrum)
    const TOTAL_BLOCKS = 3_000_000;
    const fromBlock = currentBlock - TOTAL_BLOCKS;

    console.log(`Current block: ${currentBlock}`);
    console.log(`Fetching from block: ${fromBlock}`);
    console.log(`Total blocks to scan: ${TOTAL_BLOCKS.toLocaleString()}\n`);

    // Split work among providers
    const BATCH_SIZE = 100_000; // 100k blocks per batch
    const batches: { from: number; to: number }[] = [];

    for (let block = fromBlock; block < currentBlock; block += BATCH_SIZE) {
        batches.push({
            from: block,
            to: Math.min(block + BATCH_SIZE - 1, currentBlock),
        });
    }

    console.log(`Total batches: ${batches.length}`);
    console.log(`Using ${providers.length} RPCs in parallel\n`);

    let batchIndex = 0;
    const CONCURRENT_REQUESTS = providers.length * 2; // 2 requests per RPC

    const processBatch = async (providerIndex: number): Promise<void> => {
        while (batchIndex < batches.length) {
            const elapsed = Date.now() - startTime;
            if (elapsed >= MAX_RUNTIME_MS) {
                return;
            }

            const currentBatch = batchIndex++;
            if (currentBatch >= batches.length) return;

            const batch = batches[currentBatch];
            const provider = providers[providerIndex % providers.length];

            const progress = ((currentBatch / batches.length) * 100).toFixed(1);
            const timeLeft = Math.round((MAX_RUNTIME_MS - elapsed) / 1000);

            process.stdout.write(`\r⏳ Progress: ${progress}% | Users: ${users.size.toLocaleString()} | Events: ${totalLogsProcessed.toLocaleString()} | Time left: ${timeLeft}s   `);

            try {
                await fetchLogsInRange(provider, batch.from, batch.to);
            } catch (error) {
                // Continue on error
            }

            // Small delay to avoid rate limits
            await new Promise(r => setTimeout(r, 50));
        }
    };

    // Run concurrent workers
    const workers = [];
    for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
        workers.push(processBatch(i));
    }

    // Wait for all workers or timeout
    await Promise.race([
        Promise.all(workers),
        new Promise(resolve => setTimeout(resolve, MAX_RUNTIME_MS)),
    ]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n\n✅ Fetch complete!`);
    console.log(`   Time: ${elapsed}s`);
    console.log(`   Users found: ${users.size.toLocaleString()}`);
    console.log(`   Events processed: ${totalLogsProcessed.toLocaleString()}\n`);

    // Convert to array and sort by activity
    const usersArray = Array.from(users.values())
        .sort((a, b) => b.eventCount - a.eventCount);

    // Save to file
    const outputData = {
        timestamp: new Date().toISOString(),
        source: 'Blockchain Events (Maximum Fetch)',
        network: 'Arbitrum',
        protocol: 'Aave V3',
        fetchDuration: `${elapsed}s`,
        blocksScanned: TOTAL_BLOCKS,
        eventsProcessed: totalLogsProcessed,
        totalUsers: usersArray.length,
        users: usersArray.map(u => ({
            address: u.address,
            eventCount: u.eventCount,
            lastSeen: u.lastSeen,
        })),
    };

    const dataDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const filePath = path.join(dataDir, 'active-users.json');
    fs.writeFileSync(filePath, JSON.stringify(outputData, null, 2));

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`✅ SUCCESS! Found ${usersArray.length.toLocaleString()} users`);
    console.log(`📁 Saved to: ${filePath}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Show top users
    console.log('Top 10 most active users:');
    usersArray.slice(0, 10).forEach((user, i) => {
        console.log(`  ${i + 1}. ${user.address} (${user.eventCount} events)`);
    });
}

main().catch(console.error);
