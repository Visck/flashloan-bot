import { Provider, Wallet } from 'ethers';
import { AaveService, LiquidationOpportunity, UserAccountData, ReserveInfo } from './aaveService';
import { ProtocolConfig } from './liquidationConfig';
import { ProtocolConfig as ProtocolConfigV2 } from './liquidationConfigV2';
import { logger } from '../services/logger';

// Radiant usa a mesma interface do Aave V2/V3, entao podemos extender AaveService
export class RadiantService extends AaveService {
    constructor(provider: Provider, config: ProtocolConfig) {
        super(provider, config);
    }

    async initialize(): Promise<void> {
        logger.info(`Initializing Radiant Capital service...`);
        await super.initialize();
        logger.info(`Radiant Capital initialized successfully`);
    }

    // Override para ajustar calculo de bonus especifico do Radiant
    async calculateLiquidationOpportunity(
        user: string,
        accountData: UserAccountData
    ): Promise<LiquidationOpportunity | null> {
        const opportunity = await super.calculateLiquidationOpportunity(user, accountData);

        if (opportunity) {
            // Radiant tem bonus maior (7.5% vs 5% do Aave)
            // O bonus ja deve estar correto pois vem do contrato
            logger.debug(`Radiant opportunity for ${user}: ${opportunity.netProfitUsd} USD`);
        }

        return opportunity;
    }
}

// Factory para criar o servico correto baseado no tipo
// Aceita tanto ProtocolConfig V1 quanto V2
export function createLendingService(
    provider: Provider,
    config: ProtocolConfig | ProtocolConfigV2
): AaveService | RadiantService {
    // Converte para o tipo base que AaveService espera
    const baseConfig: ProtocolConfig = {
        name: config.name,
        type: config.type === 'aave' || config.type === 'radiant' ? config.type : 'aave',
        poolAddress: config.poolAddress,
        poolDataProvider: config.poolDataProvider,
        oracleAddress: config.oracleAddress,
        liquidationBonus: config.liquidationBonus,
        enabled: config.enabled,
    };

    switch (config.type) {
        case 'radiant':
            return new RadiantService(provider, baseConfig);
        case 'aave':
        case 'compound':
        case 'silo':
        default:
            // Para compound e silo, usamos AaveService como base
            // TODO: Criar serviços específicos se necessário
            return new AaveService(provider, baseConfig);
    }
}
