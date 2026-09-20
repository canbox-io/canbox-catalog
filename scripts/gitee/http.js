/**
 * 极简 HTTPS 请求封装（Gitee 侧专用）
 *
 * 为什么不用 axios/octokit：本仓库现有依赖只有 @octokit/rest（GitHub 专用），
 * Gitee 侧只需 GET + 跟随重定向（raw 会 302 到 raw.giteeusercontent.com），
 * 用 Node 内置 https 即可，不引入新依赖。
 */

const https = require('https');

const DEFAULT_TIMEOUT = 30000;
const MAX_REDIRECTS = 5;
const UA = 'canbox-catalog-bot';

/**
 * 发起 GET 请求（自动跟随 3xx 重定向）
 * @param {string} url
 * @param {object} [options]
 * @param {object} [options.headers]
 * @param {number} [options.timeout]
 * @param {number} [options.redirectsLeft]
 * @returns {Promise<{status: number, headers: object, body: string}>}
 */
function get(url, options = {}) {
    const redirectsLeft = options.redirectsLeft === undefined ? MAX_REDIRECTS : options.redirectsLeft;

    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(url);
        } catch (e) {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }

        const req = https.request(
            u,
            {
                method: 'GET',
                headers: {
                    'User-Agent': UA,
                    Accept: 'application/json, text/plain, */*',
                    ...(options.headers || {})
                },
                timeout: options.timeout || DEFAULT_TIMEOUT
            },
            res => {
                const status = res.statusCode;

                // 跟随重定向（Gitee raw → raw.giteeusercontent.com）
                if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) {
                        reject(new Error(`Too many redirects: ${url}`));
                        return;
                    }
                    const next = new URL(res.headers.location, url).toString();
                    resolve(get(next, { ...options, redirectsLeft: redirectsLeft - 1 }));
                    return;
                }

                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        status,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf-8')
                    });
                });
                res.on('error', reject);
            }
        );

        req.on('timeout', () => {
            req.destroy(new Error(`Request timeout (${options.timeout || DEFAULT_TIMEOUT}ms): ${url}`));
        });
        req.on('error', reject);
        req.end();
    });
}

module.exports = {
    get
};
