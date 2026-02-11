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
  // 处理 CDATA 包装的内容
  const cdataRegex = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  // 处理常规标签内容
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * 提取 CDATA 内容（保留作为兼容性）
 */
function extractCDATA(xml, tagName) {
  return extractTag(xml, tagName);
}

/**
 * HTML 解码 - 支持更多实体和数字编码
 */
function decodeHTML(html) {
  if (!html) return '';

  // 常见命名实体（使用 Unicode 转义避免语法问题）
  const entities = {
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&#039;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&ndash;': '\u2013',
    '&mdash;': '\u2014',
    '&lsquo;': '\u2018',
    '&rsquo;': '\u2019',
    '&ldquo;': '\u201C',
    '&rdquo;': '\u201D',
    '&hellip;': '\u2026',
    '&copy;': '\u00A9',
    '&reg;': '\u00AE',
    '&trade;': '\u2122',
    '&bull;': '\u2022',
    '&middot;': '\u00B7',
    '&deg;': '\u00B0',
    '&plusmn;': '\u00B1',
    '&times;': '\u00D7',
    '&divide;': '\u00F7',
    '&frac12;': '\u00BD',
    '&frac14;': '\u00BC',
    '&frac34;': '\u00BE'
  };

  // 先处理命名实体
  let result = html.replace(/&[a-z]+;/gi, match => entities[match.toLowerCase()] || match);

  // 处理十进制数字实体 &#123;
  result = result.replace(/&#(\d+);/g, (match, dec) => {
    const code = parseInt(dec, 10);
    return code > 0 && code < 65536 ? String.fromCharCode(code) : match;
  });

  // 处理十六进制数字实体 &#x7B;
  result = result.replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
    const code = parseInt(hex, 16);
    return code > 0 && code < 65536 ? String.fromCharCode(code) : match;
  });

  return result;
}

/**
 * 深度解码 HTML - 处理多重编码
 */
function deepDecodeHTML(html) {
  if (!html) return '';
  let prev = '';
  let current = html;
  // 最多解码 3 次，防止无限循环
  for (let i = 0; i < 3 && current !== prev; i++) {
    prev = current;
    current = decodeHTML(current);
  }
  return current;
}

/**
 * HTML 转纯文本
 */
function stripHTML(html) {
  if (!html) return '';
  // 1. 移除 script, style 标签
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // 2. 移除所有 HTML 标签
  text = text.replace(/<[^>]+>/g, ' ');
  // 3. 解码 HTML 实体
  text = decodeHTML(text);
  // 4. 压缩空白符
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 抓取并保存 RSS 文章
 */
export async function fetchRssArticles(feed, env, addLog, source = 'unknown') {
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

        // 提取内容并深度解码 HTML 实体
        const rawContent = item.content || item.description || '';
        const contentHtml = deepDecodeHTML(rawContent);
        const contentText = stripHTML(contentHtml).substring(0, 2000);
        const description = stripHTML(deepDecodeHTML(item.description || '')).substring(0, 500);

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

    // 记录日志（仅当有新文章时）
    if (newCount > 0 && addLog) {
      await addLog(env, 'rss', 'fetch', {
        feed: feed.name,
        newCount,
        total: items.length,
        source,
        time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      });
    }

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
 * 使用东八区时间 (Asia/Shanghai)
 */
export function shouldRunCron(cronExpression, now = new Date()) {
  try {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const [minute, hour, day, month, weekday] = parts;

    // 使用东八区时间
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false
    });
    const dateParts = formatter.formatToParts(now);
    const getPart = (type) => dateParts.find(p => p.type === type)?.value;

    const nowMinute = parseInt(getPart('minute'));
    const nowHour = parseInt(getPart('hour'));
    const nowDay = parseInt(getPart('day'));
    const nowMonth = parseInt(getPart('month'));
    // 转换星期：周日=0, 周一=1, ..., 周六=6
    const weekdayStr = getPart('weekday');
    const weekdayMap = { '周日': 0, '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6 };
    const nowWeekday = weekdayMap[weekdayStr] ?? 0;

    return (
      matchCronPart(minute, nowMinute, 0, 59) &&
      matchCronPart(hour, nowHour, 0, 23) &&
      matchCronPart(day, nowDay, 1, 31) &&
      matchCronPart(month, nowMonth, 1, 12) &&
      matchCronPart(weekday, nowWeekday, 0, 6)
    );
  } catch (e) {
    console.error('Cron parse error:', e);
    return false;
  }
}

/**
 * 匹配 cron 表达式的单个部分
 * 支持: *, 星号/n, n-m, n-m/s, n,m,o, 单个数字
 */
function matchCronPart(pattern, value, min, max) {
  // * 匹配所有
  if (pattern === '*') return true;

  // */n 步长 (从0开始)
  if (pattern.startsWith('*/')) {
    const step = parseInt(pattern.substring(2));
    return value % step === 0;
  }

  // n-m/s 范围+步长 (如 0-50/10)
  if (pattern.includes('-') && pattern.includes('/')) {
    const [rangePart, stepPart] = pattern.split('/');
    const [start, end] = rangePart.split('-').map(Number);
    const step = parseInt(stepPart);
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
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
export async function fetchAllDueFeeds(env, addLog = null) {
  try {
    const now = new Date();
    const { results: feeds } = await env.DB.prepare(`
      SELECT * FROM rss_feeds WHERE is_active = 1
    `).all();

    let fetchedCount = 0;
    const results = [];

    for (const feed of feeds || []) {
      // 检查 cron 表达式是否匹配
      if (!shouldRunCron(feed.cron_expression, now)) {
        continue;
      }

      // 检查距离上次拉取是否已经超过4分钟（避免同一周期内重复拉取）
      if (feed.last_fetch_at) {
        const lastFetch = new Date(feed.last_fetch_at);
        const minutesSinceLastFetch = (now - lastFetch) / 1000 / 60;
        if (minutesSinceLastFetch < 4) {
          console.log(`Skip ${feed.name}: last fetch was ${minutesSinceLastFetch.toFixed(1)} minutes ago`);
          continue;
        }
      }

      console.log(`Fetching ${feed.name} (cron: ${feed.cron_expression})`);
      const result = await fetchRssArticles(feed, env, addLog, 'cron-auto');
      results.push({ feed: feed.name, ...result });
      if (result.success) fetchedCount++;
    }

    return { total: feeds?.length || 0, fetched: fetchedCount, results };
  } catch (error) {
    console.error('Fetch all feeds error:', error);
    return { error: error.message };
  }
}

/**
 * 手动触发拉取（不检查 cron，用于页面打开时刷新）
 */
export async function fetchAllFeedsManual(env, addLog = null) {
  try {
    const now = new Date();
    const { results: feeds } = await env.DB.prepare(`
      SELECT * FROM rss_feeds WHERE is_active = 1
    `).all();

    let fetchedCount = 0;
    const results = [];

    for (const feed of feeds || []) {
      // 检查距离上次拉取是否已经超过2分钟
      if (feed.last_fetch_at) {
        const lastFetch = new Date(feed.last_fetch_at);
        const minutesSinceLastFetch = (now - lastFetch) / 1000 / 60;
        if (minutesSinceLastFetch < 2) {
          console.log(`Skip ${feed.name}: last fetch was ${minutesSinceLastFetch.toFixed(1)} minutes ago`);
          continue;
        }
      }

      console.log(`Manual fetching ${feed.name}`);
      const result = await fetchRssArticles(feed, env, addLog, 'page-refresh');
      results.push({ feed: feed.name, ...result });
      if (result.success) fetchedCount++;
    }

    return { total: feeds?.length || 0, fetched: fetchedCount, results };
  } catch (error) {
    console.error('Manual fetch error:', error);
    return { error: error.message };
  }
}

/**
 * 清理一周前的 RSS 文章
 */
export async function cleanOldArticles(env) {
  try {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const cutoffDate = oneWeekAgo.toISOString();

    const result = await env.DB.prepare(`
      DELETE FROM rss_articles
      WHERE published_at < ? AND is_deleted = 0
    `).bind(cutoffDate).run();

    console.log(`Cleaned ${result.meta.changes} old articles`);
    return { success: true, deleted: result.meta.changes };
  } catch (error) {
    console.error('Clean old articles error:', error);
    return { success: false, error: error.message };
  }
}
