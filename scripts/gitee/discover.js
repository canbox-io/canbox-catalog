/**
 * Action 1：增量发现新 APP（Gitee 实例）
 *
 * 平台差异：Gitee 无 GitHub Search API 等价的 topic 检索接口，因此"发现"实现为
 *   组织全量列表（/v5/orgs/{org}/repos，匿名可读、支持分页，列表项自带 project_labels）
 *   → 本地按标签 ident 过滤 → 与已有分片去重后追加。
 *
 * 两个必须知道的行为差异（Gitee 平台限制，非实现选择）：
 *   1. 发现范围限于组织内的仓库，组织外的第三方 APP 无法被发现；
 *   2. 组织列表不支持 created 时间范围过滤，故每次均为组织全量扫描 + 本地去重
 *      （组织规模小，成本可接受；不再区分"首次全量 / 后续增量"）。
 */

const helpers = require('./helpers');

const PLATFORM = helpers.PLATFORM;
// 防止误用平台参数把数据写到另一个实例的目录
const argPlatform = helpers.getPlatformArg(process.argv.slice(2), PLATFORM);
if (argPlatform !== PLATFORM) {
    console.error(`[discover] This entry only supports platform "${PLATFORM}", got "${argPlatform}"`);
    process.exit(1);
}

const paths = helpers.getPaths(PLATFORM, helpers.getDataRepoRoot());
const TRIGGER_FILE = paths.triggerFile('discover-result');

async function discover() {
    console.log(`[discover] Starting discovery for platform: ${PLATFORM} (org: ${helpers.ORG}, label: ${helpers.TOPIC_IDENT})...`);

    const cursor = helpers.readCursor(paths);

    // 组织全量扫描 + 标签过滤（Gitee 的等价"检索"）
    const { items, totalScanned } = await helpers.listLabeledRepos();

    const apps = [];
    for (const repo of items) {
        const app = await helpers.repoToApp(repo, 'discover');
        if (app) apps.push(app);
        await helpers.sleep(200);
    }

    // 追加到分片（按 githubRepoId / repo URL 自动去重）
    const addedCount = helpers.appendAppsToShards(apps, paths);
    console.log(`[discover] Scanned ${totalScanned} repos, ${items.length} labeled, added ${addedCount} new apps`);

    // 更新 cursor
    const now = new Date().toISOString();
    cursor.lastRun = now;
    if (!cursor.firstRun) {
        cursor.firstRun = now;
    }
    cursor.totalDiscovered = (cursor.totalDiscovered || 0) + addedCount;
    cursor.history.push({
        timestamp: now,
        newCount: addedCount,
        scanned: totalScanned,
        labeled: items.length
    });
    // 只保留最近 100 条历史
    if (cursor.history.length > 100) {
        cursor.history = cursor.history.slice(-100);
    }
    helpers.writeCursor(cursor, paths);

    // 写入触发标记
    helpers.writeTriggerMarker(TRIGGER_FILE, addedCount);

    console.log(`[discover] Done. Added ${addedCount} new apps.`);
    return addedCount;
}

// 主入口
discover().catch(err => {
    console.error('[discover] Fatal error:', err);
    process.exit(1);
});