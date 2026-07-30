/**
 * 重新发现：扫描 firstRun 之前创建的仓库
 * 用于补全首次全量扫描可能遗漏的仓库（如 API 限速导致未扫完）
 * 仅通过 workflow_dispatch 手动触发
 */

const helpers = require('./helpers');

async function rediscover() {
    console.log('[rediscover] Starting rediscovery...');

    const cursor = helpers.readCursor();
    const firstRun = cursor.firstRun;

    if (!firstRun) {
        console.log('[rediscover] No firstRun found in cursor. Nothing to do.');
        return 0;
    }

    console.log(`[rediscover] Scanning repos created before ${firstRun}...`);

    // 扫描 firstRun 之前创建的仓库
    const createdRange = `<=${new Date(firstRun).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;

    const allApps = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;
    let totalFetched = 0;

    while (hasMore) {
        console.log(`[rediscover] Page ${page}...`);
        const result = await helpers.searchCanboxApps({ createdRange, page, perPage });

        for (const repo of result.items) {
            const app = await parseRepoToApp(repo, 'rediscover');
            if (app) allApps.push(app);
        }

        totalFetched += result.items.length;
        console.log(`[rediscover] Page ${page}: got ${result.items.length} repos (total fetched: ${totalFetched})`);

        if (result.items.length < perPage || totalFetched >= 1000) {
            hasMore = false;
            if (totalFetched >= 1000) {
                console.warn('[rediscover] WARNING: Reached GitHub Search API 1000 result limit. Some repos may be missed.');
            }
        } else {
            page++;
        }

        await sleep(2000);
    }

    console.log(`[rediscover] Found ${allApps.length} repos before firstRun`);

    // 追加到分片（自动去重）
    const addedCount = helpers.appendAppsToShards(allApps);
    console.log(`[rediscover] Added ${addedCount} new apps (duplicates skipped)`);

    // 更新 cursor 历史
    cursor.history.push({
        timestamp: new Date().toISOString(),
        newCount: addedCount,
        action: 'rediscover'
    });
    if (cursor.history.length > 100) {
        cursor.history = cursor.history.slice(-100);
    }
    helpers.writeCursor(cursor);

    // 写入触发标记
    const TRIGGER_FILE = helpers.DATA_DIR + '/.rediscover-result.json';
    helpers.writeTriggerMarker(TRIGGER_FILE, addedCount);

    console.log(`[rediscover] Done. Added ${addedCount} new apps.`);
    return addedCount;
}

/**
 * 将 GitHub 仓库数据解析为 APP 数据
 */
async function parseRepoToApp(repo, action) {
    const owner = repo.owner?.login;
    const repoName = repo.name;
    const repoUrl = repo.html_url;

    if (!owner || !repoName) {
        console.warn(`[rediscover] Skipping repo with missing owner/name: ${repo.full_name}`);
        return null;
    }

    let appId;
    try {
        appId = helpers.generateAppId(repoUrl);
    } catch (err) {
        console.warn(`[rediscover] Skipping repo with invalid URL: ${repoUrl}`);
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
        console.warn(`[rediscover] ${repo.full_name}: Failed to fetch .canbox-app: ${err.message}`);
    }

    try {
        pkg = await helpers.fetchRepoFile(owner, repoName, 'package.json');
        const pkgValidation = helpers.validatePackageJson(pkg);
        hasValidPackageJson = pkgValidation.valid;
    } catch (err) {
        console.warn(`[rediscover] ${repo.full_name}: Failed to fetch package.json: ${err.message}`);
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
rediscover().catch(err => {
    console.error('[rediscover] Fatal error:', err);
    process.exit(1);
});
