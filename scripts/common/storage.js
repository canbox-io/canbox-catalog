/**
 * Catalog 平台无关存储层
 *
 * 负责 JSON 读写、原始数据分片管理、发现游标、触发标记。
 * 所有函数均接收 paths（由 scripts/common/paths.js 生成）作为数据根目录，
 * 本模块不出现任何平台域名 / Token / 平台判断。
 */

const fs = require('fs');
const path = require('path');

const { SHARD_SIZE } = require('./constants');

/**
 * 确保目录存在
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * 读取 JSON 文件
 * @param {string} filepath
 * @param {*} defaultValue - 文件不存在或解析失败时的默认值
 * @returns {*}
 */
function readJsonFile(filepath, defaultValue = null) {
    try {
        if (!fs.existsSync(filepath)) return defaultValue;
        const content = fs.readFileSync(filepath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`[storage] Failed to read ${filepath}: ${err.message}`);
        return defaultValue;
    }
}

/**
 * 写入 JSON 文件
 * @param {string} filepath
 * @param {*} data
 * @param {number} indent - 缩进空格数
 */
function writeJsonFile(filepath, data, indent = 2) {
    ensureDir(path.dirname(filepath));
    fs.writeFileSync(filepath, JSON.stringify(data, null, indent) + '\n', 'utf-8');
}

/**
 * 读取 app_lists.json 索引
 * @param {object} paths
 * @returns {object}
 */
function readAppListsIndex(paths) {
    return readJsonFile(paths.appListsFile, {
        version: 1,
        totalApps: 0,
        totalShards: 0,
        nextShardToVerify: 1,
        lastRefresh: null,
        shards: []
    });
}

/**
 * 写入 app_lists.json 索引
 * @param {object} index
 * @param {object} paths
 */
function writeAppListsIndex(index, paths) {
    writeJsonFile(paths.appListsFile, index);
}

/**
 * 在已有分片中查找 APP（去重主键：仓库 ID / 仓库 URL）
 * 说明：字段名沿用历史命名，两平台实例均写入各自平台的仓库 ID。
 * @param {Array} allApps - 所有分片中的 APP 列表
 * @param {number} repoId - 平台仓库 ID
 * @param {string} repoUrl
 * @returns {object|null} 已存在的 APP 或 null
 */
function findExistingApp(allApps, repoId, repoUrl) {
    // 优先按仓库 ID 匹配
    let found = allApps.find(app => app.githubRepoId === repoId);
    if (found) return found;
    // 再按 repo URL 匹配
    found = allApps.find(app => app.repo === repoUrl);
    return found || null;
}

/**
 * 读取所有分片中的 APP
 * @param {object} paths
 * @returns {Array} 所有 APP 列表
 */
function readAllApps(paths) {
    const index = readAppListsIndex(paths);
    const allApps = [];
    for (const shardInfo of index.shards) {
        const shardPath = path.join(paths.dataDir, shardInfo.file);
        const shard = readJsonFile(shardPath, { apps: [] });
        allApps.push(...shard.apps);
    }
    return allApps;
}

/**
 * 追加 APP 到分片（自动创建新分片）
 * @param {Array} newApps - 新 APP 列表
 * @param {object} paths
 * @returns {number} 实际追加的数量（去重后）
 */
function appendAppsToShards(newApps, paths) {
    ensureDir(paths.shardsDir);

    const index = readAppListsIndex(paths);
    const existingApps = readAllApps(paths);
    const existingIds = new Set(existingApps.map(a => a.githubRepoId));

    const appsToAdd = newApps.filter(app => !existingIds.has(app.githubRepoId));
    if (appsToAdd.length === 0) return 0;

    // 找到最后一个未满的分片
    let currentShardNum = index.totalShards || 0;
    let currentShard = null;
    let currentShardPath = null;

    if (currentShardNum > 0) {
        currentShardPath = path.join(paths.shardsDir, `shard-${String(currentShardNum).padStart(3, '0')}.json`);
        currentShard = readJsonFile(currentShardPath, { version: 1, shardId: currentShardNum, apps: [] });
    }

    for (const app of appsToAdd) {
        // 如果当前分片已满或不存在，创建新分片
        if (!currentShard || currentShard.apps.length >= SHARD_SIZE) {
            // 保存当前分片
            if (currentShard) {
                writeJsonFile(currentShardPath, currentShard);
                // 更新索引中该分片的 appCount
                const shardInfo = index.shards.find(s => s.id === currentShard.shardId);
                if (shardInfo) shardInfo.appCount = currentShard.apps.length;
            }
            currentShardNum++;
            currentShardPath = path.join(paths.shardsDir, `shard-${String(currentShardNum).padStart(3, '0')}.json`);
            currentShard = { version: 1, shardId: currentShardNum, apps: [] };
            index.totalShards = currentShardNum;
            index.shards.push({
                id: currentShardNum,
                file: `app_lists_shards/shard-${String(currentShardNum).padStart(3, '0')}.json`,
                appCount: 0,
                lastChecked: null,
                nextCheck: null
            });
        }
        currentShard.apps.push(app);
    }

    // 保存最后一个分片
    if (currentShard) {
        writeJsonFile(currentShardPath, currentShard);
        const shardInfo = index.shards.find(s => s.id === currentShard.shardId);
        if (shardInfo) shardInfo.appCount = currentShard.apps.length;
    }

    // 更新索引
    index.totalApps = (index.totalApps || 0) + appsToAdd.length;
    index.lastRefresh = new Date().toISOString();
    writeAppListsIndex(index, paths);

    return appsToAdd.length;
}

/**
 * 写入指定分片
 * @param {number} shardId
 * @param {object} shardData
 * @param {object} paths
 */
function writeShard(shardId, shardData, paths) {
    ensureDir(paths.shardsDir);
    const shardPath = path.join(paths.shardsDir, `shard-${String(shardId).padStart(3, '0')}.json`);
    writeJsonFile(shardPath, shardData);
}

/**
 * 读取指定分片
 * @param {number} shardId
 * @param {object} paths
 * @returns {object|null}
 */
function readShard(shardId, paths) {
    const shardPath = path.join(paths.shardsDir, `shard-${String(shardId).padStart(3, '0')}.json`);
    return readJsonFile(shardPath, null);
}

/**
 * 读取 discovery cursor
 * @param {object} paths
 * @returns {object}
 */
function readCursor(paths) {
    return readJsonFile(paths.cursorFile, {
        version: 1,
        lastRun: null,
        firstRun: null,
        totalDiscovered: 0,
        history: []
    });
}

/**
 * 写入 discovery cursor
 * @param {object} cursor
 * @param {object} paths
 */
function writeCursor(cursor, paths) {
    writeJsonFile(paths.cursorFile, cursor);
}

/**
 * 写入触发标记文件，供 CI 判断是否触发 assemble
 * @param {string} triggerFile - 标记文件路径
 * @param {number} newCount - 新发现的 APP 数量
 */
function writeTriggerMarker(triggerFile, newCount) {
    writeJsonFile(triggerFile, {
        newCount,
        timestamp: new Date().toISOString()
    });
}

module.exports = {
    ensureDir,
    readJsonFile,
    writeJsonFile,
    readAppListsIndex,
    writeAppListsIndex,
    findExistingApp,
    readAllApps,
    appendAppsToShards,
    writeShard,
    readShard,
    readCursor,
    writeCursor,
    writeTriggerMarker
};
