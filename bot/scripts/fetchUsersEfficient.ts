import { ethers, JsonRpcProvider } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Aave V3 Pool on Arbitrum
const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

// Event signatures (keccak256 hashes)
const EVENT_SIGNATURES = {
    // Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)
    Supply: '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61',
    // Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)
    Borrow: '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0',
    // Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)
    Repay: '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051',
};

// RPC endpoints para fetch (usando múltiplos para maior velocidade)
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

async function fetchLogsInRange(
    provider: JsonRpcProvider,
    fromBlock: number,
    toBlock: number,
    topics: string[]
): Promise<ethers.Log[]> {
    try {
        const logs = await provider.getLogs({
            address: AAVE_POOL,
            topics: [topics],
            fromBlock,
            toBlock,
        });
        return logs;
    } catch (error: any) {
        // Se o range for muito grande, divide em 2
        if (error.message?.includes('range') || error.message?.includes('limit') || error.code === -32005) {
            const midBlock = Math.floor((fromBlock + toBlock) / 2);
            const [logs1, logs2] = await Promise.all([
                fetchLogsInRange(provider, fromBlock, midBlock, topics),
                fetchLogsInRange(provider, midBlock + 1, toBlock, topics),
            ]);
            return [...logs1, ...logs2];
        }
        throw error;
    }
}

async function getWorkingProvider(): Promise<{ provider: JsonRpcProvider; name: string }> {
    for (const url of RPC_ENDPOINTS) {
        try {
            const provider = new JsonRpcProvider(url, 42161, { staticNetwork: true });
            await provider.getBlockNumber();
            const name = url.includes('publicnode') ? 'PublicNode' :
                        url.includes('1rpc') ? '1RPC' :
                        url.includes('drpc') ? 'DRPC' :
                        url.includes('meowrpc') ? 'MeowRPC' : 'Arbitrum Official';
            return { provider, name };
        } catch {
            continue;
        }
    }
    throw new Error('No working RPC found');
}

async function fetchUsers(): Promise<Map<string, UserData>> {
    const users = new Map<string, UserData>();

    console.log('🔍 Finding working RPC endpoint...');
    const { provider, name } = await getWorkingProvider();
    console.log(`✅ Using: ${name}\n`);

    const currentBlock = await provider.getBlockNumber();

    // Busca os últimos 500,000 blocos (~3 semanas em Arbitrum)
    // Arbitrum tem ~1 bloco a cada 0.25s
    const BLOCKS_TO_FETCH = 500000;
    const fromBlock = currentBlock - BLOCKS_TO_FETCH;

    console.log(`Current block: ${currentBlock}`);
    console.log(`Fetching from block: ${fromBlock}`);
    console.log(`Blocks to process: ${BLOCKS_TO_FETCH}\n`);

    // Batch size adaptável - começa grande e reduz se der erro
    let batchSize = 50000;
    let currentFrom = fromBlock;

    const allTopics = Object.values(EVENT_SIGNATURES);

    while (currentFrom < currentBlock) {
        const currentTo = Math.min(currentFrom + batchSize, currentBlock);
        const progress = ((currentFrom - fromBlock) / BLOCKS_TO_FETCH * 100).toFixed(1);

        process.stdout.write(`\rProgress: ${progress}% | Blocks: ${currentFrom}-${currentTo} | Users: ${users.size}`);

        try {
            // Busca todos os eventos de uma vez
            const logs = await fetchLogsInRange(provider, currentFrom, currentTo, allTopics);

            for (const log of logs) {
                // O onBehalfOf é o segundo indexed parameter (index 2 no topics)
                // Para Supply e Borrow, o usuario está em topics[2]
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

            currentFrom = currentTo + 1;

            // Se conseguiu, tenta aumentar o batch
            if (batchSize < 100000) {
                batchSize = Math.min(batchSize * 1.5, 100000);
            }

        } catch (error: any) {
            // Reduz o batch size se der erro
            if (batchSize > 1000) {
                batchSize = Math.floor(batchSize / 2);
                console.log(`\n⚠️ Reducing batch size to ${batchSize}`);
            } else {
                console.error(`\n❌ Error: ${error.message}`);
                currentFrom += 1000; // Pula um pouco
            }
        }

        // Pequeno delay para não sobrecarregar
        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`\n\n✅ Fetch complete! Found ${users.size} unique users\n`);

    return users;
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('   Aave V3 Arbitrum - Efficient User Discovery');
    console.log('═══════════════════════════════════════════════════════════\n');

    try {
        const startTime = Date.now();
        const usersMap = await fetchUsers();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // Converte para array e ordena por atividade
        const usersArray = Array.from(usersMap.values())
            .sort((a, b) => b.eventCount - a.eventCount);

        // Prepara dados para salvar
        const outputData = {
            timestamp: new Date().toISOString(),
            source: 'Blockchain Events (eth_getLogs)',
            network: 'Arbitrum',
            protocol: 'Aave V3',
            fetchDuration: `${elapsed}s`,
            totalUsers: usersArray.length,
            users: usersArray.map(u => ({
                address: u.address,
                eventCount: u.eventCount,
                lastSeen: u.lastSeen,
            })),
        };

        // Garante que o diretório existe
        const dataDir = path.join(__dirname, '../../data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // Salva arquivo
        const filePath = path.join(dataDir, 'active-users.json');
        fs.writeFileSync(filePath, JSON.stringify(outputData, null, 2));

        console.log('═══════════════════════════════════════════════════════════');
        console.log(`✅ SUCCESS! Found ${usersArray.length} users in ${elapsed}s`);
        console.log(`📁 Saved to: ${filePath}`);
        console.log('═══════════════════════════════════════════════════════════\n');

        // Mostra top 10 usuários mais ativos
        console.log('Top 10 most active users:');
        usersArray.slice(0, 10).forEach((user, i) => {
            console.log(`  ${i + 1}. ${user.address} (${user.eventCount} events)`);
        });

    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

main();
