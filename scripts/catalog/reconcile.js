/**
 * Action 1.5：Topic 对账
 * 捕获"已有仓库后添加 canbox-app topic"的情况
 * 增量发现只扫描 created 时间，无法发现此类仓库
 */

const helpers = require('./helpers');

const TRIGGER_FILE = helpers.DATA_DIR + '/.reconcile-result.json';

async function reconcile() {
    console.log('[reconcile] Starting topic reconciliation...');

    // 1. 查询所有带 canbox-app topic 的仓库
    const allGithubApps = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;
    let totalFetched = 0;

    while (hasMore) {
        console.log(`[reconcile] Fetching page ${page}...`);
        const result = await helpers.searchCanboxApps({ page, perPage });

        allGithubApps.push(...result.items);
        totalFetched += result.items.length;

        if (result.items.length < perPage || totalFetched >= 1000) {
            hasMore = false;
            if (totalFetched >= 1000) {
                console.warn('[reconcile] WARNING: Reached GitHub Search API 1000 result limit.');
            }
        } else {
            page++;
        }

        // 避免 API 限速
        await sleep(2000);
    }

    console.log(`[reconcile] Fetched ${allGithubApps.length} repos from GitHub`);

    // 2. 提取已有的 githubRepoId 集合
    const existingApps = helpers.readAllApps();
    const existingRepoIds = new Set(existingApps.map(app => app.githubRepoId));
    const existingRepoUrls = new Set(existingApps.map(app => app.repo));

    // 3. 计算差集
    const newRepos = allGithubApps.filter(repo => {
        return !existingRepoIds.has(repo.id) && !existingRepoUrls.has(repo.html_url);
    });

    console.log(`[reconcile] Found ${newRepos.length} new repos not in catalog`);

    if (newRepos.length === 0) {
        helpers.writeTriggerMarker(TRIGGER_FILE, 0);
        console.log('[reconcile] No new apps found. Done.');
        return 0;
    }

    // 4. 解析新仓库并追加到分片
    const newApps = [];
    for (const repo of newRepos) {
        try {
            const app = await parseRepoToApp(repo, 'reconcile');
            if (app) newApps.push(app);
        } catch (err) {
            console.error(`[reconcile] Failed to parse ${repo.full_name}: ${err.message}`);
        }
        await sleep(1000);
    }

    const addedCount = helpers.appendAppsToShards(newApps);
    console.log(`[reconcile] Added ${addedCount} new apps`);

    // 5. 写入触发标记
    helpers.writeTriggerMarker(TRIGGER_FILE, addedCount);

    console.log(`[reconcile] Done. Added ${addedCount} new apps.`);
    return addedCount;
}

/**
 * 将 GitHub 仓库数据解析为 APP 数据（与 discover.js 中的逻辑一致）
 */
async function parseRepoToApp(repo, action) {
    const owner = repo.owner?.login;
    const repoName = repo.name;
    const repoUrl = repo.html_url;

    if (!owner || !repoName) {
        console.warn(`[reconcile] Skipping repo with missing owner/name: ${repo.full_name}`);
        return null;
    }

    let appId;
    try {
        appId = helpers.generateAppId(repoUrl);
    } catch (err) {
        console.warn(`[reconcile] Skipping repo with invalid URL: ${repoUrl}`);
        return null;
    }

    let canboxApp = null;
    let pkg = null;
    let hasValidCanboxApp = false;
    let hasValidPackageJson = false;

    try {
        canboxApp = await helpers.fetchRepoFile(owner, repoName, helpers.CANBOX_APP_FILENAME);
        const canboxValidation = helpers.validateCanboxApp(canboxApp);
        hasValidCanboxApp = canboxValidation.valid;
    } catch (err) {
        console.warn(`[reconcile] ${repo.full_name}: Failed to fetch .canbox-app: ${err.message}`);
    }

    try {
        pkg = await helpers.fetchRepoFile(owner, repoName, 'package.json');
        const pkgValidation = helpers.validatePackageJson(pkg);
        hasValidPackageJson = pkgValidation.valid;
    } catch (err) {
        console.warn(`[reconcile] ${repo.full_name}: Failed to fetch package.json: ${err.message}`);
    }

    const repoMeta = helpers.extractRepoMeta(repo);

    const app = {
        id: appId,
        githubRepoId: repo.id,
        repo: repoUrl,
        createdAt: repoMeta.createdAt,
        discoveredAt: new Date().toISOString(),
        status: helpers.STATUS.UNKNOWN,
        score: 100,
        consecutiveFailures: 0,
        lastCheck: new Date().toISOString(),
        repoStatus: 'active',
        repoStatusDetail: null,
        hasValidCanboxApp,
        hasValidPackageJson,
        errorHistory: [],
        _canboxApp: canboxApp,
        _pkg: pkg,
        _repoMeta: repoMeta,
        stars: repoMeta.stars,
        forks: repoMeta.forks,
        lastCommitAt: repoMeta.lastCommitAt
    };

    app.score = helpers.calculateRiskScore(app);

    if (hasValidCanboxApp && hasValidPackageJson) {
        app.status = helpers.STATUS.ACTIVE;
    }

    return app;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 主入口
reconcile().catch(err => {
    console.error('[reconcile] Fatal error:', err);
    process.exit(1);
});
