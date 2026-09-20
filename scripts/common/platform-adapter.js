/**
 * Catalog 平台适配层（注册表 + 平台无关纯函数）
 *
 * 本模块不含任何平台域名/ID 前缀常量，也不做平台分支判断：
 * 平台专属常量由各平台目录（scripts/github/adapter.js、scripts/gitee/adapter.js）
 * 定义后调用 registerPlatformAdapter 注册，公共函数通过 platform 参数取用。
 */

const { calculateRiskScore, calculateRiskLevel, shouldShowDownload } = require('./scoring');

const PLATFORM_ADAPTERS = new Map();

/**
 * 注册平台适配器（由平台目录在 require 时调用）
 * @param {string} platform - 'github' | 'gitee'
 * @param {object} adapter - { platform, idPrefix, hostPattern, siteBase, rawBase }
 */
function registerPlatformAdapter(platform, adapter) {
    if (!platform || !adapter) throw new Error('registerPlatformAdapter requires platform and adapter');
    PLATFORM_ADAPTERS.set(platform, adapter);
}

/**
 * 获取平台适配器（未注册即视为不支持的平台）
 * @param {string} platform
 * @returns {object}
 */
function getPlatformAdapter(platform) {
    const adapter = PLATFORM_ADAPTERS.get(platform);
    if (!adapter) throw new Error(`Unsupported platform: ${platform}`);
    return adapter;
}

/**
 * 从仓库 URL 生成 APP ID
 * @param {string} repoUrl - 仓库地址
 * @param {string} platform - 'github' | 'gitee'
 * @returns {string} - 如 com.github.owner.repo / com.gitee.owner.repo
 */
function generateAppId(repoUrl, platform) {
    const adapter = getPlatformAdapter(platform);
    const match = repoUrl.match(adapter.hostPattern);
    if (!match) throw new Error(`Invalid repo URL: ${repoUrl}`);
    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');
    return `${adapter.idPrefix}.${owner}.${repo}`;
}

/**
 * 将原始 APP 数据转换为展示格式
 * @param {object} app - 原始 APP 数据
 * @param {object} canboxApp - .canbox-app 文件内容
 * @param {object} pkg - package.json 内容
 * @param {object} repoMeta - 仓库元数据
 * @param {string} platform - 'github' | 'gitee'
 * @returns {object} 展示格式 APP 数据
 */
function toCatalogApp(app, canboxApp, pkg, repoMeta, platform) {
    const adapter = getPlatformAdapter(platform);
    const score = calculateRiskScore(app);
    const riskLevel = calculateRiskLevel(app.status, score);
    const showDownload = shouldShowDownload(app.status);

    // 多语言描述来源映射
    let description = '';
    let description_en = '';
    if (canboxApp) {
        description = canboxApp.description || '';
        description_en = canboxApp.description_en || '';
    }
    if (!description && pkg) {
        description = pkg.description || '';
    }
    if (!description_en && pkg) {
        description_en = pkg.description || '';
    }

    // Logo URL（按平台构造 raw 资源地址）
    let logo = null;
    const logoPath = (canboxApp && canboxApp.logo) || (pkg && pkg.logo) || 'logo.png';
    const repoMatch = app.repo.match(adapter.hostPattern);
    if (repoMatch) {
        const branch = 'main'; // 默认 main
        logo = `${adapter.rawBase(repoMatch[1], repoMatch[2], branch)}/${logoPath}`;
    }

    // Issue URL
    let issueUrl = null;
    if (app.repo) {
        issueUrl = `${app.repo.replace(/\/$/, '')}/issues`;
    }

    // 禁用原因
    let disabledReason = null;
    if (!showDownload) {
        if (app.repoStatus === 'gone') {
            disabledReason = '仓库已不可用';
        } else if (app.repoStatus === 'private') {
            disabledReason = '仓库已设为私有';
        } else if (!app.hasValidCanboxApp) {
            disabledReason = '缺少 .canbox-app 配置文件';
        } else if (app.consecutiveFailures >= 5) {
            disabledReason = '连续多次检查失败';
        } else {
            disabledReason = '暂不可用';
        }
    }

    return {
        id: app.id,
        repo: app.repo,
        name: pkg ? pkg.name : app.id.split('.').pop(),
        description,
        description_en,
        author: pkg ? (pkg.author || '') : '',
        category: canboxApp ? (canboxApp.category || '') : '',
        tags: canboxApp ? (canboxApp.tags || []) : [],
        logo,
        homepage: repoMeta ? repoMeta.homepage : (app.repo || null),
        license: repoMeta ? repoMeta.license : null,
        type: canboxApp ? canboxApp.type : null,
        appVersion: pkg ? pkg.version : null,
        electronRange: (canboxApp && canboxApp.electron) ? canboxApp.electron.range : null,
        createdAt: repoMeta ? repoMeta.createdAt : app.createdAt,
        lastCommitAt: repoMeta ? repoMeta.lastCommitAt : app.lastCommitAt,
        stars: repoMeta ? repoMeta.stars : (app.stars || 0),
        forks: repoMeta ? repoMeta.forks : (app.forks || 0),
        status: app.status,
        score,
        riskLevel,
        showDownload,
        issueUrl,
        disabledReason
    };
}

module.exports = {
    registerPlatformAdapter,
    getPlatformAdapter,
    generateAppId,
    toCatalogApp
};
