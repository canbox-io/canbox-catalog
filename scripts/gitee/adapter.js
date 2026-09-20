/**
 * Gitee 平台适配器
 *
 * 平台专属常量（ID 前缀、仓库域名、raw 资源 URL 构造）集中在平台目录内，
 * 通过 registerPlatformAdapter 注册到 scripts/common 的适配层注册表；
 * scripts/common 本身不含任何平台域名常量。
 *
 * 说明：Gitee raw 资源实际会 302 到 raw.giteeusercontent.com（带签名），
 * 因此访问侧需允许跟随重定向（axios 默认跟随）。
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
