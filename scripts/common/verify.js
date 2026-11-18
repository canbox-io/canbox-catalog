/**
 * 分片校验与刷新（平台无关）
 *
 * 平台脚本只需注入 helpers 并调用 runVerify：
 *   scripts/github/verify.js
 *   scripts/gitee/verify.js
 */

const { createCheckApp } = require('./app-check');

/**
 * 执行一次分片校验
 * @param {object} helpers - 平台 helpers
 * @returns {Promise<void>}
 */
async function runVerify(helpers) {
    const checkApp = createCheckApp(helpers);
    const PLATFORM = helpers.getPlatformArg();
    const dataRepoRoot = helpers.getDataRepoRoot();
    const paths = helpers.getPaths(PLATFORM, dataRepoRoot);

    const shardArg = helpers.getArgValue('shard');
    const shardId = shardArg
        ? parseInt(shardArg, 10)
        : (helpers.readAppListsIndex(paths).nextShardToVerify || 1);

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

    helpers.writeShard(shardId, shard, paths);

    const index = helpers.readAppListsIndex(paths);
    const shardInfo = index.shards.find(s => s.id === shardId);
    if (shardInfo) {
        shardInfo.lastChecked = new Date().toISOString();
        shardInfo.appCount = shard.apps.length;
    }
    index.nextShardToVerify = index.totalShards > 0 ? (shardId % index.totalShards) + 1 : 1;
    index.lastRefresh = new Date().toISOString();
    helpers.writeAppListsIndex(index, paths);

    console.log(`[verify] Done. Updated: ${updatedCount}, Errors: ${errorCount}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    runVerify
};
