// config/index.js - 统一配置：从 .env 读取，叠加默认值。换课程/账号改 .env 即可。
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const num = (v, d) => (v != null && v !== '' ? Number(v) : d);

module.exports = {
  // —— 课程标识（从学习页 URL / 抓包获取，在 .env 配置）——
  CLASSROOM_ID: num(process.env.CLASSROOM_ID, 0),   // cid
  SKU_ID: num(process.env.SKU_ID, 0),
  SIGN: process.env.SIGN || '',

  // —— 运行参数 ——
  CONCURRENCY: num(process.env.CONCURRENCY, 1),                  // 提交并发数（串行=1，避免撞限速）
  MAX_RETRY: num(process.env.MAX_RETRY, 6),                     // 单题限速退避重试次数
  SUBMIT_INTERVAL_MS: num(process.env.SUBMIT_INTERVAL_MS, 1200), // 每题提交间隔(配速,~50题/分钟)

  // —— 登录态 cookie（也可在 Web 控制台里填）——
  COOKIE: (process.env.COOKIE || '').trim(),

  // —— 目录 ——
  ROOT,
  ANSWERS_DIR: path.join(ROOT, 'data', 'answers'),
  ANSWER_DB_DIR: path.join(ROOT, 'data', 'answer-db'),
  DISCUSSION_STATE_DIR: path.join(ROOT, 'data', 'discussion-state'),
  LOGS_DIR: path.join(ROOT, 'logs'),
};
