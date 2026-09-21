/**
 * Action 3：组装 Catalog（Gitee 实例）
 * 读取 data/gitee 下的原始数据分片，过滤后生成 catalog.json（source: 'gitee'）和 catalogs/*.json
 */

const helpers = require('./helpers');

const PLATFORM = helpers.PLATFORM;
const argPlatform = helpers.getPlatformArg(process.argv.slice(2), PLATFORM);
if (argPlatform !== PLATFORM) {
    console.error(`[assemble] This entry only supports platform "${PLATFORM}", got "${argPlatform}"`);
    process.exit(1);
}

const paths = helpers.getPaths(PLATFORM, helpers.getDataRepoRoot());

async function assemble() {
    helpers.assembleCatalog(paths);
}

// 主入口
assemble().catch(err => {
    console.error('[assemble] Fatal error:', err);
    process.exit(1);
});