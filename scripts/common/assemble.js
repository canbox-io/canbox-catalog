/**
 * Catalog 组装（平台无关）
 *
 * 读取某平台的原始数据分片，过滤后生成 catalog.json 与 catalogs/*.json
 */

const fs = require('fs');
const path = require('path');

const { CATALOG_SHARD_SIZE, CATALOG_FILTER, CATALOG_SCHEMA_VERSION, DEFAULT_SOURCE_NAME } = require('./constants');
const { ensureDir, readAllApps, writeJsonFile } = require('./storage');
const { filterAppsForCatalog } = require('./scoring');
const { toCatalogApp } = require('./platform-adapter');

/**
 * 组装某平台实例的展示数据
 * @param {object} paths - scripts/common/paths.js 生成的路径对象
 * @param {object} [options]
 * @param {string} [options.sourceName] - 目录展示名，默认 Canbox 官方 APP 目录
 * @returns {{totalApps: number, totalShards: number}}
 */
function assembleCatalog(paths, options = {}) {
    const sourceName = options.sourceName || DEFAULT_SOURCE_NAME;

    console.log(`[assemble] Starting catalog assembly for platform: ${paths.platform}...`);

    ensureDir(paths.catalogsDir);

    // 1. 读取所有分片原始数据
    const allApps = readAllApps(paths);
    console.log(`[assemble] Total apps in raw data: ${allApps.length}`);

    // 2. 过滤
    const filteredApps = filterAppsForCatalog(allApps);
    console.log(`[assemble] Apps after filtering: ${filteredApps.length}`);

    // 3. 转换为展示格式
    const catalogApps = filteredApps.map(app => {
        return toCatalogApp(app, app._canboxApp || null, app._pkg || null, {
            stars: app.stars || 0,
            forks: app.forks || 0,
            lastCommitAt: app.lastCommitAt || null,
            createdAt: app.createdAt || null,
            license: app._pkg ? (app._pkg.license || null) : null,
            homepage: app._pkg ? (app._pkg.homepage || app.repo) : app.repo
        }, paths.platform);
    });

    // 4. 按 stars 降序排序
    catalogApps.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    // 5. 分片写入 catalogs/
    const totalShards = catalogApps.length > 0 ? Math.ceil(catalogApps.length / CATALOG_SHARD_SIZE) : 0;
    const shardInfos = [];

    for (let i = 0; i < totalShards; i++) {
        const start = i * CATALOG_SHARD_SIZE;
        const end = Math.min(start + CATALOG_SHARD_SIZE, catalogApps.length);
        const shardApps = catalogApps.slice(start, end);

        const shardId = i + 1;
        const shardData = {
            schemaVersion: CATALOG_SCHEMA_VERSION,
            shardId,
            generatedAt: new Date().toISOString(),
            apps: shardApps
        };

        const shardFilename = `catalogs/shard-${String(shardId).padStart(3, '0')}.json`;
        writeJsonFile(path.join(paths.dataDir, shardFilename), shardData);

        const scores = shardApps.map(a => a.score || 0);
        shardInfos.push({
            id: shardId,
            file: shardFilename,
            appCount: shardApps.length,
            maxScore: scores.length > 0 ? Math.max(...scores) : 0,
            minScore: scores.length > 0 ? Math.min(...scores) : 0
        });

        console.log(`[assemble] Written ${shardFilename} with ${shardApps.length} apps`);
    }

    // 6. 生成 catalog.json 索引
    const catalogIndex = {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        source: paths.platform,
        sourceName,
        totalApps: catalogApps.length,
        totalShards,
        filterRules: {
            includeStatus: CATALOG_FILTER.includeStatus,
            includeMinScore: CATALOG_FILTER.includeMinScore,
            excludeStatus: CATALOG_FILTER.excludeStatus
        },
        shards: shardInfos
    };

    writeJsonFile(paths.catalogFile, catalogIndex);
    console.log(`[assemble] Written catalog.json with ${catalogApps.length} apps in ${totalShards} shards`);

    // 7. 清理多余的分片文件（如果分片数减少了）
    cleanupOldShards(paths.catalogsDir, totalShards);

    console.log('[assemble] Done.');

    return { totalApps: catalogApps.length, totalShards };
}

/**
 * 清理不再需要的分片文件
 * @param {string} catalogsDir
 * @param {number} currentShardCount - 当前分片数
 */
function cleanupOldShards(catalogsDir, currentShardCount) {
    if (!fs.existsSync(catalogsDir)) return;

    const files = fs.readdirSync(catalogsDir);
    for (const file of files) {
        const match = file.match(/^shard-(\d+)\.json$/);
        if (match) {
            const shardNum = parseInt(match[1], 10);
            if (shardNum > currentShardCount) {
                const filepath = path.join(catalogsDir, file);
                fs.unlinkSync(filepath);
                console.log(`[assemble] Removed old shard: ${file}`);
            }
        }
    }
}

module.exports = {
    assembleCatalog,
    cleanupOldShards
};
