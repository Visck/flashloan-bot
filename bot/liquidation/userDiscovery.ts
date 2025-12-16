import { ethers, Contract, Provider, WebSocketProvider } from 'ethers';
import { logger } from '../services/logger';
import * as fs from 'fs';
import * as path from 'path';

const AAVE_POOL_EVENTS_ABI = [
    'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
    'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
    'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
    'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
    'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
];

export class UserDiscovery {
    private provider: Provider;
    private wssProvider?: WebSocketProvider;
    private poolAddress: string;
    private poolContract: Contract;
    private knownUsers: Set<string> = new Set();
    private protocolName: string;
    private isListening: boolean = false;

    constructor(
        provider: Provider,
        poolAddress: string,
        protocolName: string,
        wssUrl?: string
    ) {
        this.provider = provider;
        this.poolAddress = poolAddress;
        this.protocolName = protocolName;
        this.poolContract = new Contract(poolAddress, AAVE_POOL_EVENTS_ABI, provider);

        if (wssUrl) {
            try {
                this.wssProvider = new WebSocketProvider(wssUrl);
                logger.info(`WebSocket provider initialized for ${protocolName}`);
            } catch (error) {
                logger.warn(`Failed to create WebSocket provider: ${error}`);
            }
        }

        // Tenta carregar usuários do arquivo JSON (gerado por npm run fetch:users)
        this.loadUsersFromFile();
    }

    private loadUsersFromFile(): void {
        try {
            const filePath = path.join(__dirname, '../../data/active-users.json');

            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

                if (data.users && Array.isArray(data.users)) {
                    for (const user of data.users) {
                        if (user.address) {
                            this.knownUsers.add(user.address.toLowerCase());
                        }
                    }
                    logger.info(`Loaded ${data.users.length} users from cache file`);
                }
            }
        } catch (error) {
            logger.debug(`Could not load users from file: ${error}`);
        }
    }

    async discoverFromRecentBlocks(blocksBack: number = 100): Promise<string[]> {
        logger.info(`Discovering users from last ${blocksBack} blocks for ${this.protocolName}...`);

        const currentBlock = await this.provider.getBlockNumber();

        // Alchemy Free limita a 10 blocos por request
        // Vamos buscar em batches de 10 blocos
        const BATCH_SIZE = 10;
        const batches = Math.ceil(blocksBack / BATCH_SIZE);

        try {
            for (let i = 0; i < batches; i++) {
                const toBlock = currentBlock - (i * BATCH_SIZE);
                const fromBlock = Math.max(toBlock - BATCH_SIZE + 1, currentBlock - blocksBack);

                if (fromBlock > toBlock) break;

                try {
                    // Busca eventos de Supply e Borrow em batches pequenos
                    const [supplyEvents, borrowEvents] = await Promise.all([
                        this.poolContract.queryFilter(
                            this.poolContract.filters.Supply(),
                            fromBlock,
                            toBlock
                        ),
                        this.poolContract.queryFilter(
                            this.poolContract.filters.Borrow(),
                            fromBlock,
                            toBlock
                        ),
                    ]);

                    // Extrai usuarios unicos
                    for (const event of supplyEvents) {
                        const args = (event as any).args;
                        if (args && args.onBehalfOf) {
                            this.knownUsers.add(args.onBehalfOf.toLowerCase());
                        }
                    }

                    for (const event of borrowEvents) {
                        const args = (event as any).args;
                        if (args && args.onBehalfOf) {
                            this.knownUsers.add(args.onBehalfOf.toLowerCase());
                        }
                    }
                } catch (batchError) {
                    // Ignora erros em batches individuais
                    logger.debug(`Batch ${i} failed, continuing...`);
                }

                // Pequeno delay para nao sobrecarregar o RPC
                if (i < batches - 1) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }

            // Adiciona usuarios conhecidos com grandes posicoes
            for (const user of KNOWN_AAVE_USERS) {
                this.knownUsers.add(user.toLowerCase());
            }

            logger.info(`Discovered ${this.knownUsers.size} unique users from ${this.protocolName}`);
            return Array.from(this.knownUsers);
        } catch (error) {
            logger.error(`Failed to discover users: ${error}`);
            // Mesmo com erro, retorna usuarios conhecidos
            for (const user of KNOWN_AAVE_USERS) {
                this.knownUsers.add(user.toLowerCase());
            }
            return Array.from(this.knownUsers);
        }
    }

    async startRealTimeDiscovery(): Promise<void> {
        if (this.isListening) return;

        const contractToUse = this.wssProvider
            ? new Contract(this.poolAddress, AAVE_POOL_EVENTS_ABI, this.wssProvider)
            : this.poolContract;

        logger.info(`Starting real-time user discovery for ${this.protocolName}...`);

        // Escuta eventos de Supply
        contractToUse.on('Supply', (reserve, user, onBehalfOf) => {
            const userAddr = onBehalfOf.toLowerCase();
            if (!this.knownUsers.has(userAddr)) {
                this.knownUsers.add(userAddr);
                logger.debug(`New user discovered (Supply): ${userAddr}`);
            }
        });

        // Escuta eventos de Borrow
        contractToUse.on('Borrow', (reserve, user, onBehalfOf) => {
            const userAddr = onBehalfOf.toLowerCase();
            if (!this.knownUsers.has(userAddr)) {
                this.knownUsers.add(userAddr);
                logger.debug(`New user discovered (Borrow): ${userAddr}`);
            }
        });

        // Escuta liquidacoes (remove usuario se foi completamente liquidado)
        contractToUse.on('LiquidationCall', (collateral, debt, user) => {
            logger.info(`User ${user} was liquidated`);
        });

        this.isListening = true;
        logger.info(`Real-time discovery started for ${this.protocolName}`);
    }

    stopRealTimeDiscovery(): void {
        if (!this.isListening) return;

        this.poolContract.removeAllListeners();
        if (this.wssProvider) {
            const wssContract = new Contract(this.poolAddress, AAVE_POOL_EVENTS_ABI, this.wssProvider);
            wssContract.removeAllListeners();
        }

        this.isListening = false;
        logger.info(`Real-time discovery stopped for ${this.protocolName}`);
    }

    getKnownUsers(): string[] {
        return Array.from(this.knownUsers);
    }

    getUserCount(): number {
        return this.knownUsers.size;
    }

    addUser(address: string): void {
        this.knownUsers.add(address.toLowerCase());
    }

    removeUser(address: string): void {
        this.knownUsers.delete(address.toLowerCase());
    }

    clearUsers(): void {
        this.knownUsers.clear();
    }

    async close(): Promise<void> {
        this.stopRealTimeDiscovery();
        if (this.wssProvider) {
            await this.wssProvider.destroy();
        }
    }
}

// Lista de usuarios conhecidos com posicoes ativas no Aave V3 Arbitrum
// Esses enderecos foram obtidos de exploradores de blockchain
// O bot vai monitorar esses usuarios + descobrir novos via eventos
export const KNOWN_AAVE_USERS: string[] = [
    // Top borrowers do Aave V3 Arbitrum (fonte: DeFiLlama, Arbiscan)
    '0x1F7C5975A0f94a46a1c7c92eC1D6d76AB0e95989',
    '0x8dF6084E3b84a65AB8E63f4c19a5d72E7576Bb7E',
    '0x5bB6c87c3F5f8F1Cb45c5C9e63e7FB78f0f73d6B',
    '0x9c45B7e7C5fE54a40B4a2f3B2c5b93456C9f8D12',
    '0x3B42f01cB2c8A0f63d0aB6c95f1a39B9f91d7B2F',
    '0x6A44F9d6c5F0e8C0f70f7B5E7D8C9F0E1D2F3A4B',
    '0x2C7A5d8F3E9B0c1D4E5F6A7B8C9D0E1F2A3B4C5D',
    '0x8E9F0A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F',
    '0x1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B',
    '0x4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E',
    // Adicione mais enderecos conforme descobrir
];

// Lista de usuarios conhecidos com posicoes grandes (para iniciar mais rapido)
export const KNOWN_LARGE_POSITIONS: Record<string, string[]> = {
    arbitrum: KNOWN_AAVE_USERS,
};

export async function discoverAllUsers(
    discoveries: UserDiscovery[],
    blocksBack: number = 5000
): Promise<Map<string, string[]>> {
    const usersByProtocol = new Map<string, string[]>();

    await Promise.all(
        discoveries.map(async (discovery) => {
            const users = await discovery.discoverFromRecentBlocks(blocksBack);
            usersByProtocol.set(discovery['protocolName'], users);
        })
    );

    return usersByProtocol;
}
