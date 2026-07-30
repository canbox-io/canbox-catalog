/**
 * Catalog 共享工具模块
 * 提供 GitHub API 调用、校验、评分、分片管理、去重等功能
 */

const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

// ========== 常量 ==========

const DATA_DIR = path.resolve(__dirname, '../../data');
const SHARDS_DIR = path.join(DATA_DIR, 'app_lists_shards');
const CATALOGS_DIR = path.join(DATA_DIR, 'catalogs');
const CURSOR_FILE = path.join(DATA_DIR, 'discovery_cursor.json');
const APP_LISTS_FILE = path.join(DATA_DIR, 'app_lists.json');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');

const SHARD_SIZE = 200;       // 原始数据分片大小
const CATALOG_SHARD_SIZE = 100; // 展示数据分片大小

const CANBOX_APP_FILENAME = '.canbox-app';

// 状态定义
const STATUS = {
    UNKNOWN: 'unknown',
    ACTIVE: 'active',
    WARNING: 'warning',
    CRITICAL: 'critical',
    STALE: 'stale',
    REMOVED: 'removed'
};

// catalog 过滤规则
const CATALOG_FILTER = {
    includeStatus: ['active', 'warning', 'critical'],
    includeMinScore: 30,
    excludeStatus: ['stale', 'removed']
};

// ========== GitHub API ==========

let octokitInstance = null;

function getOctokit() {
    if (octokitInstance) return octokitInstance;
    const token = process.env.CATALOG_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) {
        console.warn('[helpers] No GitHub token found in CATALOG_GITHUB_TOKEN or GITHUB_TOKEN');
    }
    octokitInstance = new Octokit({ auth: token || undefined });
    return octokitInstance;
}

/**
 * 搜索带 canbox-app topic 的仓库
 * @param {object} options
 * @param {string} options.createdRange - 创建时间范围，如 '2026-01-01T00:00:00Z..2026-07-26T00:00:00Z'
 * @param {number} options.page - 页码（从1开始）
 * @param {number} options.perPage - 每页数量（最大100）
 * @returns {Promise<{items: Array, totalCount: number}>}
 */
async function searchCanboxApps({ createdRange, page = 1, perPage = 100 } = {}) {
    const octokit = getOctokit();
    let q = 'topic:canbox-app';
    if (createdRange) {
        q += ` created:${createdRange}`;
    }
    const response = await octokit.rest.search.repos({
        q,
        sort: 'created',
        order: 'desc',
        per_page: perPage,
        page
    });
    return {
        items: response.data.items || [],
        totalCount: response.data.total_count || 0
    };
}

/**
 * 获取仓库文件内容
 * @param {string} owner
 * @param {string} repo
 * @param {string} filepath
 * @returns {Promise<object|null>} 解析后的 JSON 对象，失败返回 null
 */
async function fetchRepoFile(owner, repo, filepath) {
    const octokit = getOctokit();
    try {
        const response = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: filepath
        });
        if (response.data.content) {
            const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
            return JSON.parse(content);
        }
        return null;
    } catch (err) {
        if (err.status === 404) return null;
        throw err;
    }
}

/**
 * 检查仓库可访问性，检测 301 重定向
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{status: string, redirect: object|null, repoData: object|null}>}
 */
async function checkRepoAccess(owner, repo) {
    const octokit = getOctokit();
    try {
        const response = await octokit.rest.repos.get({ owner, repo });
        return {
            status: 'active',
            redirect: null,
            repoData: response.data
        };
    } catch (err) {
        if (err.status === 404) {
            return { status: 'gone', redirect: null, repoData: null };
        }
        if (err.status === 403) {
            return { status: 'private', redirect: null, repoData: null };
        }
        // 其他错误（如 500、503），可能是临时问题
        throw err;
    }
}

/**
 * 获取仓库元数据（stars、forks、lastCommit 等）
 * @param {object} repoData - GitHub API 返回的仓库数据
 * @returns {object}
 */
function extractRepoMeta(repoData) {
    return {
        stars: repoData.stargazers_count || 0,
        forks: repoData.forks_count || 0,
        lastCommitAt: repoData.pushed_at ? new Date(repoData.pushed_at).toISOString() : null,
        license: repoData.license ? repoData.license.spdx_id : null,
        homepage: repoData.homepage || null,
        createdAt: repoData.created_at ? new Date(repoData.created_at).toISOString() : null
    };
}

// ========== 校验 ==========

/**
 * 校验 .canbox-app 文件内容
 * @param {object|null} canboxApp
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateCanboxApp(canboxApp) {
    const errors = [];
    if (!canboxApp) {
        return { valid: false, errors: ['.canbox-app file not found'] };
    }
    if (!canboxApp.type) {
        errors.push('Missing required field: type');
    } else if (!['native', 'web', 'pwa'].includes(canboxApp.type)) {
        errors.push(`Invalid type: ${canboxApp.type}, must be native/web/pwa`);
    }
    if (canboxApp.type === 'native' && (!canboxApp.electron || !canboxApp.electron.range)) {
        errors.push('Native app requires electron.range field');
    }
    return { valid: errors.length === 0, errors };
}

/**
 * 校验 package.json 内容
 * @param {object|null} pkg
 * @returns {{valid: boolean, errors: string[]}}
 */
function validatePackageJson(pkg) {
    const errors = [];
    if (!pkg) {
        return { valid: false, errors: ['package.json not found'] };
    }
    if (!pkg.name) errors.push('Missing required field: name');
    if (!pkg.version) errors.push('Missing required field: version');
    if (!pkg.main) errors.push('Missing required field: main');
    return { valid: errors.length === 0, errors };
}

// ========== 风险评分 ==========

/**
 * 计算风险评分（0-100，越低风险越高）
 * @param {object} app
 * @returns {number}
 */
function calculateRiskScore(app) {
    let score = 100;

    // 仓库可访问性
    if (app.repoStatus === 'gone') score -= 40;
    if (app.repoStatus === 'private') score -= 30;

    // .canbox-app 校验
    if (!app.hasValidCanboxApp) score -= 20;

    // package.json 校验
    if (!app.hasValidPackageJson) score -= 10;

    // 长期未更新
    if (app.lastCommitAt == null) {
        score -= 10;
    } else {
        const daysSinceUpdate = (Date.now() - new Date(app.lastCommitAt).getTime()) / 86400000;
        if (daysSinceUpdate > 180) score -= 10;
    }

    // 累计失败次数
    score -= Math.min(app.consecutiveFailures * 2, 20);

    return Math.max(0, Math.min(100, score));
}

/**
 * 根据状态和评分计算风险等级
 * @param {string} status
 * @param {number} score
 * @returns {string}
 */
function calculateRiskLevel(status, score) {
    if (status === STATUS.CRITICAL) return 'critical';
    if (status === STATUS.WARNING) return 'medium';
    if (score < 50) return 'high';
    if (score < 80) return 'low';
    return 'none';
}

/**
 * 判断是否显示下载按钮
 * @param {string} status
 * @returns {boolean}
 */
function shouldShowDownload(status) {
    return status === STATUS.ACTIVE || status === STATUS.WARNING;
}

// ========== 状态机 ==========

/**
 * 根据检查结果更新 APP 状态
 * @param {object} app - 当前 APP 数据
 * @param {boolean} checkSuccess - 本次检查是否成功
 * @returns {object} { status, consecutiveFailures }
 */
function updateAppStatus(app, checkSuccess) {
    let { status, consecutiveFailures } = app;

    if (checkSuccess) {
        consecutiveFailures = 0;
        if (status === STATUS.WARNING || status === STATUS.UNKNOWN) {
            status = STATUS.ACTIVE;
        }
        // critical 状态恢复需要连续成功（简化：一次成功即恢复为 active）
        if (status === STATUS.CRITICAL) {
            status = STATUS.ACTIVE;
        }
    } else {
        consecutiveFailures = (consecutiveFailures || 0) + 1;
        if (consecutiveFailures >= 5) {
            status = STATUS.CRITICAL;
        } else if (consecutiveFailures >= 3) {
            status = STATUS.WARNING;
        }
    }

    return { status, consecutiveFailures };
}

/**
 * 检查 stale/removed 状态转换
 * @param {object} app
 * @returns {string} 更新后的状态
 */
function checkStaleTransition(app) {
    if (app.status !== STATUS.CRITICAL) return app.status;

    const lastCheck = app.lastCheck ? new Date(app.lastCheck) : null;
    if (!lastCheck) return app.status;

    const daysSinceCheck = (Date.now() - lastCheck.getTime()) / 86400000;
    // critical 超过 30 天 → stale
    if (daysSinceCheck > 30) {
        // stale 超过 365 天 → removed（从 lastCheck 开始算）
        if (daysSinceCheck > 365) {
            return STATUS.REMOVED;
        }
        return STATUS.STALE;
    }

    return app.status;
}

// ========== APP ID 与去重 ==========

/**
 * 从仓库 URL 生成 APP ID
 * @param {string} repoUrl - 如 https://github.com/owner/repo
 * @returns {string} - 如 com.github.owner.repo
 */
function generateAppId(repoUrl) {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) throw new Error(`Invalid repo URL: ${repoUrl}`);
    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');
    return `com.github.${owner}.${repo}`;
}

/**
 * 在已有分片中查找 APP（按 githubRepoId 或 repo URL 去重）
 * @param {Array} allApps - 所有分片中的 APP 列表
 * @param {number} githubRepoId
 * @param {string} repoUrl
 * @returns {object|null} 已存在的 APP 或 null
 */
function findExistingApp(allApps, githubRepoId, repoUrl) {
    // 优先按 githubRepoId 匹配
    let found = allApps.find(app => app.githubRepoId === githubRepoId);
    if (found) return found;
    // 再按 repo URL 匹配
    found = allApps.find(app => app.repo === repoUrl);
    return found || null;
}

// ========== 分片管理 ==========

/**
 * 确保目录存在
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * 读取 JSON 文件
 * @param {string} filepath
 * @param {*} defaultValue - 文件不存在时的默认值
 * @returns {*}
 */
function readJsonFile(filepath, defaultValue = null) {
    try {
        if (!fs.existsSync(filepath)) return defaultValue;
        const content = fs.readFileSync(filepath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`[helpers] Failed to read ${filepath}: ${err.message}`);
        return defaultValue;
    }
}

/**
 * 写入 JSON 文件
 * @param {string} filepath
 * @param {*} data
 * @param {number} indent - 缩进空格数
 */
function writeJsonFile(filepath, data, indent = 2) {
    ensureDir(path.dirname(filepath));
    fs.writeFileSync(filepath, JSON.stringify(data, null, indent) + '\n', 'utf-8');
}

/**
 * 读取 app_lists.json 索引
 * @returns {object}
 */
function readAppListsIndex() {
    return readJsonFile(APP_LISTS_FILE, {
        version: 1,
        totalApps: 0,
        totalShards: 0,
        nextShardToVerify: 1,
        lastRefresh: null,
        shards: []
    });
}

/**
 * 写入 app_lists.json 索引
 * @param {object} index
 */
function writeAppListsIndex(index) {
    writeJsonFile(APP_LISTS_FILE, index);
}

/**
 * 读取所有分片中的 APP
 * @returns {Array} 所有 APP 列表
 */
function readAllApps() {
    const index = readAppListsIndex();
    const allApps = [];
    for (const shardInfo of index.shards) {
        const shardPath = path.join(DATA_DIR, shardInfo.file);
        const shard = readJsonFile(shardPath, { apps: [] });
        allApps.push(...shard.apps);
    }
    return allApps;
}

/**
 * 追加 APP 到分片（自动创建新分片）
 * @param {Array} newApps - 新 APP 列表
 * @returns {number} 实际追加的数量（去重后）
 */
function appendAppsToShards(newApps) {
    ensureDir(SHARDS_DIR);

    const index = readAppListsIndex();
    const existingApps = readAllApps();
    const existingIds = new Set(existingApps.map(a => a.githubRepoId));

    const appsToAdd = newApps.filter(app => !existingIds.has(app.githubRepoId));
    if (appsToAdd.length === 0) return 0;

    // 找到最后一个未满的分片
    let currentShardNum = index.totalShards || 0;
    let currentShard = null;
    let currentShardPath = null;

    if (currentShardNum > 0) {
        currentShardPath = path.join(SHARDS_DIR, `shard-${String(currentShardNum).padStart(3, '0')}.json`);
        currentShard = readJsonFile(currentShardPath, { version: 1, shardId: currentShardNum, apps: [] });
    }

    for (const app of appsToAdd) {
        // 如果当前分片已满或不存在，创建新分片
        if (!currentShard || currentShard.apps.length >= SHARD_SIZE) {
            // 保存当前分片
            if (currentShard) {
                writeJsonFile(currentShardPath, currentShard);
                // 更新索引中该分片的 appCount
                const shardInfo = index.shards.find(s => s.id === currentShard.shardId);
                if (shardInfo) shardInfo.appCount = currentShard.apps.length;
            }
            currentShardNum++;
            currentShardPath = path.join(SHARDS_DIR, `shard-${String(currentShardNum).padStart(3, '0')}.json`);
            currentShard = { version: 1, shardId: currentShardNum, apps: [] };
            index.totalShards = currentShardNum;
            index.shards.push({
                id: currentShardNum,
                file: `app_lists_shards/shard-${String(currentShardNum).padStart(3, '0')}.json`,
                appCount: 0,
                lastChecked: null,
                nextCheck: null
            });
        }
        currentShard.apps.push(app);
    }

    // 保存最后一个分片
    if (currentShard) {
        writeJsonFile(currentShardPath, currentShard);
        const shardInfo = index.shards.find(s => s.id === currentShard.shardId);
        if (shardInfo) shardInfo.appCount = currentShard.apps.length;
    }

    // 更新索引
    index.totalApps = (index.totalApps || 0) + appsToAdd.length;
    index.lastRefresh = new Date().toISOString();
    writeAppListsIndex(index);

    return appsToAdd.length;
}

/**
 * 写入指定分片
 * @param {number} shardId
 * @param {object} shardData
 */
function writeShard(shardId, shardData) {
    ensureDir(SHARDS_DIR);
    const shardPath = path.join(SHARDS_DIR, `shard-${String(shardId).padStart(3, '0')}.json`);
    writeJsonFile(shardPath, shardData);
}

/**
 * 读取指定分片
 * @param {number} shardId
 * @returns {object|null}
 */
function readShard(shardId) {
    const shardPath = path.join(SHARDS_DIR, `shard-${String(shardId).padStart(3, '0')}.json`);
    return readJsonFile(shardPath, null);
}

// ========== Discovery Cursor ==========

/**
 * 读取 discovery cursor
 * @returns {object}
 */
function readCursor() {
    return readJsonFile(CURSOR_FILE, {
        version: 1,
        lastRun: null,
        firstRun: null,
        totalDiscovered: 0,
        history: []
    });
}

/**
 * 写入 discovery cursor
 * @param {object} cursor
 */
function writeCursor(cursor) {
    writeJsonFile(CURSOR_FILE, cursor);
}

// ========== 错误历史 ==========

/**
 * 添加错误记录
 * @param {object} app
 * @param {string} action - discover / verify / reconcile
 * @param {string} error - 错误描述
 * @param {number|null} statusCode - HTTP 状态码
 * @returns {object} 更新后的 errorHistory
 */
function addErrorRecord(app, action, error, statusCode = null) {
    const history = app.errorHistory || [];
    history.push({
        timestamp: new Date().toISOString(),
        action,
        error,
        statusCode
    });
    // 只保留最近 20 条
    if (history.length > 20) {
        return history.slice(-20);
    }
    return history;
}

// ========== Catalog 组装 ==========

/**
 * 过滤 APP 用于 catalog 展示
 * @param {Array} apps - 所有 APP
 * @returns {Array} 过滤后的 APP
 */
function filterAppsForCatalog(apps) {
    return apps.filter(app => {
        if (CATALOG_FILTER.excludeStatus.includes(app.status)) return false;
        if (!CATALOG_FILTER.includeStatus.includes(app.status)) return false;
        if (app.score < CATALOG_FILTER.includeMinScore) return false;
        return true;
    });
}

/**
 * 将原始 APP 数据转换为展示格式
 * @param {object} app - 原始 APP 数据
 * @param {object} canboxApp - .canbox-app 文件内容
 * @param {object} pkg - package.json 内容
 * @param {object} repoMeta - 仓库元数据
 * @returns {object} 展示格式 APP 数据
 */
function toCatalogApp(app, canboxApp, pkg, repoMeta) {
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

    // Logo URL
    let logo = null;
    const logoPath = (canboxApp && canboxApp.logo) || (pkg && pkg.logo) || 'logo.png';
    const repoMatch = app.repo.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (repoMatch) {
        const branch = 'main'; // 默认 main
        logo = `https://raw.githubusercontent.com/${repoMatch[1]}/${repoMatch[2]}/${branch}/${logoPath}`;
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

// ========== 触发 assemble 工作流 ==========

/**
 * 写入触发标记文件，供 GitHub Actions 判断是否触发 assemble
 * @param {string} triggerFile - 标记文件路径
 * @param {number} newCount - 新发现的 APP 数量
 */
function writeTriggerMarker(triggerFile, newCount) {
    writeJsonFile(triggerFile, {
        newCount,
        timestamp: new Date().toISOString()
    });
}

// ========== 导出 ==========

module.exports = {
    // 常量
    DATA_DIR,
    SHARDS_DIR,
    CATALOGS_DIR,
    CURSOR_FILE,
    APP_LISTS_FILE,
    CATALOG_FILE,
    SHARD_SIZE,
    CATALOG_SHARD_SIZE,
    CANBOX_APP_FILENAME,
    STATUS,
    CATALOG_FILTER,

    // GitHub API
    getOctokit,
    searchCanboxApps,
    fetchRepoFile,
    checkRepoAccess,
    extractRepoMeta,

    // 校验
    validateCanboxApp,
    validatePackageJson,

    // 评分
    calculateRiskScore,
    calculateRiskLevel,
    shouldShowDownload,

    // 状态机
    updateAppStatus,
    checkStaleTransition,

    // ID 与去重
    generateAppId,
    findExistingApp,

    // 分片管理
    ensureDir,
    readJsonFile,
    writeJsonFile,
    readAppListsIndex,
    writeAppListsIndex,
    readAllApps,
    appendAppsToShards,
    writeShard,
    readShard,

    // Cursor
    readCursor,
    writeCursor,

    // 错误历史
    addErrorRecord,

    // Catalog
    filterAppsForCatalog,
    toCatalogApp,

    // 触发
    writeTriggerMarker
};
