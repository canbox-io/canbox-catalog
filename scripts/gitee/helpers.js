/**
 * Catalog Gitee 平台工具模块
 *
 * 保留 Gitee OpenAPI 封装与字段映射；平台无关逻辑统一来自 scripts/common。
 * Gitee 没有与 GitHub topic 等价的公开检索能力，因此不提供 discover / reconcile。
 */

const common = require('../common');
require('./adapter');

const API_BASE = 'https://gitee.com/api/v5';

function getToken() {
    return process.env.GITEE_TOKEN || process.env.CATALOG_GITEE_TOKEN || '';
}

/**
 * 发起 Gitee OpenAPI GET 请求
 * @param {string} pathname - 以 /repos/... 开头的路径
 * @returns {Promise<Response>}
 */
function giteeFetch(pathname) {
    const url = new URL(`${API_BASE}${pathname}`);
    const token = getToken();
    if (token) url.searchParams.set('access_token', token);
    return fetch(url, {
        headers: {
            'User-Agent': 'canbox-catalog/1.0',
            'Accept': 'application/json'
        }
    });
}

async function readJsonSafe(res) {
    try {
        return await res.json();
    } catch (_) {
        return null;
    }
}

function httpError(res, action) {
    const err = new Error(`Gitee API ${action} failed with status ${res.status}`);
    err.status = res.status;
    return err;
}

/**
 * 检查仓库可访问性
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{status: string, repoData: object|null}>}
 */
async function checkRepoAccess(owner, repo) {
    const res = await giteeFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);

    if (res.status === 404) {
        return { status: 'gone', repoData: null };
    }
    if (res.status === 401 || res.status === 403) {
        const body = await readJsonSafe(res);
        const message = String(body && body.message ? body.message : '');
        // 限流不能当作私有仓库，否则会把正常 APP 误判为私库
        if (/rate limit|too many|频繁|限流/i.test(message)) {
            const err = new Error(message || 'Gitee API rate limit exceeded');
            err.status = res.status;
            throw err;
        }
        return { status: 'private', repoData: null };
    }
    if (!res.ok) {
        throw httpError(res, 'checkRepoAccess');
    }

    const data = await readJsonSafe(res);
    if (!data) throw new Error('Gitee API returned invalid JSON');
    return { status: 'active', repoData: data };
}

/**
 * 获取仓库文件内容
 * @param {string} owner
 * @param {string} repo
 * @param {string} filepath
 * @returns {Promise<object|null>} 解析后的 JSON 对象，404 或目录返回 null
 */
async function fetchRepoFile(owner, repo, filepath) {
    const encodedPath = String(filepath).split('/').map(encodeURIComponent).join('/');
    const res = await giteeFetch(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`
    );

    if (res.status === 404) return null;
    if (!res.ok) throw httpError(res, 'fetchRepoFile');

    const data = await readJsonSafe(res);
    if (!data || Array.isArray(data) || !data.content) return null;

    const text = Buffer.from(data.content, 'base64').toString('utf-8');
    return JSON.parse(text);
}

/**
 * 探测指定版本的 Release 资产
 * 匹配规则与 GitHub 保持一致：只认 `{id}-{version}.zip` / `{name}-{version}.zip`
 * @param {string} owner
 * @param {string} repo
 * @param {string} version
 * @param {string[]} identifiers
 * @returns {Promise<{found: boolean, assetName: string|null, tag: string|null, available: string[]}>}
 */
async function findReleaseAsset(owner, repo, version, identifiers = []) {
    const prefixes = Array.from(new Set(identifiers.filter(Boolean)));
    const tags = [`v${version}`, version];
    const available = [];

    for (const tag of tags) {
        const res = await giteeFetch(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`
        );
        if (res.status === 404) continue;
        if (!res.ok) throw httpError(res, 'findReleaseAsset');

        const data = await readJsonSafe(res);
        // Gitee 在 tag 不存在时可能返回字面量 null
        if (!data || typeof data !== 'object') continue;

        const assets = Array.isArray(data.assets) ? data.assets : [];
        const names = assets.map(asset => asset.name).filter(Boolean);
        available.push(...names);

        const assetName = names.find(name =>
            prefixes.some(prefix => name === `${prefix}-${version}.zip`)
        );
        if (assetName) {
            return { found: true, assetName, tag, available: names };
        }
    }

    return { found: false, assetName: null, tag: null, available };
}

/**
 * 提取仓库元数据
 * @param {object} repoData - Gitee 仓库 API 返回数据
 * @returns {object}
 */
function extractRepoMeta(repoData) {
    let license = null;
    if (typeof repoData.license === 'string') {
        license = repoData.license;
    } else if (repoData.license && typeof repoData.license.name === 'string') {
        license = repoData.license.name;
    }

    return {
        stars: repoData.stargazers_count || 0,
        forks: repoData.forks_count || 0,
        lastCommitAt: toIsoOrNull(repoData.pushed_at || repoData.updated_at),
        license,
        homepage: repoData.homepage || null,
        createdAt: toIsoOrNull(repoData.created_at),
        defaultBranch: repoData.default_branch || null
    };
}

function toIsoOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

module.exports = {
    ...common,

    PLATFORM: 'gitee',

    getToken,
    checkRepoAccess,
    fetchRepoFile,
    findReleaseAsset,
    extractRepoMeta
};
