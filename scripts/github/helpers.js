/**
 * Catalog GitHub 平台工具模块
 *
 * 本模块只保留 GitHub 平台特有的能力（octokit REST 封装、GitHub 仓库字段映射），
 * 平台无关逻辑（常量、路径、存储、校验、评分、平台适配、组装）统一来自 scripts/common。
 */

const { Octokit } = require('@octokit/rest');

const common = require('../common');
// 注册 GitHub 平台适配器（平台常量定义在同目录 adapter.js）
require('./adapter');

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

// ========== 导出 ==========

module.exports = {
    // 平台无关能力（来自 scripts/common）
    ...common,

    // GitHub 平台常量
    PLATFORM: 'github',

    // GitHub API
    getOctokit,
    searchCanboxApps,
    fetchRepoFile,
    checkRepoAccess,
    extractRepoMeta
};
