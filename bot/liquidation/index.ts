/**
 * ============================================================================
 * LIQUIDATION BOT - EXPORTS
 * ============================================================================
 */

// Main Bot
export { LiquidationBot, createLiquidationBot } from './liquidationBot';
export type { LiquidationBotConfig } from './liquidationBot';

// RPC Manager
export { RPCManager, createRPCManager } from './rpcManager';
export type { RPCConfig, RPCHealth } from './rpcManager';

// Gas Strategy
export { GasStrategy, createGasStrategy } from './gasStrategy';
export type { GasEstimate, GasConfig, NetworkConditions } from './gasStrategy';

// Subgraph Service
export { SubgraphService, createSubgraphService } from './subgraphService';
export type { SubgraphUser, SubgraphUserReserve, SubgraphConfig } from './subgraphService';

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

// Aave Service
export { AaveService, createAaveService, AAVE_V3_ADDRESSES } from './aaveService';
export type {
    UserAccountData,
    UserPosition as AaveUserPosition,
    AssetPosition,
    ReserveData,
    LiquidationParams
} from './aaveService';

// ============================================================================
// OPTIMIZATION MODULES (CU Savings)
// ============================================================================

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

// Optimized Aave Service
export { AaveServiceOptimized, createAaveServiceOptimized } from './aaveServiceOptimized';
