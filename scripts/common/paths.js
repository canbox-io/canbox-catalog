/**
 * Catalog 平台路径与运行参数解析
 *
 * 产物存储在各 git 平台独立的 canbox-catalog-data 仓库根目录（不再有 data/{platform}/ 嵌套）。
 * 数据根目录由调用方通过 --data-repo-root 参数传入（指向 clone 到的 canbox-catalog-data 目录）。
 * 若未传入，默认使用 {REPO_ROOT}/data/{platform}（仅用于本地开发/测试）。
 *
 * 目录结构（canbox-catalog-data 根目录）：
 *   catalog.json               展示数据索引
 *   catalogs/shard-XXX.json    展示数据分片
 *   app_lists.json             原始数据索引
 *   app_lists_shards/shard-XXX.json  原始数据分片
 *   discovery_cursor.json      发现游标
 *   .{action}-result.json      触发标记（临时产物）
 */

const path = require('path');

// scripts/common/ → 仓库根目录
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SUPPORTED_PLATFORMS = ['github'];
const DEFAULT_PLATFORM = 'github';

/**
 * 从命令行参数中读取指定参数值，支持 --name=value 与 --name value
 * @param {string} name 参数名（不含 --）
 * @param {string[]} [argv] 参数数组，默认 process.argv.slice(2)
 * @param {string|null} [defaultValue=null]
 * @returns {string|null}
 */
function getArgValue(name, argv = process.argv.slice(2), defaultValue = null) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === `--${name}` && argv[i + 1] !== undefined) {
            return argv[i + 1];
        }
        if (arg.startsWith(`--${name}=`)) {
            return arg.slice(name.length + 3);
        }
    }
    return defaultValue;
}

/**
 * 读取 --platform 参数
 * @param {string[]} [argv]
 * @param {string} [fallback]
 * @returns {string}
 */
function getPlatformArg(argv = process.argv.slice(2), fallback = DEFAULT_PLATFORM) {
    return getArgValue('platform', argv, fallback);
}

/**
 * 读取 --data-repo-root 参数（指向 canbox-catalog-data 仓库的 checkout 路径）
 * @param {string[]} [argv]
 * @returns {string|null}
 */
function getDataRepoRoot(argv = process.argv.slice(2)) {
    return getArgValue('data-repo-root', argv, null);
}

/**
 * 校验平台名合法性
 * @param {string} platform
 */
function assertPlatform(platform) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
        throw new Error(`Unsupported platform: ${platform} (supported: ${SUPPORTED_PLATFORMS.join(', ')})`);
    }
}

/**
 * 解析某平台的数据目录结构
 * @param {string} platform 'github' | 'gitee'
 * @returns {{
 *   platform: string,
 *   dataDir: string,
 *   appListsFile: string,
 *   catalogFile: string,
 *   cursorFile: string,
 *   shardsDir: string,
 *   catalogsDir: string,
 *   triggerFile: (name: string) => string
 * }}
 */
function getPaths(platform = DEFAULT_PLATFORM, dataRepoRoot) {
    assertPlatform(platform);
    const dataDir = dataRepoRoot || path.join(REPO_ROOT, 'data', platform);
    return {
        platform,
        dataDir,
        appListsFile: path.join(dataDir, 'app_lists.json'),
        catalogFile: path.join(dataDir, 'catalog.json'),
        cursorFile: path.join(dataDir, 'discovery_cursor.json'),
        shardsDir: path.join(dataDir, 'app_lists_shards'),
        catalogsDir: path.join(dataDir, 'catalogs'),
        triggerFile: (name) => path.join(dataDir, `.${name}.json`)
    };
}

module.exports = {
    REPO_ROOT,
    SUPPORTED_PLATFORMS,
    DEFAULT_PLATFORM,
    getArgValue,
    getPlatformArg,
    getDataRepoRoot,
    assertPlatform,
    getPaths
};