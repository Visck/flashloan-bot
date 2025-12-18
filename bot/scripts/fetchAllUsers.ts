/**
 * Script para buscar TODOS os usuários do Aave V3 via The Graph Subgraph
 * Isso vai buscar 50.000+ usuários ao invés de apenas os recentes
 */

import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';

// Aave V3 Subgraph no The Graph (Arbitrum)
const AAVE_V3_SUBGRAPH = 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum';

// Fallback: Subgraph hospedado pela Messari
const MESSARI_SUBGRAPH = 'https://api.thegraph.com/subgraphs/name/messari/aave-v3-arbitrum';

// Subgraph descentralizado (requer API key do The Graph)
const DECENTRALIZED_SUBGRAPH = 'https://gateway.thegraph.com/api/[api-key]/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF';

interface SubgraphUser {
    id: string;
    borrowedReservesCount: number;
    collateralReservesCount: number;
}

interface SubgraphResponse {
    data?: {
        users?: SubgraphUser[];
    };
    errors?: any[];
}

async function fetchUsersFromSubgraph(
    subgraphUrl: string,
    skip: number = 0,
    first: number = 1000
): Promise<SubgraphUser[]> {
    const query = `
    {
        users(
            first: ${first},
            skip: ${skip},
            where: {
                borrowedReservesCount_gt: 0
            },
            orderBy: id,
            orderDirection: asc
        ) {
            id
            borrowedReservesCount
            collateralReservesCount
        }
    }
    `;

    try {
        const response = await fetch(subgraphUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });

        const result = (await response.json()) as SubgraphResponse;

        if (result.errors) {
            console.error('Subgraph errors:', result.errors);
            return [];
        }

        return result.data?.users || [];
    } catch (error) {
        console.error(`Fetch error: ${error}`);
        return [];
    }
}

async function fetchAllUsersWithDebt(): Promise<string[]> {
    console.log('🔍 Fetching ALL users with debt from Aave V3 Arbitrum Subgraph...\n');

    const allUsers: Set<string> = new Set();
    let skip = 0;
    const batchSize = 1000;
    let hasMore = true;
    let attempts = 0;
    const maxAttempts = 100; // Max 100k users

    // Tenta o subgraph principal primeiro
    let subgraphUrl = AAVE_V3_SUBGRAPH;

    while (hasMore && attempts < maxAttempts) {
        attempts++;
        console.log(`📦 Fetching batch ${attempts} (skip: ${skip})...`);

        const users = await fetchUsersFromSubgraph(subgraphUrl, skip, batchSize);

        if (users.length === 0) {
            // Tenta fallback se o principal falhar
            if (subgraphUrl === AAVE_V3_SUBGRAPH && skip === 0) {
                console.log('⚠️  Primary subgraph failed, trying Messari fallback...');
                subgraphUrl = MESSARI_SUBGRAPH;
                continue;
            }
            hasMore = false;
        } else {
            for (const user of users) {
                allUsers.add(user.id.toLowerCase());
            }

            console.log(`   ✅ Got ${users.length} users (total: ${allUsers.size})`);
            skip += batchSize;

            // Rate limiting - espera 200ms entre requests
            await new Promise(r => setTimeout(r, 200));
        }
    }

    console.log(`\n✅ Total unique users with debt: ${allUsers.size}`);
    return Array.from(allUsers);
}

async function fetchUsersWithCollateral(): Promise<string[]> {
    console.log('\n🔍 Fetching users with collateral (potential liquidation targets)...\n');

    const allUsers: Set<string> = new Set();
    let skip = 0;
    const batchSize = 1000;
    let hasMore = true;
    let attempts = 0;
    const maxAttempts = 100;

    const query = (skip: number, first: number) => `
    {
        users(
            first: ${first},
            skip: ${skip},
            where: {
                collateralReservesCount_gt: 0,
                borrowedReservesCount_gt: 0
            },
            orderBy: id,
            orderDirection: asc
        ) {
            id
        }
    }
    `;

    while (hasMore && attempts < maxAttempts) {
        attempts++;

        try {
            const response = await fetch(AAVE_V3_SUBGRAPH, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: query(skip, batchSize) }),
            });

            const result = (await response.json()) as SubgraphResponse;
            const users = result.data?.users || [];

            if (users.length === 0) {
                hasMore = false;
            } else {
                for (const user of users) {
                    allUsers.add(user.id.toLowerCase());
                }

                console.log(`   📦 Batch ${attempts}: ${users.length} users (total: ${allUsers.size})`);
                skip += batchSize;
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (error) {
            console.error(`Batch ${attempts} failed: ${error}`);
            hasMore = false;
        }
    }

    return Array.from(allUsers);
}

async function fetchFromBlockchainEvents(): Promise<string[]> {
    console.log('\n🔍 Fetching users from blockchain events (backup method)...\n');

    // Importa provider
    const { JsonRpcProvider, Contract } = await import('ethers');

    const rpcUrl = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
    const provider = new JsonRpcProvider(rpcUrl, 42161, { staticNetwork: true });

    const AAVE_POOL = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
    const POOL_ABI = [
        'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
        'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
    ];

    const poolContract = new Contract(AAVE_POOL, POOL_ABI, provider);
    const users: Set<string> = new Set();

    const currentBlock = await provider.getBlockNumber();
    // Busca últimos 500k blocos (~2 semanas em Arbitrum)
    const fromBlock = currentBlock - 500000;

    console.log(`   Scanning blocks ${fromBlock} to ${currentBlock}...`);

    // Busca em batches de 10k blocos
    const BATCH_SIZE = 10000;
    for (let start = fromBlock; start < currentBlock; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE - 1, currentBlock);

        try {
            const [borrowEvents, supplyEvents] = await Promise.all([
                poolContract.queryFilter(poolContract.filters.Borrow(), start, end),
                poolContract.queryFilter(poolContract.filters.Supply(), start, end),
            ]);

            for (const event of borrowEvents) {
                const args = (event as any).args;
                if (args?.onBehalfOf) {
                    users.add(args.onBehalfOf.toLowerCase());
                }
            }

            for (const event of supplyEvents) {
                const args = (event as any).args;
                if (args?.onBehalfOf) {
                    users.add(args.onBehalfOf.toLowerCase());
                }
            }

            const progress = ((end - fromBlock) / (currentBlock - fromBlock) * 100).toFixed(1);
            console.log(`   📦 Progress: ${progress}% - Users found: ${users.size}`);

        } catch (error) {
            console.log(`   ⚠️  Batch ${start}-${end} failed, continuing...`);
        }

        // Rate limiting
        await new Promise(r => setTimeout(r, 100));
    }

    return Array.from(users);
}

async function main() {
    console.log('═'.repeat(60));
    console.log('🚀 AAVE V3 ARBITRUM - FULL USER DISCOVERY');
    console.log('═'.repeat(60));
    console.log();

    const startTime = Date.now();
    const allUsers: Set<string> = new Set();

    // Método 1: Subgraph (mais rápido e completo)
    try {
        const subgraphUsers = await fetchAllUsersWithDebt();
        subgraphUsers.forEach(u => allUsers.add(u));
        console.log(`\n📊 Subgraph: ${subgraphUsers.length} users`);
    } catch (error) {
        console.error('Subgraph method failed:', error);
    }

    // Método 2: Blockchain events (backup)
    if (allUsers.size < 10000) {
        console.log('\n⚠️  Subgraph returned few users, trying blockchain events...');
        try {
            const blockchainUsers = await fetchFromBlockchainEvents();
            blockchainUsers.forEach(u => allUsers.add(u));
            console.log(`📊 Blockchain events: ${blockchainUsers.length} additional users`);
        } catch (error) {
            console.error('Blockchain method failed:', error);
        }
    }

    // Carrega usuários existentes
    const dataDir = path.join(process.cwd(), 'data');
    const filePath = path.join(dataDir, 'active-users.json');

    if (fs.existsSync(filePath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (existing.users) {
                existing.users.forEach((u: any) => {
                    if (u.address) allUsers.add(u.address.toLowerCase());
                });
            }
            console.log(`📊 Merged with existing: ${allUsers.size} total users`);
        } catch (error) {
            console.log('Could not load existing users file');
        }
    }

    // Salva resultado
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const users = Array.from(allUsers);
    const data = {
        timestamp: new Date().toISOString(),
        source: 'Subgraph + Blockchain Events',
        network: 'Arbitrum',
        protocol: 'Aave V3',
        totalUsers: users.length,
        users: users.map(address => ({ address })),
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

    console.log('\n' + '═'.repeat(60));
    console.log('✅ DISCOVERY COMPLETE');
    console.log('═'.repeat(60));
    console.log(`📊 Total unique users: ${users.length}`);
    console.log(`📁 Saved to: ${filePath}`);
    console.log(`⏱️  Duration: ${duration} minutes`);
    console.log('═'.repeat(60));
}

main().catch(console.error);
