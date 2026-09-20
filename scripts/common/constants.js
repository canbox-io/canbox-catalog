/**
 * Catalog 平台无关常量
 *
 * 本模块不得出现任何平台域名、Token、平台判断。
 */

const SHARD_SIZE = 200;        // 原始数据分片大小
const CATALOG_SHARD_SIZE = 100; // 展示数据分片大小

const CANBOX_APP_FILENAME = '.canbox-app';

// 状态定义
const STATUS = {
    UNKNOWN: 'unknown',
    ACTIVE: 'active',
    WARNING: 'warning',
    CRITICAL: 'critical',
    STALE: 'stale',
    REMOVED: 'removed'
};

// catalog 过滤规则
const CATALOG_FILTER = {
    includeStatus: ['active', 'warning', 'critical'],
    includeMinScore: 30,
    excludeStatus: ['stale', 'removed']
};

// catalog 数据契约版本
const CATALOG_SCHEMA_VERSION = 2;

// 默认目录名（各平台实例的 catalog 展示名）
const DEFAULT_SOURCE_NAME = 'Canbox 官方 APP 目录';

module.exports = {
    SHARD_SIZE,
    CATALOG_SHARD_SIZE,
    CANBOX_APP_FILENAME,
    STATUS,
    CATALOG_FILTER,
    CATALOG_SCHEMA_VERSION,
    DEFAULT_SOURCE_NAME
};
