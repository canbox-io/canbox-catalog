/**
 * Action 2：校验与刷新（分片轮询）
 * 检查仓库可访问性、检测 301 重定向、刷新元数据、重新校验、计算评分
 * 每次处理一个分片
 */

const helpers = require('./helpers');

/**
 * 解析命令行参数获取分片序号
 */
function getShardIndex() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--shard' && args[i + 1]) {
            return parseInt(args[i + 1], 10);
        }
    }
    // 从 app_lists.json 读取 nextShardToVerify
    const index = helpers.readAppListsIndex();
    return index.nextShardToVerify || 1;
}

async function verify() {
    const shardId = getShardIndex();
    console.log(`[verify] Starting verification for shard ${shardId}...`);

    const shard = helpers.readShard(shardId);
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
            const updated = await verifyApp(app);
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
    helpers.writeShard(shardId, shard);

    // 更新索引
    const index = helpers.readAppListsIndex();
    const shardInfo = index.shards.find(s => s.id === shardId);
    if (shardInfo) {
        shardInfo.lastChecked = new Date().toISOString();
        shardInfo.appCount = shard.apps.length;
    }
    // 更新 nextShardToVerify：递增并回绕
    index.nextShardToVerify = (shardId % index.totalShards) + 1;
    index.lastRefresh = new Date().toISOString();
    helpers.writeAppListsIndex(index);

    console.log(`[verify] Done. Updated: ${updatedCount}, Errors: ${errorCount}`);
}

/**
 * 校验单个 APP
 * @param {object} app
 * @returns {object} 更新后的 APP 数据
 */
async function verifyApp(app) {
    const repoMatch = app.repo.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!repoMatch) {
        console.warn(`[verify] Invalid repo URL: ${app.repo}`);
        app.repoStatus = 'gone';
        app.repoStatusDetail = 'Invalid repo URL';
        app.hasValidCanboxApp = false;
        app.hasValidPackageJson = false;
        const statusUpdate = helpers.updateAppStatus(app, false);
        app.status = statusUpdate.status;
        app.consecutiveFailures = statusUpdate.consecutiveFailures;
        app.lastCheck = new Date().toISOString();
        app.errorHistory = helpers.addErrorRecord(app, 'verify', 'Invalid repo URL', null);
        app.score = helpers.calculateRiskScore(app);
        return app;
    }

    const owner = repoMatch[1];
    const repoName = repoMatch[2];

    // 1. 检查仓库可访问性
    const accessResult = await helpers.checkRepoAccess(owner, repoName);

    if (accessResult.status === 'gone') {
        app.repoStatus = 'gone';
        app.repoStatusDetail = 'Repository not found (404)';
        app.hasValidCanboxApp = false;
        app.hasValidPackageJson = false;
        const statusUpdate = helpers.updateAppStatus(app, false);
        app.status = statusUpdate.status;
        app.consecutiveFailures = statusUpdate.consecutiveFailures;
        app.lastCheck = new Date().toISOString();
        app.errorHistory = helpers.addErrorRecord(app, 'verify', 'Repository not found', 404);
        app.score = helpers.calculateRiskScore(app);
        return app;
    }

    if (accessResult.status === 'private') {
        app.repoStatus = 'private';
        app.repoStatusDetail = 'Repository is private (403)';
        const statusUpdate = helpers.updateAppStatus(app, false);
        app.status = statusUpdate.status;
        app.consecutiveFailures = statusUpdate.consecutiveFailures;
        app.lastCheck = new Date().toISOString();
        app.errorHistory = helpers.addErrorRecord(app, 'verify', 'Repository is private', 403);
        app.score = helpers.calculateRiskScore(app);
        return app;
    }

    // 仓库可访问
    const repoData = accessResult.repoData;
    app.repoStatus = 'active';
    app.repoStatusDetail = null;

    // 2. 检测 301 重定向（owner/repo 改名）
    if (repoData) {
        const actualOwner = repoData.owner?.login;
        const actualRepo = repoData.name;
        if (actualOwner && actualRepo && (actualOwner !== owner || actualRepo !== repoName)) {
            console.log(`[verify] Redirect detected: ${owner}/${repoName} → ${actualOwner}/${actualRepo}`);
            app.id = `com.github.${actualOwner}.${actualRepo}`;
            app.repo = `https://github.com/${actualOwner}/${actualRepo}`;
        }

        // 3. 刷新元数据
        const repoMeta = helpers.extractRepoMeta(repoData);
        app.stars = repoMeta.stars;
        app.forks = repoMeta.forks;
        app.lastCommitAt = repoMeta.lastCommitAt;
        app.createdAt = repoMeta.createdAt || app.createdAt;
    }

    // 4. 重新校验 .canbox-app 和 package.json
    let canboxApp = null;
    let pkg = null;

    const actualRepoMatch = app.repo.match(/github\.com\/([^/]+)\/([^/]+)/);
    const currentOwner = actualRepoMatch ? actualRepoMatch[1] : owner;
    const currentRepoName = actualRepoMatch ? actualRepoMatch[2] : repoName;

    try {
        canboxApp = await helpers.fetchRepoFile(currentOwner, currentRepoName, helpers.CANBOX_APP_FILENAME);
        const canboxValidation = helpers.validateCanboxApp(canboxApp);
        app.hasValidCanboxApp = canboxValidation.valid;
    } catch (err) {
        app.hasValidCanboxApp = false;
        console.warn(`[verify] ${app.id}: Failed to fetch .canbox-app: ${err.message}`);
    }

    try {
        pkg = await helpers.fetchRepoFile(currentOwner, currentRepoName, 'package.json');
        const pkgValidation = helpers.validatePackageJson(pkg);
        app.hasValidPackageJson = pkgValidation.valid;
    } catch (err) {
        app.hasValidPackageJson = false;
        console.warn(`[verify] ${app.id}: Failed to fetch package.json: ${err.message}`);
    }

    // 保存最新的 canboxApp 和 pkg 供 assemble 使用
    app._canboxApp = canboxApp;
    app._pkg = pkg;

    // 5. 计算评分和更新状态
    app.score = helpers.calculateRiskScore(app);
    const checkSuccess = app.hasValidCanboxApp && app.hasValidPackageJson;
    const statusUpdate = helpers.updateAppStatus(app, checkSuccess);
    app.status = statusUpdate.status;
    app.consecutiveFailures = statusUpdate.consecutiveFailures;

    // 6. 检查 stale/removed 转换
    app.status = helpers.checkStaleTransition(app);

    app.lastCheck = new Date().toISOString();

    return app;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 主入口
verify().catch(err => {
    console.error('[verify] Fatal error:', err);
    process.exit(1);
});
