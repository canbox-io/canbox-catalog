/**
 * 单个 APP 的检查逻辑（Verify 与 Register 共用）
 *
 * 保证「登记」写入的记录与「分片轮询」产出的记录形状、校验规则完全一致。
 */

const helpers = require('./helpers');

/**
 * 校验并刷新单个 APP
 * @param {object} app - 待检查的 APP 记录（需含 repo）
 * @param {string} platform - 平台标识
 * @returns {Promise<object>} 更新后的 APP 数据
 */
async function checkApp(app, platform = helpers.PLATFORM) {
    const ADAPTER = helpers.getPlatformAdapter(platform);

    const repoMatch = app.repo.match(ADAPTER.hostPattern);
    if (!repoMatch) {
        console.warn(`[check] Invalid repo URL: ${app.repo}`);
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
            console.log(`[check] Redirect detected: ${owner}/${repoName} → ${actualOwner}/${actualRepo}`);
            app.id = `${ADAPTER.idPrefix}.${actualOwner}.${actualRepo}`;
            app.repo = `${ADAPTER.siteBase}/${actualOwner}/${actualRepo}`;
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

    const actualRepoMatch = app.repo.match(ADAPTER.hostPattern);
    const currentOwner = actualRepoMatch ? actualRepoMatch[1] : owner;
    const currentRepoName = actualRepoMatch ? actualRepoMatch[2] : repoName;

    try {
        canboxApp = await helpers.fetchRepoFile(currentOwner, currentRepoName, helpers.CANBOX_APP_FILENAME);
        const canboxValidation = helpers.validateCanboxApp(canboxApp);
        app.hasValidCanboxApp = canboxValidation.valid;
        app.canboxWarnings = canboxValidation.warnings || [];
    } catch (err) {
        app.hasValidCanboxApp = false;
        app.canboxWarnings = [];
        console.warn(`[check] ${app.id}: Failed to fetch .canbox-app: ${err.message}`);
    }

    try {
        pkg = await helpers.fetchRepoFile(currentOwner, currentRepoName, 'package.json');
        const pkgValidation = helpers.validatePackageJson(pkg);
        app.hasValidPackageJson = pkgValidation.valid;
    } catch (err) {
        app.hasValidPackageJson = false;
        console.warn(`[check] ${app.id}: Failed to fetch package.json: ${err.message}`);
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

module.exports = {
    checkApp
};
