/**
 * Catalog 平台路径与运行参数解析
 *
 * 产物按平台分子目录存放（data/{platform}/），本模块是唯一决定数据根目录的地方：
 * 所有读写函数统一接收本模块返回的 paths 对象，禁止在业务代码里拼接数据路径。
 *
 * 目录结构：
 *   data/{platform}/
 *     catalog.json               展示数据索引
 *     catalogs/shard-XXX.json    展示数据分片
 *     app_lists.json             原始数据索引
 *     app_lists_shards/shard-XXX.json  原始数据分片
 *     discovery_cursor.json      发现游标
 *     .{action}-result.json      触发标记（临时产物）
 */

const path = require('path');

// scripts/common/ → 仓库根目录
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SUPPORTED_PLATFORMS = ['github', 'gitee'];
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
function getPaths(platform = DEFAULT_PLATFORM) {
    assertPlatform(platform);
    const dataDir = path.join(REPO_ROOT, 'data', platform);
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
    assertPlatform,
    getPaths
};
