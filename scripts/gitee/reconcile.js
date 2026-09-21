/**
 * Action 1.5：标签对账（Gitee 实例）
 *
 * 目的（与 GitHub 侧一致）：捕获"已有仓库之后才打上 canbox-app 标签"的情况。
 *
 * 平台差异：GitHub 侧 reconcile 依赖 Search API 的 topic 查询，而 Gitee 无该能力，
 * discover 本身已是"组织全量扫描 + 本地去重"，因此 reconcile 与 discover 的扫描过程相同，
 * 差别只在语义与触发标记（reconcile-result）：先比对已有集合、算出差集，再补齐。
 * 保留该入口是为了与 GitHub 实例保持一致的操作面（workflow / 运维习惯）。
 */

const helpers = require('./helpers');

const PLATFORM = helpers.PLATFORM;
const argPlatform = helpers.getPlatformArg(process.argv.slice(2), PLATFORM);
if (argPlatform !== PLATFORM) {
    console.error(`[reconcile] This entry only supports platform "${PLATFORM}", got "${argPlatform}"`);
    process.exit(1);
}

const paths = helpers.getPaths(PLATFORM, helpers.getDataRepoRoot());
const TRIGGER_FILE = paths.triggerFile('reconcile-result');

async function reconcile() {
    console.log(`[reconcile] Starting label reconciliation for platform: ${PLATFORM} (org: ${helpers.ORG})...`);

    // 1. 组织全量扫描 + 标签过滤
    const { items, totalScanned } = await helpers.listLabeledRepos();
    console.log(`[reconcile] Fetched ${items.length} labeled repos out of ${totalScanned} scanned`);

    // 2. 提取已有仓库标识集合
    const existingApps = helpers.readAllApps(paths);
    const existingRepoIds = new Set(existingApps.map(app => app.githubRepoId));
    const existingRepoUrls = new Set(existingApps.map(app => app.repo));

    // 3. 计算差集
    const newRepos = items.filter(repo => {
        const url = helpers.getRepoUrl(repo);
        return !existingRepoIds.has(repo.id) && !existingRepoUrls.has(url);
    });

    console.log(`[reconcile] Found ${newRepos.length} labeled repos not in catalog`);

    if (newRepos.length === 0) {
        helpers.writeTriggerMarker(TRIGGER_FILE, 0);
        console.log('[reconcile] No new apps found. Done.');
        return 0;
    }

    // 4. 解析新仓库并追加到分片
    const newApps = [];
    for (const repo of newRepos) {
        try {
            const app = await helpers.repoToApp(repo, 'reconcile');
            if (app) newApps.push(app);
        } catch (err) {
            console.error(`[reconcile] Failed to parse ${helpers.getRepoFullName(repo)}: ${err.message}`);
        }
        await helpers.sleep(200);
    }

    const addedCount = helpers.appendAppsToShards(newApps, paths);
    console.log(`[reconcile] Added ${addedCount} new apps`);

    // 5. 写入触发标记
    helpers.writeTriggerMarker(TRIGGER_FILE, addedCount);

    console.log(`[reconcile] Done. Added ${addedCount} new apps.`);
    return addedCount;
}

// 主入口
reconcile().catch(err => {
    console.error('[reconcile] Fatal error:', err);
    process.exit(1);
});