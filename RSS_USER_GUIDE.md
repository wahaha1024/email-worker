# RSS 订阅功能使用指南

## 🎯 快速开始

### 1. 访问订阅管理页面
```
https://email.zjyyy.top/feeds
```

### 2. 添加你的第一个订阅源

点击"➕ 添加订阅源"，填写以下信息：

- **订阅源名称**: 例如 "阮一峰的网络日志"
- **RSS 地址**: `https://www.ruanyifeng.com/blog/atom.xml`
- **分类**: 选择"技术"
- **抓取频率**:
  - 可以使用预设：每小时/每6小时/每天
  - 或自定义 cron 表达式

### 3. 查看合并内容

返回首页 `https://email.zjyyy.top`，你会看到：
- 📧 邮件
- 📰 RSS 文章

所有内容按时间倒序排列！

## 📚 常用 RSS 源推荐

### 技术博客
```
阮一峰的网络日志
https://www.ruanyifeng.com/blog/atom.xml
Cron: 0 */6 * * * (每6小时)

少数派
https://sspai.com/feed
Cron: 0 */3 * * * (每3小时)

V2EX - 技术
https://www.v2ex.com/index.xml
Cron: 0 * * * * (每小时)
```

### 新闻资讯
```
36氪
https://36kr.com/feed
Cron: 0 */2 * * * (每2小时)

Hacker News
https://news.ycombinator.com/rss
Cron: 0 */4 * * * (每4小时)
```

## ⏰ Cron 表达式说明

格式：`分 时 日 月 周`

### 常用示例
```bash
# 每小时
0 * * * *

# 每6小时
0 */6 * * *

# 每天早上8点
0 8 * * *

# 每天早8点和晚8点
0 8,20 * * *

# 每30分钟
*/30 * * * *

# 周一到周五，每天早9点
0 9 * * 1-5
```

### 字段说明
- **分钟**: 0-59
- **小时**: 0-23
- **日**: 1-31
- **月**: 1-12
- **周**: 0-6 (0=周日)

### 特殊符号
- `*` - 任意值
- `*/n` - 每 n 个单位
- `n-m` - 范围
- `n,m,o` - 列表

## 🔧 管理订阅源

### 查看订阅源
访问 `/feeds` 可以看到：
- 订阅源名称和 URL
- 最后抓取时间
- Cron 表达式
- 状态（启用/禁用）

### 手动刷新
点击订阅源卡片上的 🔄 按钮即可立即抓取最新文章

### 删除订阅源
点击 🗑️ 按钮可以删除订阅源（会同时删除该源的所有文章）

## 🎨 查看内容

### 首页筛选
使用顶部的筛选按钮：
- **全部** - 显示邮件和 RSS 文章
- **📧 邮件** - 仅显示邮件
- **📰 RSS** - 仅显示 RSS 文章

### 识别内容类型
- 邮件：右上角显示 📧
- RSS：右上角显示 📰，底部有 🌐 标识

## 📱 命令行操作

### 使用 API 添加订阅源
```bash
curl -X POST https://email.zjyyy.top/api/feeds \
  -H "Content-Type: application/json" \
  -d '{
    "name": "订阅源名称",
    "url": "https://example.com/feed",
    "category": "tech",
    "cron_expression": "0 */6 * * *"
  }'
```

### 获取所有订阅源
```bash
curl https://email.zjyyy.top/api/feeds
```

### 手动抓取指定订阅源
```bash
curl -X POST https://email.zjyyy.top/api/feeds/1/fetch
```

### 获取合并内容
```bash
# 所有内容
curl https://email.zjyyy.top/api/unified?type=all

# 仅邮件
curl https://email.zjyyy.top/api/unified?type=email

# 仅 RSS
curl https://email.zjyyy.top/api/unified?type=rss
```

## 🔍 数据库查询

### 查看所有订阅源
```bash
wrangler d1 execute email_db --remote \
  --command "SELECT name, url, cron_expression, is_active FROM rss_feeds"
```

### 查看文章统计
```bash
wrangler d1 execute email_db --remote \
  --command "SELECT f.name, COUNT(a.id) as count
             FROM rss_feeds f
             LEFT JOIN rss_articles a ON f.id = a.feed_id
             GROUP BY f.id"
```

### 查看最新文章
```bash
wrangler d1 execute email_db --remote \
  --command "SELECT title, published_at FROM rss_articles
             ORDER BY published_at DESC LIMIT 10"
```

## ⚙️ 高级配置

### 调整全局 Cron 频率
编辑 `wrangler.jsonc`:
```json
{
  "triggers": {
    "crons": ["*/5 * * * *"]  // 改为你想要的频率
  }
}
```

### 禁用自动抓取
```bash
curl -X PUT https://email.zjyyy.top/api/feeds/1 \
  -H "Content-Type: application/json" \
  -d '{"is_active": 0}'
```

### 启用订阅源
```bash
curl -X PUT https://email.zjyyy.top/api/feeds/1 \
  -H "Content-Type: application/json" \
  -d '{"is_active": 1}'
```

## 🚨 故障排查

### 订阅源抓取失败
1. 检查订阅源状态是否为"禁用"
2. 查看错误信息（在订阅源卡片底部）
3. 手动点击刷新按钮测试
4. 确认 RSS URL 是否有效

### 文章没有更新
1. 检查订阅源的 cron 表达式
2. 确认当前时间是否匹配 cron
3. 查看最后抓取时间
4. 手动刷新测试

### 查看日志
访问 `https://email.zjyyy.top/logs` 查看系统日志

## 💡 最佳实践

1. **合理设置抓取频率**
   - 个人博客：每天1-2次
   - 新闻资讯：每1-2小时
   - 技术论坛：每30分钟-1小时

2. **分类管理**
   - 使用分类组织订阅源
   - 便于后续筛选和管理

3. **定期清理**
   - 删除不再更新的订阅源
   - 清理已读文章（功能开发中）

4. **性能优化**
   - 建议订阅源数量 < 50
   - 避免同时大量订阅源在同一时间抓取

## 📞 支持

遇到问题？
1. 查看 `RSS_DEPLOYMENT_REPORT.md` 了解技术细节
2. 检查 `/diagnostics` 页面
3. 查看系统日志 `/logs`

享受你的 RSS 订阅之旅！🎉
