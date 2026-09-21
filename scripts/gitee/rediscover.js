/**
 * 重新发现（Gitee 实例，手动触发）
 *
 * 用途（与 GitHub 侧一致）：补全首次扫描可能遗漏的仓库。
 *
 * 平台差异：GitHub 侧用 created 时间范围限定"firstRun 之前"的仓库，
 * 而 Gitee 组织列表不支持时间范围过滤，故这里直接做一次组织全量扫描 + 本地去重补齐，
 * 语义上等价（且比时间范围更彻底）。
 */

const helpers = require('./helpers');

const PLATFORM = helpers.PLATFORM;
const argPlatform = helpers.getPlatformArg(process.argv.slice(2), PLATFORM);
if (argPlatform !== PLATFORM) {
    console.error(`[rediscover] This entry only supports platform "${PLATFORM}", got "${argPlatform}"`);
    process.exit(1);
}

const paths = helpers.getPaths(PLATFORM, helpers.getDataRepoRoot());
const TRIGGER_FILE = paths.triggerFile('rediscover-result');

async function rediscover() {
    console.log(`[rediscover] Starting rediscovery for platform: ${PLATFORM} (org: ${helpers.ORG})...`);

    const cursor = helpers.readCursor(paths);

    // 组织全量扫描 + 标签过滤
    const { items, totalScanned } = await helpers.listLabeledRepos();
    console.log(`[rediscover] Scanned ${totalScanned} repos, ${items.length} carry label "${helpers.TOPIC_IDENT}"`);

    const allApps = [];
    for (const repo of items) {
        const app = await helpers.repoToApp(repo, 'rediscover');
        if (app) allApps.push(app);
        await helpers.sleep(200);
    }

    // 追加到分片（自动去重）
    const addedCount = helpers.appendAppsToShards(allApps, paths);
    console.log(`[rediscover] Added ${addedCount} new apps (duplicates skipped)`);

    // 更新 cursor 历史
    cursor.history.push({
        timestamp: new Date().toISOString(),
        newCount: addedCount,
        action: 'rediscover',
        scanned: totalScanned,
        labeled: items.length
    });
    if (cursor.history.length > 100) {
        cursor.history = cursor.history.slice(-100);
    }
    helpers.writeCursor(cursor, paths);

    // 写入触发标记
    helpers.writeTriggerMarker(TRIGGER_FILE, addedCount);

    console.log(`[rediscover] Done. Added ${addedCount} new apps.`);
    return addedCount;
}

// 主入口
rediscover().catch(err => {
    console.error('[rediscover] Fatal error:', err);
    process.exit(1);
});