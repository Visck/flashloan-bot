/**
 * ============================================================================
 * LIQUIDATION BOT - EXPORTS
 * ============================================================================
 */

// Config
export {
    BOT_CONFIG,
    CHAINS,
    OPTIMIZATION_CONFIG,
    AAVE_POOL_ABI,
    AAVE_DATA_PROVIDER_ABI,
    AAVE_ORACLE_ABI,
    ERC20_ABI
} from './liquidationConfig';
export type {
    ProtocolConfig,
    ChainConfig,
    OptimizationPreset
} from './liquidationConfig';

// Aave Service
export { AaveService } from './aaveService';
export type {
    UserAccountData,
    UserReserveData,
    LiquidationOpportunity,
    ReserveInfo
} from './aaveService';

// User Discovery
export { UserDiscovery, KNOWN_AAVE_USERS, discoverAllUsers } from './userDiscovery';

// Radiant Service
export { createLendingService } from './radiantService';

// ============================================================================
// OPTIMIZATION MODULES (CU Savings)
// ============================================================================

// Subgraph Service
export { SubgraphService, createSubgraphService } from './subgraphService';
export type { SubgraphUser, SubgraphUserReserve, SubgraphConfig } from './subgraphService';

// Multicall Service
export { MulticallService, createMulticallService } from './multicallService';
export type { Call, CallResult, DecodedCallResult } from './multicallService';

// Cache Service
export { CacheService, cache, createCacheService } from './cacheService';

// Rate Limiter
export { RateLimiter, rateLimiter, createRateLimiter } from './rateLimiter';
export type { RateLimiterConfig } from './rateLimiter';

// Optimized Config
export {
    CU_COSTS,
    FREE_TIER_CONFIG,
    PAID_TIER_CONFIG,
    ULTRA_ECONOMY_CONFIG,
    CUTracker,
    cuTracker,
    getConfigForPlan,
    estimateCUs,
    calculateMulticallSavings
} from './optimizedConfig';
export type { OptimizationConfig } from './optimizedConfig';

// Gas Strategy
export { GasStrategy, createGasStrategy } from './gasStrategy';
export type { GasEstimate, GasConfig, NetworkConditions } from './gasStrategy';

// RPC Manager
export { RPCManager, createRPCManager } from './rpcManager';
export type { RPCConfig, RPCHealth } from './rpcManager';

// User Prioritizer
export { UserPrioritizer, createUserPrioritizer } from './userPrioritizer';
export type {
    UserPosition,
    PrioritizedUser,
    RiskLevel,
    CollateralAsset,
    DebtAsset,
    PrioritizationConfig
} from './userPrioritizer';

// Realtime Monitor
export { RealtimeMonitor, createRealtimeMonitor } from './realtimeMonitor';
export type { MonitorConfig, MonitorStats } from './realtimeMonitor';

// Metrics
export { MetricsService, metrics, createMetricsService } from './metrics';
export type { BotMetrics, LiquidationRecord } from './metrics';

// Telegram Service
export { TelegramService, createTelegramService } from './telegramService';
export type { TelegramConfig, NotificationOptions } from './telegramService';
