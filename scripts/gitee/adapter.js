/**
 * Gitee 平台适配器
 *
 * 平台专属常量（ID 前缀、仓库域名、raw 资源 URL 构造）集中在本目录，
 * 通过 registerPlatformAdapter 注册到 scripts/common 的适配层注册表。
 */

const { registerPlatformAdapter } = require('../common/platform-adapter');

const ADAPTER = {
    platform: 'gitee',
    idPrefix: 'com.gitee',
    hostPattern: /gitee\.com\/([^/]+)\/([^/]+)/,
    siteBase: 'https://gitee.com',
    rawBase: (owner, repo, branch) => `https://gitee.com/${owner}/${repo}/raw/${branch}`
};

registerPlatformAdapter(ADAPTER.platform, ADAPTER);

module.exports = ADAPTER;
