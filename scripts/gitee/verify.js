/**
 * Action 2：校验与刷新（Gitee 实例）
 */

const helpers = require('./helpers');
const { runVerify } = require('../common/verify');

runVerify(helpers).catch(err => {
    console.error('[verify] Fatal error:', err);
    process.exit(1);
});
