/**
 * Action 3：组装 Catalog
 * 读取所有分片原始数据，过滤后生成 catalog.json 和 catalogs/*.json
 */

const helpers = require('./helpers');

async function assemble() {
    console.log('[assemble] Starting catalog assembly...');

    helpers.ensureDir(helpers.CATALOGS_DIR);

    // 1. 读取所有分片原始数据
    const allApps = helpers.readAllApps();
    console.log(`[assemble] Total apps in raw data: ${allApps.length}`);

    // 2. 过滤
    const filteredApps = helpers.filterAppsForCatalog(allApps);
    console.log(`[assemble] Apps after filtering: ${filteredApps.length}`);

    // 3. 转换为展示格式
    const catalogApps = filteredApps.map(app => {
        return helpers.toCatalogApp(app, app._canboxApp || null, app._pkg || null, {
            stars: app.stars || 0,
            forks: app.forks || 0,
            lastCommitAt: app.lastCommitAt || null,
            createdAt: app.createdAt || null,
            license: app._pkg ? (app._pkg.license || null) : null,
            homepage: app._pkg ? (app._pkg.homepage || app.repo) : app.repo
        });
    });

    // 4. 按 stars 降序排序
    catalogApps.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    // 5. 分片写入 catalogs/
    const totalShards = catalogApps.length > 0 ? Math.ceil(catalogApps.length / helpers.CATALOG_SHARD_SIZE) : 0;
    const shardInfos = [];

    for (let i = 0; i < totalShards; i++) {
        const start = i * helpers.CATALOG_SHARD_SIZE;
        const end = Math.min(start + helpers.CATALOG_SHARD_SIZE, catalogApps.length);
        const shardApps = catalogApps.slice(start, end);

        const shardId = i + 1;
        const shardData = {
            schemaVersion: 2,
            shardId,
            generatedAt: new Date().toISOString(),
            apps: shardApps
        };

        const shardFilename = `catalogs/shard-${String(shardId).padStart(3, '0')}.json`;
        helpers.writeJsonFile(helpers.DATA_DIR + '/' + shardFilename, shardData);

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
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        source: 'github',
        sourceName: 'Canbox 官方 APP 目录',
        totalApps: catalogApps.length,
        totalShards,
        filterRules: {
            includeStatus: helpers.CATALOG_FILTER.includeStatus,
            includeMinScore: helpers.CATALOG_FILTER.includeMinScore,
            excludeStatus: helpers.CATALOG_FILTER.excludeStatus
        },
        shards: shardInfos
    };

    helpers.writeJsonFile(helpers.CATALOG_FILE, catalogIndex);
    console.log(`[assemble] Written catalog.json with ${catalogApps.length} apps in ${totalShards} shards`);

    // 7. 清理多余的分片文件（如果分片数减少了）
    cleanupOldShards(totalShards);

    console.log('[assemble] Done.');
}

/**
 * 清理不再需要的分片文件
 * @param {number} currentShardCount - 当前分片数
 */
function cleanupOldShards(currentShardCount) {
    const fs = require('fs');
    const dir = helpers.CATALOGS_DIR;

    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    for (const file of files) {
        const match = file.match(/^shard-(\d+)\.json$/);
        if (match) {
            const shardNum = parseInt(match[1], 10);
            if (shardNum > currentShardCount) {
                const filepath = dir + '/' + file;
                fs.unlinkSync(filepath);
                console.log(`[assemble] Removed old shard: ${file}`);
            }
        }
    }
}

// 主入口
assemble().catch(err => {
    console.error('[assemble] Fatal error:', err);
    process.exit(1);
});
