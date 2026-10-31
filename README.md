# X 关注助手 · X Follow Helper

中文界面 X（Twitter）关注管理浏览器扩展：扫未互关 / 批量取关 / 关注健康度分析。

A Chinese-UI X (Twitter) following-management Chrome extension: scan non-mutual follows, batch unfollow with safety pacing, and following-health analytics.

## 功能 Features

- **扫未互关** — 抓取关注列表 + 批量互关检测，列出未互关账号（粉丝数/帖数/注册时间）
- **批量取关** — 勾选/全选分批取关，间隔 20s+随机抖动，每日上限 100，断点续跑，可暂停/停止
- **白名单** — 受保护账号永不取关（支持 @用户名 解析）
- **任务日志** — 实时日志 + 历史记录 + CSV 导出
- **关注健康度分析** — 互关率环形图 / 僵尸粉·营销号检测 / 活跃度排名 / 报告导出
- **取关追踪** — 粉丝快照对比，谁取关了你 / 新粉丝
- **智能过滤** — 按粉丝数 / 帖数 / 语言过滤，防误删

## 安装 Installation

1. 下载/克隆本仓库
2. 打开 Chrome → `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点「加载已解压的扩展程序」，选择本项目目录
5. 打开 https://x.com 并登录 → 点扩展图标开侧边栏

## 使用说明 Usage

1. 打开 x.com 页面（扩展需要页面会话执行请求）
2. 侧边栏自动扫描，完成后「未互关」列表展示结果
3. 勾选账号 → 取关选中（默认间隔 20s、日上限 100，可在「设置」调整）
4. 白名单账号永远不会被取关

## 技术原理 How it works

- 扩展在 x.com 页面内**同源调用 X 网页端接口**（自动携带你的登录会话），**不收集、不传输任何数据**——所有处理都在本地浏览器完成
- 请求经 content script 同源 fetch 转发（background 无法携带页面 cookie 会话）
- 取关走 REST `friendships/destroy.json`（带 `x-client-transaction-id`），关注/粉丝列表走 `friends/list.json` / `followers/list.json`

## 安全与风控 Safety

- 取关间隔默认 20s + 随机抖动 5-10s，每日上限 100（X 风控红线内）
- 白名单优先跳过；任务可随时暂停/停止
- ⚠️ 请自行评估并遵守 X 服务条款与平台规则，因滥用导致的账号风险由使用者自负
- ⚠️ X 网页端接口可能随时变动，本项目会尽力跟进，但不保证长期有效

## 路线图 Roadmap

- [x] MVP：扫未互关 / 批量取关 / 白名单 / 任务日志
- [x] v2：健康度分析 / 取关追踪 / 智能过滤
- [ ] 多账号支持
- [x] 分发：GitHub Releases 提供 zip 包（开发者模式安装）

## 支持 Support

本项目完全开源免费。如果它帮到了你，欢迎随意赞赏 💛（自愿，无任何功能绑定）。

This project is fully open-source and free. If it helps you, a small tip is welcome 💛 (voluntary, no features are tied to donations).

<div align="center">
  <img src="assets/alipay-qr.jpg" width="240" alt="支付宝赞赏码 Alipay tip QR" />
  <p><b>支付宝赞赏码 · Alipay tip QR</b></p>
</div>

## License

MIT

---

*数据本地处理 · 无服务器 · 无追踪*
