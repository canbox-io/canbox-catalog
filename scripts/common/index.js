/**
 * Catalog 公共模块入口（平台无关）
 *
 * 聚合常量、路径、存储、校验、评分、平台适配与组装能力，
 * 供 scripts/github/* 与 scripts/gitee/* 复用。
 */

module.exports = {
    ...require('./constants'),
    ...require('./paths'),
    ...require('./storage'),
    ...require('./validate'),
    ...require('./scoring'),
    ...require('./platform-adapter'),
    ...require('./assemble')
};
