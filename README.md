<div align="center">

# ICEIU · 学堂在线学习控制台

一个 Web 控制台，根据你提供的答案自动提交学堂在线（xuetangx.com）的小节/章节测试。
也支持查询与完成指定视频的观看进度，并回查服务器确认结果。
纯https协议实现。

</div>

---

## ⚠️ 免责声明

本项目仅用于学习与技术研究。使用所产生的一切后果由使用者自行承担，与作者无关。继续使用即表示同意。

---

## ✨ 功能

- 🔐 **只需一个 cookie**：粘贴登录态即可，纯 HTTPS 调用。
- 📊 **作业状态板**：一览所有作业的完成 / 判对情况。
- ⚡ **一键自动提交**：自动跳过已做的题，配速提交，避开服务器限速。
- 📜 **实时日志**：每道题提交结果逐行滚动，进度条 + 实时速率。
- 🎬 **整门课程视频**：选择一门已选课程，自动遍历该课程全部视频，跳过已完成项，批量上报并逐项回查；支持停止和重新运行。

## 🚀 快速开始

```bash
cd xuetangx
npm install                  # 安装后端依赖
cp .env.example .env         # 配置课程参数（见下）
npm run console              # 构建前端 + 启动服务（首次）
# 之后可直接 npm run serve（前端已构建）
```

浏览器打开 **http://127.0.0.1:8788**

1. F12 → Network → 复制任意请求的 Cookie 头（须含 `sessionid`、`csrftoken`），粘贴到「登录态」框 → 连接。
2. 把你的答案放入 `data/answers/`（格式见下）。
3. 点右上角「作业状态板」查看完成情况。
4. 点「开始」，看日志实时滚动。

视频功能独立于答案文件和 `.env` 中的作业课程参数：连接 Cookie 后，从下拉框选择一门「正在上课」的已选课程，点击「一键完成本课程全部视频」，即可自动扫描并执行，无需逐个粘贴链接。也可以先点击「查看本课程视频」查看数量。批量范围仅为选定课程的点播视频；不会处理其他课程、作业、考试或讨论。重跑会重新读取后端状态并跳过已完成视频。失败视频会单独列出；登录态失效会停止剩余批次。

默认串行处理视频，每个视频确认完成后再处理下一个；可选并发数 1–3。所有视频请求统一配速，至少间隔 750 毫秒；已完成视频优先依据课程进度汇总跳过，减少重复查询。遇到 HTTP 429 时，所有任务共享等待时间，按 `Retry-After` 或平台提示自动重试，最多重试 3 次；仍被限速则停止剩余任务。HTTP 403 访问限制会停止任务，网络中断等无法确定写入结果的错误不会自动重放。

如只需指定一个视频，展开「指定单个视频」，粘贴学习页链接，查询后执行。链接格式为 `https://www.xuetangx.com/learn/space/<SIGN>/<课程标识>/<CLASSROOM_ID>/video/<LEAF_ID>`。

视频时长自动从后端进度、视频详情或播放地址接口读取；若均未返回，填写播放器显示的总秒数（例如 11:34 填 `694`）。每批最多 50 条记录；发送进度到 100% 后还会回查 `completed`，只有服务器确认才显示完成。HTTP 200 本身不代表完成；未确认、失效登录态或限速会显示错误。停止会中断后续请求，已被后端接收的记录不会撤销。切换账号会停止当前视频任务。

该功能基于当前学堂在线普通点播视频接口实现，平台规则变化时可能无法完成；暂不支持直播、回放或数字人视频。无需 Chrome/CDP，已完成的视频不重复上报。

## ⚙️ 配置（`.env`）

| 字段 | 说明 |
|------|------|
| `CLASSROOM_ID` / `SKU_ID` / `SIGN` | 课程标识，从学习页 URL（`.../learn/space/<SIGN>/<SIGN>/<CLASSROOM_ID>/...`）获取 |
| `CONCURRENCY` | 提交并发数，建议 `1` |
| `COOKIE` | 登录态 |

> **关于限速**：提交接口约有 **20 次/分钟/账号** 的窗口限速，超出会被 `throttled`。本工具默认配速到约 20/分钟，平稳不触发；调小 `SUBMIT_INTERVAL_MS` 会更快但易撞限速。

## 📝 答案数据格式

把每套作业的答案放到 `data/answers/<作业名>.json`，由你自行准备：

```json
{
  "section": "1.1.2 小节测试",
  "leaf_id": 12345678,
  "exercise_id": 1234567,
  "questions": [
    { "problem_id": 11111111, "type": "choice", "answer": "B" },
    { "problem_id": 22222222, "type": "judge",  "answer": "正确" },
    { "problem_id": 33333333, "type": "multi",  "answers": ["A", "C"] },
    { "problem_id": 44444444, "type": "fill",   "answers": ["答案1", "答案2"] }
  ]
}
```

- `type`：`choice`(单选) / `multi`(多选) / `judge`(判断) / `fill`(填空)
- `answer`：单选/判断的答案；`answers`：多选/填空的答案数组
- `leaf_id`、`exercise_id`、`problem_id`：题目在平台上的标识

## 📁 目录结构

```
workflow/
├── server/        # 后端：Express + SSE + 静态托管（仅监听 127.0.0.1）
├── web/           # 前端：Vue 3 + Vite（玻璃拟态控制台）
├── src/           # 核心：纯 HTTPS 请求 / 题型解析 / 提交逻辑
├── scripts/       # CLI：验证 cookie / 提交 / 核对
├── config/        # 配置（读 .env）
├── data/answers/  # 答案数据（自行准备，不入库）
└── logs/          # 运行日志（不入库）
```

## 🛠️ CLI（可选，无需网页）

```bash
npm run check     # 验证 cookie 是否有效
npm run submit    # 提交（不传参=全部未完成；可传作业名）
npm run verify    # 查服务器真实完成情况
npm run video -- '<课程学习页URL>' --course        # 扫描指定已选课程的全部视频
npm run video -- '<课程学习页URL>' --course --complete  # 一次运行，自动完成这门课的全部视频
npm run video -- '<课程学习页URL>' --course --complete --concurrency=2  # 视频级并发，范围 1–3
npm run video -- '<视频学习页URL>'                 # 只查询，使用 .env 的 COOKIE
npm run video -- '<视频学习页URL>' --complete      # 完成并回查
npm run video -- '<视频学习页URL>' --complete --duration=694  # 无法自动获取时补充时长
npm test          # 核心视频流程和任务状态测试（不访问真实账号）
```

<div align="center">Crafted by <b>ICEIU</b></div>
