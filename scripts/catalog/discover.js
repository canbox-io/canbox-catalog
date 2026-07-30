/**
 * Action 1：增量发现新 APP
 * 查询 GitHub Search API，发现带 canbox-app topic 的新仓库
 * 首次运行时执行全量扫描
 */

const helpers = require('./helpers');

const TRIGGER_FILE = helpers.DATA_DIR + '/.discover-result.json';
const LOOKBACK_MINUTES = 30; // 回溯窗口（分钟）

async function discover() {
    console.log('[discover] Starting discovery...');

    const cursor = helpers.readCursor();
    const isFirstRun = !cursor.lastRun;

    let newApps = [];
    let totalCount = 0;

    if (isFirstRun) {
        console.log('[discover] First run, performing full scan...');
        newApps = await fullScan();
    } else {
        console.log(`[discover] Incremental scan since ${cursor.lastRun}...`);
        newApps = await incrementalScan(cursor.lastRun);
    }

    // 追加到分片
    const addedCount = helpers.appendAppsToShards(newApps);
    console.log(`[discover] Discovered ${newApps.length} repos, added ${addedCount} new apps`);

    // 更新 cursor
    const now = new Date().toISOString();
    cursor.lastRun = now;
    if (!cursor.firstRun) {
        cursor.firstRun = now;
    }
    cursor.totalDiscovered = (cursor.totalDiscovered || 0) + addedCount;
    cursor.history.push({
        timestamp: now,
        newCount: addedCount
    });
    // 只保留最近 100 条历史
    if (cursor.history.length > 100) {
        cursor.history = cursor.history.slice(-100);
    }
    helpers.writeCursor(cursor);

    // 写入触发标记
    helpers.writeTriggerMarker(TRIGGER_FILE, addedCount);

    console.log(`[discover] Done. Added ${addedCount} new apps.`);
    return addedCount;
}

/**
 * 全量扫描：首次运行，拉取所有带 canbox-app topic 的仓库
 */
async function fullScan() {
    const allApps = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;
    let totalCount = 0;

    while (hasMore) {
        console.log(`[discover] Full scan page ${page}...`);
        const result = await helpers.searchCanboxApps({ page, perPage });

        for (const repo of result.items) {
            const app = await parseRepoToApp(repo, 'discover');
            if (app) allApps.push(app);
        }

        totalCount += result.items.length;
        console.log(`[discover] Page ${page}: got ${result.items.length} repos (total: ${totalCount})`);

        // GitHub Search API 最多返回 1000 条
        if (result.items.length < perPage || totalCount >= 1000) {
            hasMore = false;
            if (totalCount >= 1000) {
                console.warn('[discover] WARNING: Reached GitHub Search API 1000 result limit. Some repos may be missed.');
            }
        } else {
            page++;
        }

        // 避免 API 限速
        await sleep(2000);
    }

    return allApps;
}

/**
 * 增量扫描：只扫描新创建的仓库
 * @param {string} lastRun - 上次执行时间（ISO 8601）
 */
async function incrementalScan(lastRun) {
    const now = new Date();
    const lookback = new Date(now.getTime() - LOOKBACK_MINUTES * 60 * 1000);
    const since = new Date(Math.max(new Date(lastRun).getTime() - LOOKBACK_MINUTES * 60 * 1000, lookback.getTime()));

    const createdRange = `${since.toISOString().replace(/\.\d{3}Z$/, 'Z')}..${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;

    console.log(`[discover] Incremental scan range: ${createdRange}`);

    const allApps = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
        const result = await helpers.searchCanboxApps({ createdRange, page, perPage });

        for (const repo of result.items) {
            const app = await parseRepoToApp(repo, 'discover');
            if (app) allApps.push(app);
        }

        if (result.items.length < perPage) {
            hasMore = false;
        } else {
            page++;
        }

        await sleep(2000);
    }

    return allApps;
}

/**
 * 将 GitHub 仓库数据解析为 APP 数据
 * @param {object} repo - GitHub API 返回的仓库对象
 * @param {string} action - 触发来源
 * @returns {object|null}
 */
async function parseRepoToApp(repo, action) {
    const owner = repo.owner?.login;
    const repoName = repo.name;
    const repoUrl = repo.html_url;

    if (!owner || !repoName) {
        console.warn(`[discover] Skipping repo with missing owner/name: ${repo.full_name}`);
        return null;
    }

    let appId;
    try {
        appId = helpers.generateAppId(repoUrl);
    } catch (err) {
        console.warn(`[discover] Skipping repo with invalid URL: ${repoUrl}`);
        return null;
    }

    // 获取 .canbox-app 和 package.json
    let canboxApp = null;
    let pkg = null;
    let hasValidCanboxApp = false;
    let hasValidPackageJson = false;

    try {
        canboxApp = await helpers.fetchRepoFile(owner, repoName, helpers.CANBOX_APP_FILENAME);
        const canboxValidation = helpers.validateCanboxApp(canboxApp);
        hasValidCanboxApp = canboxValidation.valid;
        if (!canboxValidation.valid) {
            console.warn(`[discover] ${repo.full_name}: .canbox-app validation failed: ${canboxValidation.errors.join(', ')}`);
        }
    } catch (err) {
        console.warn(`[discover] ${repo.full_name}: Failed to fetch .canbox-app: ${err.message}`);
    }

    try {
        pkg = await helpers.fetchRepoFile(owner, repoName, 'package.json');
        const pkgValidation = helpers.validatePackageJson(pkg);
        hasValidPackageJson = pkgValidation.valid;
        if (!pkgValidation.valid) {
            console.warn(`[discover] ${repo.full_name}: package.json validation failed: ${pkgValidation.errors.join(', ')}`);
        }
    } catch (err) {
        console.warn(`[discover] ${repo.full_name}: Failed to fetch package.json: ${err.message}`);
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
        // 保存元数据供后续使用
        _canboxApp: canboxApp,
        _pkg: pkg,
        _repoMeta: repoMeta,
        stars: repoMeta.stars,
        forks: repoMeta.forks,
        lastCommitAt: repoMeta.lastCommitAt
    };

    // 计算初始评分
    app.score = helpers.calculateRiskScore(app);

    // 如果校验通过，直接标记为 active
    if (hasValidCanboxApp && hasValidPackageJson) {
        app.status = helpers.STATUS.ACTIVE;
    }

    return app;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 主入口
discover().catch(err => {
    console.error('[discover] Fatal error:', err);
    process.exit(1);
});
