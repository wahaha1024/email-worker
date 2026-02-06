-- RSS 订阅功能数据库表

-- 1. RSS 订阅源表
CREATE TABLE IF NOT EXISTS rss_feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                    -- 订阅源名称
  url TEXT NOT NULL UNIQUE,              -- RSS 地址
  category TEXT DEFAULT 'tech',          -- 分类：tech/news/blog/other
  favicon TEXT,                          -- 站点图标 URL
  cron_expression TEXT DEFAULT '0 * * * *',  -- cron 表达式，默认每小时
  last_fetch_at DATETIME,                -- 最后抓取时间
  is_active BOOLEAN DEFAULT 1,           -- 是否启用
  error_count INTEGER DEFAULT 0,         -- 连续错误次数
  last_error TEXT,                       -- 最后错误信息
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. RSS 文章表
CREATE TABLE IF NOT EXISTS rss_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL,              -- 关联 rss_feeds.id
  guid TEXT NOT NULL UNIQUE,             -- 文章唯一标识
  title TEXT NOT NULL,                   -- 标题
  link TEXT NOT NULL,                    -- 原文链接
  description TEXT,                      -- 摘要
  content_html TEXT,                     -- 完整内容（HTML）
  content_text TEXT,                     -- 纯文本内容
  author TEXT,                           -- 作者
  published_at DATETIME,                 -- 发布时间
  is_read BOOLEAN DEFAULT 0,             -- 已读标记
  is_starred BOOLEAN DEFAULT 0,          -- 星标
  is_deleted BOOLEAN DEFAULT 0,          -- 软删除
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feed_id) REFERENCES rss_feeds(id) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_rss_articles_feed ON rss_articles(feed_id);
CREATE INDEX IF NOT EXISTS idx_rss_articles_published ON rss_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_rss_articles_deleted ON rss_articles(is_deleted);
CREATE INDEX IF NOT EXISTS idx_rss_articles_read ON rss_articles(is_read);
CREATE INDEX IF NOT EXISTS idx_rss_feeds_active ON rss_feeds(is_active);
