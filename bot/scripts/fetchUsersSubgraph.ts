import * as fs from 'fs';
import * as path from 'path';

// Aave V3 Arbitrum Subgraph (Messari)
// Alternative endpoints if one doesn't work:
const SUBGRAPH_ENDPOINTS = [
    'https://api.studio.thegraph.com/query/42519/aave-v3-arbitrum/version/latest',
    'https://gateway-arbitrum.network.thegraph.com/api/[api-key]/subgraphs/id/Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g',
];

const AAVE_V3_SUBGRAPH = SUBGRAPH_ENDPOINTS[0];

// Query para buscar usuários com posições ativas
const USERS_QUERY = `
query GetUsers($skip: Int!, $first: Int!) {
  users(
    first: $first
    skip: $skip
    where: { borrowedReservesCount_gt: 0 }
    orderBy: borrowedReservesCount
    orderDirection: desc
  ) {
    id
    borrowedReservesCount
  }
}
`;

// Query alternativa para buscar por posições (mais dados)
const POSITIONS_QUERY = `
query GetPositions($skip: Int!, $first: Int!) {
  userReserves(
    first: $first
    skip: $skip
    where: { currentTotalDebt_gt: "0" }
    orderBy: currentTotalDebt
    orderDirection: desc
  ) {
    user {
      id
    }
    currentTotalDebt
  }
}
`;

interface SubgraphUser {
    id: string;
    borrowedReservesCount?: number;
}

interface SubgraphPosition {
    user: { id: string };
    currentTotalDebt: string;
}

interface SubgraphResponse {
    data?: any;
    errors?: any[];
}

async function querySubgraph(query: string, variables: Record<string, any>): Promise<any> {
    const response = await fetch(AAVE_V3_SUBGRAPH, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
        throw new Error(`Subgraph request failed: ${response.status}`);
    }

    const result = (await response.json()) as SubgraphResponse;

    if (result.errors) {
        throw new Error(`Subgraph query error: ${JSON.stringify(result.errors)}`);
    }

    return result.data;
}

async function fetchAllUsers(): Promise<string[]> {
    const users = new Set<string>();
    const batchSize = 1000;
    let skip = 0;
    let hasMore = true;

    console.log('🔍 Fetching users from Aave V3 Subgraph...\n');

    // Método 1: Buscar usuários diretamente
    console.log('📊 Method 1: Fetching users with active borrows...');
    while (hasMore) {
        try {
            const data = await querySubgraph(USERS_QUERY, {
                skip,
                first: batchSize,
            });

            const fetchedUsers: SubgraphUser[] = data.users || [];

            if (fetchedUsers.length === 0) {
                hasMore = false;
            } else {
                for (const user of fetchedUsers) {
                    users.add(user.id.toLowerCase());
                }
                skip += batchSize;
                console.log(`   Found ${users.size} users so far...`);

                // Pequeno delay para não sobrecarregar
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (error) {
            console.log(`   Error at skip ${skip}: ${error}`);
            hasMore = false;
        }
    }

    console.log(`\n✅ Method 1 complete: ${users.size} users\n`);

    // Método 2: Buscar por posições (pode encontrar mais usuários)
    console.log('📊 Method 2: Fetching users from positions...');
    skip = 0;
    hasMore = true;
    let positionsChecked = 0;

    while (hasMore && positionsChecked < 10000) {
        try {
            const data = await querySubgraph(POSITIONS_QUERY, {
                skip,
                first: batchSize,
            });

            const positions: SubgraphPosition[] = data.userReserves || [];

            if (positions.length === 0) {
                hasMore = false;
            } else {
                for (const position of positions) {
                    users.add(position.user.id.toLowerCase());
                }
                skip += batchSize;
                positionsChecked += positions.length;
                console.log(`   Checked ${positionsChecked} positions, ${users.size} unique users...`);

                await new Promise(r => setTimeout(r, 200));
            }
        } catch (error) {
            console.log(`   Error at skip ${skip}: ${error}`);
            hasMore = false;
        }
    }

    console.log(`\n✅ Method 2 complete: ${users.size} total unique users\n`);

    return Array.from(users);
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('   Aave V3 Arbitrum - User Discovery via TheGraph');
    console.log('═══════════════════════════════════════════════════════════\n');

    try {
        const users = await fetchAllUsers();

        // Prepara dados para salvar
        const outputData = {
            timestamp: new Date().toISOString(),
            source: 'TheGraph Subgraph',
            network: 'Arbitrum',
            protocol: 'Aave V3',
            totalUsers: users.length,
            users: users.map(address => ({
                address,
                source: 'subgraph',
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
        console.log(`✅ SUCCESS! Found ${users.length} users`);
        console.log(`📁 Saved to: ${filePath}`);
        console.log('═══════════════════════════════════════════════════════════\n');

        // Mostra alguns exemplos
        console.log('Sample users:');
        users.slice(0, 5).forEach((user, i) => {
            console.log(`  ${i + 1}. ${user}`);
        });

    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

main();
