/**
 * GitHub 平台适配器
 *
 * 平台专属常量（ID 前缀、仓库域名、raw 资源 URL 构造）集中在平台目录内，
 * 通过 registerPlatformAdapter 注册到 scripts/common 的适配层注册表；
 * scripts/common 本身不含任何平台域名常量。
 */

const { registerPlatformAdapter } = require('../common/platform-adapter');

const ADAPTER = {
    platform: 'github',
    idPrefix: 'com.github',
    hostPattern: /github\.com\/([^/]+)\/([^/]+)/,
    siteBase: 'https://github.com',
    rawBase: (owner, repo, branch) => `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`
};

registerPlatformAdapter(ADAPTER.platform, ADAPTER);

module.exports = ADAPTER;
