/**
 * Catalog Gitee 平台工具模块
 *
 * 本模块只保留 Gitee 平台特有的能力（REST 封装、仓库字段映射、组织+标签发现），
 * 平台无关逻辑（常量、路径、存储、校验、评分、平台适配、组装）统一来自 scripts/common。
 *
 * 发现能力说明（实测结论，详见 change 文档附录 A）：
 *   Gitee 无 GitHub Search API 等价的 topic 检索接口：
 *     - GET /v5/search/repositories 无 topic/label 参数，匿名调用返回 []（需 access_token）
 *     - GET /v5/repos/{owner}/{repo}/topics → 404（Gitee 无 topics 字段）
 *   Gitee 的等价物是「仓库标签 project_labels」：
 *     - GET /v5/orgs/{org}/repos 匿名可读、支持分页，且列表项已直接带 project_labels
 *   因此"检索带 canbox-app 标签的仓库"实现为：组织全量列表 + 本地标签过滤。
 *   限制：发现范围限于该组织内的仓库；组织外的第三方 APP 无法被发现（平台限制）。
 */

const http = require('./http');

const common = require('../common');
// 注册 Gitee 平台适配器（平台常量定义在同目录 adapter.js）
require('./adapter');

const ADAPTER = require('./adapter');

// 平台无关能力解构（供本模块函数体内直接引用）
const {
    CANBOX_APP_FILENAME,
    STATUS,
    generateAppId,
    validateCanboxApp,
    validatePackageJson,
    calculateRiskScore
} = common;

// ========== Gitee 平台常量 ==========

const SITE_BASE = ADAPTER.siteBase;
const API_BASE = `${SITE_BASE}/api/v5`;

/** 参与发现的 Gitee 组织（可用环境变量覆盖） */
const ORG = process.env.CATALOG_GITEE_ORG || 'canbox-io';
/** 参与发现的仓库标签 ident（可用环境变量覆盖） */
const TOPIC_IDENT = process.env.CATALOG_GITEE_TOPIC || 'canbox-app';

const REQUEST_TIMEOUT = 30000;

let tokenWarned = false;

/**
 * 读取 Gitee access_token（可选）
 * 组织列表与标签读取匿名可用，token 仅用于提升限速额度。
 * @returns {string|null}
 */
function getToken() {
    const token = process.env.CATALOG_GITEE_TOKEN || process.env.GITEE_TOKEN || null;
    if (!token && !tokenWarned) {
        tokenWarned = true;
        console.warn('[helpers] No Gitee token found (CATALOG_GITEE_TOKEN / GITEE_TOKEN); using anonymous access (lower rate limit)');
    }
    return token;
}

/**
 * Gitee REST 请求（失败抛出带 status 的错误，便于上层区分 404/403）
 * @param {string} apiPath - 形如 /orgs/{org}/repos
 * @param {object} [params]
 * @returns {Promise<any>}
 */
async function giteeGet(apiPath, params = {}) {
    const token = getToken();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) query.append(key, String(value));
    }
    if (token) query.append('access_token', token);
    const qs = query.toString();
    const url = `${API_BASE}${apiPath}${qs ? `?${qs}` : ''}`;

    const res = await http.get(url, { timeout: REQUEST_TIMEOUT });

    if (res.status >= 200 && res.status < 300) {
        try {
            return JSON.parse(res.body);
        } catch (e) {
            throw new Error(`Gitee API ${apiPath}: invalid JSON response`);
        }
    }

    let detail = res.body;
    try {
        const parsed = JSON.parse(res.body);
        detail = parsed.message || JSON.stringify(parsed);
    } catch (e) {
        // 保留原始响应体
    }
    const wrapped = new Error(`Gitee API ${apiPath} failed (status=${res.status}): ${detail}`);
    wrapped.status = res.status;
    throw wrapped;
}

// ========== 发现：组织全量 + 标签过滤 ==========

/**
 * 列出组织下的一页仓库
 * @param {object} options
 * @param {number} [options.page]
 * @param {number} [options.perPage]
 * @returns {Promise<{items: Array, hasMore: boolean}>}
 */
async function listOrgRepos({ page = 1, perPage = 100 } = {}) {
    const data = await giteeGet(`/orgs/${ORG}/repos`, {
        page,
        per_page: perPage,
        type: 'all'
    });
    const items = Array.isArray(data) ? data : [];
    return { items, hasMore: items.length >= perPage };
}

/**
 * 仓库是否带有目标标签（ident 或 name 命中）
 * @param {object} repo
 * @param {string} [ident]
 * @returns {boolean}
 */
function hasTopicLabel(repo, ident = TOPIC_IDENT) {
    const labels = Array.isArray(repo.project_labels) ? repo.project_labels : [];
    const target = String(ident).toLowerCase();
    return labels.some(label => {
        const labelIdent = String(label && label.ident ? label.ident : '').toLowerCase();
        const labelName = String(label && label.name ? label.name : '').toLowerCase();
        return labelIdent === target || labelName === target;
    });
}

/**
 * 扫描组织全部仓库并过滤出带目标标签的仓库（Gitee 的"发现"实现）
 * @returns {Promise<{items: Array, totalScanned: number}>}
 */
async function listLabeledRepos() {
    const labeled = [];
    let page = 1;
    let totalScanned = 0;

    while (true) {
        console.log(`[helpers] Listing ${ORG} repos page ${page}...`);
        const { items, hasMore } = await listOrgRepos({ page, perPage: 100 });
        totalScanned += items.length;

        for (const repo of items) {
            if (hasTopicLabel(repo)) labeled.push(repo);
        }

        if (!hasMore) break;
        page++;
        await sleep(500);
    }

    console.log(`[helpers] Scanned ${totalScanned} repos in ${ORG}, ${labeled.length} carry label "${TOPIC_IDENT}"`);
    return { items: labeled, totalScanned };
}

/**
 * 取仓库的 owner/repo（去掉 .git 后缀，优先 namespace.path + path）
 * @param {object} repo
 * @returns {string} 形如 owner/repo，取不到返回空串
 */
function getRepoFullName(repo) {
    if (!repo) return '';
    const fullName = String(repo.full_name || '').replace(/\.git$/, '');
    if (fullName) return fullName;
    const owner = (repo.namespace && repo.namespace.path) || (repo.owner && repo.owner.login);
    const name = repo.path || repo.name;
    return owner && name ? `${owner}/${name}` : '';
}

/**
 * 取仓库站点 URL（不含 .git 后缀）
 * @param {object} repo
 * @returns {string|null}
 */
function getRepoUrl(repo) {
    const fullName = getRepoFullName(repo);
    return fullName ? `${SITE_BASE}/${fullName}` : null;
}

// ========== 文件与仓库访问 ==========

/**
 * 通过 raw 地址获取仓库 JSON 文件（.canbox-app / package.json）
 * Gitee raw 需显式分支；未给分支时按 main → master 回退。
 * @param {string} owner
 * @param {string} repo
 * @param {string} filepath
 * @param {string} [branch]
 * @returns {Promise<object|null>} 解析后的 JSON 对象，404/非 JSON 返回 null
 */
async function fetchRepoFile(owner, repo, filepath, branch) {
    const branches = [];
    if (branch) branches.push(branch);
    for (const b of ['main', 'master']) {
        if (!branches.includes(b)) branches.push(b);
    }

    for (const b of branches) {
        const url = `${SITE_BASE}/${owner}/${repo}/raw/${b}/${filepath}`;
        try {
            const res = await http.get(url, { timeout: REQUEST_TIMEOUT });
            if (res.status !== 200) continue;
            try {
                return JSON.parse(res.body);
            } catch (e) {
                return null; // 文件存在但不是合法 JSON
            }
        } catch (err) {
            // 网络/限速等错误：继续尝试下一分支，最终返回 null
            console.warn(`[helpers] ${owner}/${repo}@${b}/${filepath} fetch failed: ${err.message}`);
        }
    }
    return null;
}

/**
 * 检查仓库可访问性
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{status: string, redirect: object|null, repoData: object|null}>}
 */
async function checkRepoAccess(owner, repo) {
    try {
        const data = await giteeGet(`/repos/${owner}/${repo}`);
        return { status: 'active', redirect: null, repoData: data };
    } catch (err) {
        if (err.status === 404) {
            return { status: 'gone', redirect: null, repoData: null };
        }
        if (err.status === 403 || err.status === 401) {
            return { status: 'private', redirect: null, repoData: null };
        }
        throw err;
    }
}

/**
 * 获取仓库元数据（stars、forks、lastCommit 等）
 * 注意：Gitee 的 license 是字符串（GitHub 是对象），这里做统一映射。
 * @param {object} repoData
 * @returns {object}
 */
function extractRepoMeta(repoData) {
    const license = typeof repoData.license === 'string'
        ? (repoData.license || null)
        : (repoData.license ? (repoData.license.spdx_id || null) : null);

    return {
        stars: repoData.stargazers_count || 0,
        forks: repoData.forks_count || 0,
        lastCommitAt: repoData.pushed_at ? new Date(repoData.pushed_at).toISOString() : null,
        license,
        homepage: repoData.homepage || null,
        createdAt: repoData.created_at ? new Date(repoData.created_at).toISOString() : null,
        defaultBranch: repoData.default_branch || null
    };
}

// ========== 仓库 → APP 记录（三个入口脚本共用，避免逻辑三处漂移） ==========

/**
 * 将 Gitee 仓库数据解析为 APP 数据（与 GitHub 侧字段结构完全一致）
 * @param {object} repo - Gitee API 返回的仓库对象
 * @param {string} action - 触发来源（discover / reconcile / rediscover）
 * @returns {Promise<object|null>}
 */
async function repoToApp(repo, action) {
    const fullName = getRepoFullName(repo);
    const repoUrl = getRepoUrl(repo);

    if (!fullName || !repoUrl) {
        console.warn(`[${action}] Skipping repo with missing owner/name: ${JSON.stringify(repo && repo.full_name)}`);
        return null;
    }

    const [owner, repoName] = fullName.split('/');

    let appId;
    try {
        appId = generateAppId(repoUrl, ADAPTER.platform);
    } catch (err) {
        console.warn(`[${action}] Skipping repo with invalid URL: ${repoUrl}`);
        return null;
    }

    const branch = repo.default_branch || 'main';

    let canboxApp = null;
    let pkg = null;
    let hasValidCanboxApp = false;
    let hasValidPackageJson = false;

    try {
        canboxApp = await fetchRepoFile(owner, repoName, CANBOX_APP_FILENAME, branch);
        const canboxValidation = validateCanboxApp(canboxApp);
        hasValidCanboxApp = canboxValidation.valid;
        if (!canboxValidation.valid) {
            console.warn(`[${action}] ${fullName}: .canbox-app validation failed: ${canboxValidation.errors.join(', ')}`);
        }
    } catch (err) {
        console.warn(`[${action}] ${fullName}: Failed to fetch .canbox-app: ${err.message}`);
    }

    try {
        pkg = await fetchRepoFile(owner, repoName, 'package.json', branch);
        const pkgValidation = validatePackageJson(pkg);
        hasValidPackageJson = pkgValidation.valid;
        if (!pkgValidation.valid) {
            console.warn(`[${action}] ${fullName}: package.json validation failed: ${pkgValidation.errors.join(', ')}`);
        }
    } catch (err) {
        console.warn(`[${action}] ${fullName}: Failed to fetch package.json: ${err.message}`);
    }

    const repoMeta = extractRepoMeta(repo);

    const app = {
        id: appId,
        // 字段名沿用 GitHub 侧历史命名，Gitee 实例写入的是 Gitee 仓库 ID（数据契约保持一致）
        githubRepoId: repo.id,
        repo: repoUrl,
        createdAt: repoMeta.createdAt,
        discoveredAt: new Date().toISOString(),
        status: STATUS.UNKNOWN,
        score: 100,
        consecutiveFailures: 0,
        lastCheck: new Date().toISOString(),
        repoStatus: 'active',
        repoStatusDetail: null,
        hasValidCanboxApp,
        hasValidPackageJson,
        errorHistory: [],
        // 保存元数据供 assemble 使用
        _canboxApp: canboxApp,
        _pkg: pkg,
        _repoMeta: repoMeta,
        stars: repoMeta.stars,
        forks: repoMeta.forks,
        lastCommitAt: repoMeta.lastCommitAt
    };

    app.score = calculateRiskScore(app);

    if (hasValidCanboxApp && hasValidPackageJson) {
        app.status = STATUS.ACTIVE;
    }

    return app;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 导出 ==========

module.exports = {
    // 平台无关能力（来自 scripts/common）
    ...common,

    // Gitee 平台常量
    PLATFORM: 'gitee',
    SITE_BASE,
    API_BASE,
    ORG,
    TOPIC_IDENT,
    getToken,
    getRepoFullName,
    getRepoUrl,

    // Gitee API
    giteeGet,
    listOrgRepos,
    hasTopicLabel,
    listLabeledRepos,
    fetchRepoFile,
    checkRepoAccess,
    extractRepoMeta,

    // 通用构造
    repoToApp,
    sleep
};
