// ============ RSS 订阅功能 ============

// RSS 订阅管理页面
async function handleFeedsPage(request, env) {
  const { results: feeds } = await env.DB.prepare(`
    SELECT * FROM rss_feeds ORDER BY created_at DESC
  `).all();

  const html = renderKoobaiPage({
    page: 'feeds',
    content: renderFeedsManagement(feeds || [])
  });

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 获取订阅源列表
async function handleGetFeeds(request, env) {
  const { results } = await env.DB.prepare(`
    SELECT f.*, COUNT(a.id) as article_count,
           SUM(CASE WHEN a.is_read = 0 THEN 1 ELSE 0 END) as unread_count
    FROM rss_feeds f
    LEFT JOIN rss_articles a ON f.id = a.feed_id AND a.is_deleted = 0
    GROUP BY f.id
    ORDER BY f.created_at DESC
  `).all();

  return new Response(JSON.stringify({ success: true, feeds: results || [] }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 添加订阅源
async function handleAddFeed(request, env) {
  try {
    const data = await request.json();
    const { name, url, category = 'tech', cron_expression = '0 * * * *' } = data;

    if (!name || !url) {
      return new Response(JSON.stringify({ success: false, error: '名称和URL不能为空' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 验证 URL
    try {
      new URL(url);
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: '无效的 URL' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // 插入订阅源
    const result = await env.DB.prepare(`
      INSERT INTO rss_feeds (name, url, category, cron_expression)
      VALUES (?, ?, ?, ?)
    `).bind(name, url, category, cron_expression).run();

    const feedId = result.meta.last_row_id;

    // 立即抓取一次
    const feed = { id: feedId, url, name };
    const fetchResult = await fetchRssArticles(feed, env);

    return new Response(JSON.stringify({
      success: true,
      feed_id: feedId,
      fetch_result: fetchResult
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 更新订阅源
async function handleUpdateFeed(request, feedId, env) {
  try {
    const data = await request.json();
    const { name, url, category, cron_expression, is_active } = data;

    let setClauses = [];
    let params = [];

    if (name !== undefined) { setClauses.push('name = ?'); params.push(name); }
    if (url !== undefined) { setClauses.push('url = ?'); params.push(url); }
    if (category !== undefined) { setClauses.push('category = ?'); params.push(category); }
    if (cron_expression !== undefined) { setClauses.push('cron_expression = ?'); params.push(cron_expression); }
    if (is_active !== undefined) { setClauses.push('is_active = ?'); params.push(is_active ? 1 : 0); }

    setClauses.push('updated_at = datetime("now")');
    params.push(feedId);

    await env.DB.prepare(`
      UPDATE rss_feeds SET ${setClauses.join(', ')} WHERE id = ?
    `).bind(...params).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 删除订阅源
async function handleDeleteFeed(request, feedId, env) {
  try {
    // 删除文章
    await env.DB.prepare('DELETE FROM rss_articles WHERE feed_id = ?').bind(feedId).run();
    // 删除订阅源
    await env.DB.prepare('DELETE FROM rss_feeds WHERE id = ?').bind(feedId).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 手动抓取订阅源
async function handleFetchFeed(request, feedId, env) {
  try {
    const feed = await env.DB.prepare('SELECT * FROM rss_feeds WHERE id = ?').bind(feedId).first();
    if (!feed) {
      return new Response(JSON.stringify({ success: false, error: '订阅源不存在' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    const result = await fetchRssArticles(feed, env);
    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 获取RSS文章列表
async function handleGetArticles(request, env) {
  const url = new URL(request.url);
  const feedId = url.searchParams.get('feed_id');
  const limit = parseInt(url.searchParams.get('limit') || '50');

  let query = `
    SELECT a.*, f.name as feed_name, f.category
    FROM rss_articles a
    JOIN rss_feeds f ON a.feed_id = f.id
    WHERE a.is_deleted = 0
  `;
  const params = [];

  if (feedId) {
    query += ' AND a.feed_id = ?';
    params.push(feedId);
  }

  query += ' ORDER BY a.published_at DESC LIMIT ?';
  params.push(limit);

  const { results } = await env.DB.prepare(query).bind(...params).all();

  return new Response(JSON.stringify({ success: true, articles: results || [] }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 查看RSS文章详情
async function handleArticleView(request, articleId, env) {
  const article = await env.DB.prepare(`
    SELECT a.*, f.name as feed_name, f.url as feed_url
    FROM rss_articles a
    JOIN rss_feeds f ON a.feed_id = f.id
    WHERE a.id = ? AND a.is_deleted = 0
  `).bind(articleId).first();

  if (!article) {
    return new Response(renderKoobaiPage({
      page: 'view',
      content: '<div class="empty">文章不存在</div>'
    }), { status: 404 });
  }

  // 标记为已读
  await env.DB.prepare('UPDATE rss_articles SET is_read = 1 WHERE id = ?').bind(articleId).run();

  const html = renderKoobaiPage({
    page: 'view',
    emailId: articleId,
    content: renderArticleDetail(article)
  });

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 标记文章已读
async function handleMarkArticlesRead(request, env) {
  const data = await request.json();
  try {
    if (data.ids) {
      const ids = data.ids.map(id => parseInt(id)).filter(id => !isNaN(id));
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE rss_articles SET is_read = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
      }
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

// 合并内容（邮件 + RSS）
async function handleUnifiedContent(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'all';
  const search = url.searchParams.get('search') || '';

  let items = [];

  // 获取邮件
  if (type === 'all' || type === 'email') {
    const { results: emails } = await env.DB.prepare(`
      SELECT id, subject as title, sender, content_text, date_sent as date, 'email' as type
      FROM emails WHERE is_deleted = 0
      ORDER BY date_sent DESC LIMIT 50
    `).all();
    items.push(...(emails || []).map(e => ({
      ...e,
      source: e.sender,
      url: `/view/${e.id}`
    })));
  }

  // 获取 RSS 文章
  if (type === 'all' || type === 'rss') {
    const { results: articles } = await env.DB.prepare(`
      SELECT a.id, a.title, a.link, a.description as content_text,
             a.published_at as date, 'rss' as type, f.name as feed_name
      FROM rss_articles a
      JOIN rss_feeds f ON a.feed_id = f.id
      WHERE a.is_deleted = 0
      ORDER BY a.published_at DESC LIMIT 50
    `).all();
    items.push(...(articles || []).map(a => ({
      ...a,
      source: a.feed_name,
      url: `/article/${a.id}`
    })));
  }

  // 搜索过滤
  if (search) {
    items = items.filter(item =>
      item.title?.toLowerCase().includes(search.toLowerCase()) ||
      item.content_text?.toLowerCase().includes(search.toLowerCase())
    );
  }

  // 按日期排序
  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  return new Response(JSON.stringify({ success: true, items: items.slice(0, 100) }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
