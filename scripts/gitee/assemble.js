/**
 * Action 3：组装 Catalog（Gitee 实例）
 */

const helpers = require('./helpers');

const PLATFORM = helpers.getPlatformArg();
const dataRepoRoot = helpers.getDataRepoRoot();
const paths = helpers.getPaths(PLATFORM, dataRepoRoot);

async function assemble() {
    helpers.assembleCatalog(paths, { sourceName: 'Gitee 社区 APP 目录' });
}

assemble().catch(err => {
    console.error('[assemble] Fatal error:', err);
    process.exit(1);
});
