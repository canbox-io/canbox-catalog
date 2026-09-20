/**
 * Action 3：组装 Catalog（GitHub 实例）
 * 读取 data/github 下的原始数据分片，过滤后生成 catalog.json 和 catalogs/*.json
 */

const helpers = require('./helpers');

const PLATFORM = helpers.getPlatformArg();
const paths = helpers.getPaths(PLATFORM);

async function assemble() {
    helpers.assembleCatalog(paths);
}

// 主入口
assemble().catch(err => {
    console.error('[assemble] Fatal error:', err);
    process.exit(1);
});
