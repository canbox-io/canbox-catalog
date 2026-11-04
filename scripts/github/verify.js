/**
 * Action 2：校验与刷新（分片轮询）
 * 检查仓库可访问性、检测 301 重定向、刷新元数据、重新校验、计算评分
 * 每次处理一个分片
 */

const helpers = require('./helpers');
const { checkApp } = require('./app-check');

const PLATFORM = helpers.getPlatformArg();
const dataRepoRoot = helpers.getDataRepoRoot();
const paths = helpers.getPaths(PLATFORM, dataRepoRoot);

/**
 * 解析命令行参数获取分片序号
 */
function getShardIndex() {
    const shardArg = helpers.getArgValue('shard');
    if (shardArg) {
        return parseInt(shardArg, 10);
    }
    // 从 app_lists.json 读取 nextShardToVerify
    const index = helpers.readAppListsIndex(paths);
    return index.nextShardToVerify || 1;
}

async function verify() {
    const shardId = getShardIndex();
    console.log(`[verify] Starting verification for shard ${shardId} (platform: ${PLATFORM})...`);

    const shard = helpers.readShard(shardId, paths);
    if (!shard || !shard.apps || shard.apps.length === 0) {
        console.log(`[verify] Shard ${shardId} not found or empty. Skipping.`);
        return;
    }

    console.log(`[verify] Shard ${shardId} has ${shard.apps.length} apps to verify`);

    let updatedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < shard.apps.length; i++) {
        const app = shard.apps[i];
        console.log(`[verify] [${i + 1}/${shard.apps.length}] Checking ${app.id}...`);

        try {
            const updated = await checkApp(app, PLATFORM);
            shard.apps[i] = updated;
            updatedCount++;
        } catch (err) {
            console.error(`[verify] Error checking ${app.id}: ${err.message}`);
            // 检查失败，更新状态
            const statusUpdate = helpers.updateAppStatus(app, false);
            app.status = statusUpdate.status;
            app.consecutiveFailures = statusUpdate.consecutiveFailures;
            app.lastCheck = new Date().toISOString();
            app.errorHistory = helpers.addErrorRecord(app, 'verify', err.message, err.status || null);
            app.score = helpers.calculateRiskScore(app);
            shard.apps[i] = app;
            errorCount++;
        }

        // 避免 API 限速
        await sleep(3000);
    }

    // 保存分片
    helpers.writeShard(shardId, shard, paths);

    // 更新索引
    const index = helpers.readAppListsIndex(paths);
    const shardInfo = index.shards.find(s => s.id === shardId);
    if (shardInfo) {
        shardInfo.lastChecked = new Date().toISOString();
        shardInfo.appCount = shard.apps.length;
    }
    // 更新 nextShardToVerify：递增并回绕
    index.nextShardToVerify = (shardId % index.totalShards) + 1;
    index.lastRefresh = new Date().toISOString();
    helpers.writeAppListsIndex(index, paths);

    console.log(`[verify] Done. Updated: ${updatedCount}, Errors: ${errorCount}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 主入口
verify().catch(err => {
    console.error('[verify] Fatal error:', err);
    process.exit(1);
});