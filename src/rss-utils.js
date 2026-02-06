// RSS 功能模块
// 简单的 RSS XML 解析器（不依赖外部库）

/**
 * 解析 RSS/Atom Feed
 */
export async function parseRssFeed(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EmailWorker/1.0; +https://email.zjyyy.top)'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xml = await response.text();
    const items = [];

    // 检测是 RSS 还是 Atom
    const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"');

    if (isAtom) {
      // 解析 Atom
      const entryMatches = xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g);
      for (const match of entryMatches) {
        const entry = match[1];
        items.push(parseAtomEntry(entry));
      }
    } else {
      // 解析 RSS
      const itemMatches = xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g);
      for (const match of itemMatches) {
        const item = match[1];
        items.push(parseRssItem(item));
      }
    }

    return items.filter(item => item.title && (item.link || item.guid));
  } catch (error) {
    console.error('RSS parse error:', error);
    throw error;
  }
}

/**
 * 解析 RSS item
 */
function parseRssItem(itemXml) {
  return {
    guid: extractTag(itemXml, 'guid') || extractTag(itemXml, 'link'),
    title: decodeHTML(extractTag(itemXml, 'title')),
    link: extractTag(itemXml, 'link'),
    description: extractCDATA(itemXml, 'description') || extractTag(itemXml, 'description'),
    content: extractCDATA(itemXml, 'content:encoded') || extractTag(itemXml, 'content:encoded'),
    author: extractTag(itemXml, 'author') || extractTag(itemXml, 'dc:creator'),
    pubDate: extractTag(itemXml, 'pubDate') || extractTag(itemXml, 'dc:date'),
  };
}

/**
 * 解析 Atom entry
 */
function parseAtomEntry(entryXml) {
  const linkMatch = entryXml.match(/<link[^>]*href=["']([^"']+)["']/);
  return {
    guid: extractTag(entryXml, 'id'),
    title: decodeHTML(extractTag(entryXml, 'title')),
    link: linkMatch ? linkMatch[1] : '',
    description: extractTag(entryXml, 'summary'),
    content: extractTag(entryXml, 'content'),
    author: extractTag(entryXml, 'author>name') || extractTag(entryXml, 'author'),
    pubDate: extractTag(entryXml, 'updated') || extractTag(entryXml, 'published'),
  };
}

/**
 * 提取 XML 标签内容
 */
function extractTag(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * 提取 CDATA 内容
 */
function extractCDATA(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * HTML 解码
 */
function decodeHTML(html) {
  if (!html) return '';
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * HTML 转纯文本
 */
function stripHTML(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 抓取并保存 RSS 文章
 */
export async function fetchRssArticles(feed, env) {
  try {
    const items = await parseRssFeed(feed.url);
    let newCount = 0;
    let errorCount = 0;

    for (const item of items) {
      try {
        // 检查是否已存在
        const existing = await env.DB.prepare(
          'SELECT id FROM rss_articles WHERE guid = ?'
        ).bind(item.guid).first();

        if (existing) continue;

        // 解析日期
        let publishedAt = new Date().toISOString();
        if (item.pubDate) {
          const parsed = new Date(item.pubDate);
          if (!isNaN(parsed.getTime())) {
            publishedAt = parsed.toISOString();
          }
        }

        // 提取纯文本
        const contentHtml = item.content || item.description || '';
        const contentText = stripHTML(contentHtml).substring(0, 2000);
        const description = stripHTML(item.description || '').substring(0, 500);

        // 插入文章
        await env.DB.prepare(`
          INSERT INTO rss_articles (
            feed_id, guid, title, link, description,
            content_html, content_text, author, published_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          feed.id,
          item.guid,
          item.title,
          item.link,
          description,
          contentHtml.substring(0, 50000),
          contentText,
          item.author || '',
          publishedAt
        ).run();

        newCount++;
      } catch (err) {
        errorCount++;
        console.error('Save article error:', err);
      }
    }

    // 更新订阅源状态
    await env.DB.prepare(`
      UPDATE rss_feeds
      SET last_fetch_at = datetime('now'),
          error_count = 0,
          last_error = NULL
      WHERE id = ?
    `).bind(feed.id).run();

    return { success: true, newCount, total: items.length };
  } catch (error) {
    // 更新错误状态
    await env.DB.prepare(`
      UPDATE rss_feeds
      SET error_count = error_count + 1,
          last_error = ?,
          is_active = CASE WHEN error_count >= 2 THEN 0 ELSE is_active END
      WHERE id = ?
    `).bind(error.message, feed.id).run();

    return { success: false, error: error.message };
  }
}

/**
 * 检查 cron 表达式是否匹配当前时间
 * 简化版本，支持基本的 cron 表达式
 * 格式：分 时 日 月 周
 */
export function shouldRunCron(cronExpression, now = new Date()) {
  try {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const [minute, hour, day, month, weekday] = parts;

    const nowMinute = now.getUTCMinutes();
    const nowHour = now.getUTCHours();
    const nowDay = now.getUTCDate();
    const nowMonth = now.getUTCMonth() + 1;
    const nowWeekday = now.getUTCDay();

    return (
      matchCronPart(minute, nowMinute, 0, 59) &&
      matchCronPart(hour, nowHour, 0, 23) &&
      matchCronPart(day, nowDay, 1, 31) &&
      matchCronPart(month, nowMonth, 1, 12) &&
      matchCronPart(weekday, nowWeekday, 0, 6)
    );
  } catch (e) {
    return false;
  }
}

/**
 * 匹配 cron 表达式的单个部分
 */
function matchCronPart(pattern, value, min, max) {
  // * 匹配所有
  if (pattern === '*') return true;

  // */n 步长
  if (pattern.startsWith('*/')) {
    const step = parseInt(pattern.substring(2));
    return value % step === 0;
  }

  // n-m 范围
  if (pattern.includes('-')) {
    const [start, end] = pattern.split('-').map(Number);
    return value >= start && value <= end;
  }

  // n,m,o 列表
  if (pattern.includes(',')) {
    const values = pattern.split(',').map(Number);
    return values.includes(value);
  }

  // 单个数字
  return parseInt(pattern) === value;
}

/**
 * 抓取所有应该运行的 RSS 订阅源
 */
export async function fetchAllDueFeeds(env) {
  try {
    const now = new Date();
    const { results: feeds } = await env.DB.prepare(`
      SELECT * FROM rss_feeds WHERE is_active = 1
    `).all();

    let fetchedCount = 0;
    const results = [];

    for (const feed of feeds || []) {
      // 检查 cron 表达式
      if (shouldRunCron(feed.cron_expression, now)) {
        const result = await fetchRssArticles(feed, env);
        results.push({ feed: feed.name, ...result });
        if (result.success) fetchedCount++;
      }
    }

    return { total: feeds?.length || 0, fetched: fetchedCount, results };
  } catch (error) {
    console.error('Fetch all feeds error:', error);
    return { error: error.message };
  }
}
