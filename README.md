<div align="center">

# ICEIU · 学堂在线作业控制台

一个 Web 控制台，根据你提供的答案自动提交学堂在线（xuetangx.com）的小节/章节测试。
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

## 🚀 快速开始

```bash
cd workflow
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
```

<div align="center">Crafted by <b>ICEIU</b></div>
