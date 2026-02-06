# Email-Worker - 邮件 + RSS 订阅管理系统

<div align="center">

**🎨 采用 Koobai 精美设计 | ⚡ 部署在 Cloudflare Workers | 📰 邮件与 RSS 完美融合**

[![部署状态](https://img.shields.io/badge/部署-成功-success)](https://email.zjyyy.top)
[![版本](https://img.shields.io/badge/版本-4c9013ac-blue)](https://email.912741793.workers.dev)
[![许可证](https://img.shields.io/badge/许可证-MIT-green)](LICENSE)

[在线演示](https://email.zjyyy.top) · [功能演示](DEMO_GUIDE.md) · [部署报告](RSS_DEPLOYMENT_REPORT.md)

</div>

---

## ✨ 特性

### 📧 邮件管理
- ✅ Cloudflare Email Routing 自动接收
- ✅ Postal-MIME 完整邮件解析
- ✅ HTML/纯文本双格式支持
- ✅ 附件信息提取
- ✅ 批量操作（已读/删除）

### 📰 RSS 订阅
- ✅ RSS 2.0 / Atom 格式支持
- ✅ 每个订阅源独立 Cron 表达式
- ✅ 自动定时抓取（每5分钟检查）
- ✅ 文章去重和内容解析
- ✅ 错误重试和自动禁用

### 🔍 搜索与筛选
- ✅ 全文搜索（标题+内容）
- ✅ 类型筛选（全部/邮件/RSS）
- ✅ 分类筛选（收件箱/重要/未读）
- ✅ 组合筛选支持

### 🎨 Koobai 设计
- ✅ 温暖米色背景 (#f2f0eb)
- ✅ 磨砂玻璃底部导航栏
- ✅ 圆角卡片布局
- ✅ Lucide 图标系统
- ✅ 响应式设计

---

## 🚀 快速开始

### 在线访问
```
https://email.zjyyy.top
```

### 本地开发
```bash
# 克隆仓库
git clone https://github.com/wahaha1024/email-worker.git
cd email-worker

# 安装依赖
npm install

# 本地开发
npm run dev

# 部署到 Cloudflare
npm run deploy
```

---

## 📦 部署信息

### 环境要求
- Cloudflare Workers (免费版可用)
- Cloudflare D1 数据库
- Cloudflare Email Routing
- Node.js 16+ (仅开发时需要)

### 数据库表
```sql
-- 邮件主表
emails (14 封)

-- RSS 订阅源
rss_feeds (2 个)

-- RSS 文章
rss_articles (13 篇)

-- 系统日志
email_logs (661 条)

-- 转发历史
forward_history

-- 标签系统（预留）
tags, email_tags
```

### 当前版本
- **版本 ID**: `4c9013ac-8e8f-475f-af62-c1e690ba416a`
- **部署时间**: 2026-02-06
- **文件大小**: 221.78 KB (gzip: 49.67 KB)
- **Cron 触发器**: `*/5 * * * *`

---

## 📖 功能文档

### 核心功能
1. [RSS 订阅功能](RSS_DEPLOYMENT_REPORT.md) - RSS 订阅完整指南
2. [用户使用指南](RSS_USER_GUIDE.md) - RSS 使用说明
3. [功能修复报告](FEATURE_RESTORE_REPORT.md) - 筛选/搜索/编辑
4. [完整演示](DEMO_GUIDE.md) - 功能演示和使用场景

### API 端点
```
# 邮件相关
GET  /                      - 首页（合并视图）
GET  /view/:id              - 邮件详情
POST /api/mark-read         - 标记已读
POST /api/delete            - 删除邮件

# RSS 相关
GET  /feeds                 - 订阅管理
GET  /api/feeds             - 获取订阅源
POST /api/feeds             - 添加订阅源
POST /api/feeds/:id/fetch   - 手动抓取
GET  /article/:id           - 文章详情
POST /api/articles/mark-read - 标记文章已读
POST /api/articles/delete   - 删除文章

# 合并与搜索
GET  /api/unified           - 合并内容 API
GET  /?search=关键词         - 搜索
GET  /?type=email|rss|all   - 类型筛选

# 系统相关
GET  /logs                  - 系统日志
GET  /diagnostics           - 系统诊断
GET  /api/stats             - 统计信息
```

---

## 🎯 使用场景

### 场景 1：统一订阅管理
将邮件订阅和 RSS 订阅集中管理，一个界面查看所有更新。

### 场景 2：技术资讯聚合
订阅技术博客的 RSS，接收技术邮件，统一时间线查看。

### 场景 3：新闻快速浏览
订阅新闻源的 RSS，配合搜索功能快速找到感兴趣的内容。

### 场景 4：邮件归档
所有邮件自动存储到 D1 数据库，永久保存，随时搜索。

---

## 🔧 配置说明

### Cron 表达式示例
```bash
# 每小时
0 * * * *

# 每6小时
0 */6 * * *

# 每天早8点
0 8 * * *

# 每周一早9点
0 9 * * 1

# 每30分钟
*/30 * * * *
```

### 环境变量
```toml
# Cloudflare 认证
CLOUDFLARE_EMAIL = "your@email.com"
CLOUDFLARE_API_KEY = "your_api_key"

# 数据库 ID
DATABASE_ID = "a79d1a10-f57c-4db3-a9f6-f2abf5ba84fa"
```

---

## 📊 性能指标

- **响应时间**: < 100ms
- **RSS 抓取**: 1-3 秒/源
- **数据库查询**: < 10ms
- **Worker CPU**: < 10ms (免费版限制)
- **数据库大小**: 1.78 MB
- **部署区域**: APAC (Singapore)

---

## 🛠️ 技术栈

### 后端
- **运行时**: Cloudflare Workers
- **数据库**: Cloudflare D1 (SQLite)
- **邮件解析**: postal-mime v2.7.3

### 前端
- **框架**: 原生 JavaScript
- **样式**: 内联 CSS (Koobai 风格)
- **图标**: Lucide Icons
- **字体**: JetBrains Mono

### 工具
- **构建**: Wrangler 4.61.1
- **包管理**: npm
- **版本控制**: Git

---

## 📝 开发日志

### v2.0 (2026-02-06)
- ✅ 添加 RSS 订阅功能
- ✅ 每个订阅源独立 Cron 支持
- ✅ 邮件与 RSS 合并视图
- ✅ 修复筛选/搜索/编辑功能
- ✅ 智能类型识别
- ✅ 批量操作支持混合类型

### v1.0 (2026-01-29)
- ✅ 邮件接收和存储
- ✅ Koobai 风格 UI
- ✅ 基础筛选和搜索
- ✅ 日志系统

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 开发指南
1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

---

## 🙏 致谢

- [Cloudflare Workers](https://workers.cloudflare.com/) - 强大的边缘计算平台
- [Postal-MIME](https://github.com/postalsys/postal-mime) - 邮件解析库
- [Lucide Icons](https://lucide.dev/) - 精美的图标库
- [Koobai.com](https://koobai.com/) - UI 设计灵感
- Developed with [CodeBuddy](https://codebuddy.ai) + Kimi 2.5

---

## 📧 联系方式

- **作者**: wahaha
- **邮箱**: 912741793@qq.com
- **网站**: https://zjyyy.top

---

<div align="center">

**⭐ 如果这个项目对你有帮助，请给个 Star！**

Made with ❤️ by wahaha

</div>
