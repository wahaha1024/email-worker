// src/index.js - 邮件管理系统 - Koobai 风格 + 完整功能 + RSS 订阅
import PostalMime from 'postal-mime';
import { parseRssFeed, fetchRssArticles, fetchAllDueFeeds, fetchAllFeedsManual, cleanOldArticles, shouldRunCron } from './rss-utils.js';

// 内存日志缓冲区（用于快速查看）
let operationLogs = [];
const MAX_LOGS = 200;

// 添加日志（同时写入数据库）
async function addLog(env, type, action, details = {}) {
  const log = {
    id: Date.now() + Math.random().toString(36).substr(2, 9),
    timestamp: new Date().toISOString(),
    type,
    action,
    details: JSON.stringify(details)
  };

  // 添加到内存缓冲区
  operationLogs.unshift(log);
  if (operationLogs.length > MAX_LOGS) operationLogs = operationLogs.slice(0, MAX_LOGS);

  // 写入数据库
  try {
    if (env.DB) {
      await env.DB.prepare(`
        INSERT INTO email_logs (message_id, subject, sender, recipient, status, error_message, raw_size, parsed_success, db_insert_success, processing_time_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        details.message_id || log.id,
        details.subject || action,
        details.sender || '',
        details.recipient || '',
        type,
        details.error || null,
        details.raw_size || 0,
        details.parsed_success ? 1 : 0,
        details.db_insert_success ? 1 : 0,
        details.processing_time_ms || 0
      ).run();
    }
  } catch (e) {
    console.log('Log table write failed:', e.message);
  }
}

// 获取邮件处理日志（从数据库）
async function getLogs(env, limit = 50) {
  try {
    if (env.DB) {
      const { results } = await env.DB.prepare(`
        SELECT * FROM email_logs 
        WHERE status IN ('processing', 'success', 'failed', 'duplicate')
        ORDER BY received_at DESC 
        LIMIT ?
      `).bind(limit).all();
      
      return (results || []).map(row => ({
        id: row.id,
        timestamp: row.received_at || row.created_at,
        type: row.status || 'info',
        action: row.subject || '(无主题)',
        sender: row.sender || '',
        recipient: row.recipient || '',
        error: row.error_message || null,
        processing_time: row.processing_time_ms || 0,
        raw_size: row.raw_size || 0,
        parsed_success: row.parsed_success === 1,
        db_insert_success: row.db_insert_success === 1
      }));
    }
  } catch (e) {
    console.log('Using memory logs:', e.message);
  }
  return operationLogs.slice(0, limit);
}

export default {
  // 处理接收到的邮件 - 使用 postal-mime 完整解析
  async email(message, env, ctx) {
    const startTime = Date.now();
    const processingErrors = [];
    let logId = null;

    const recipient = message?.to || "unknown";
    const sender = message?.from || "unknown";
    let subject = "无标题";
    let rawSize = 0;
    let rawBuffer = null;

    try {
      if (message?.headers && typeof message.headers.get === 'function') {
        subject = message.headers.get('subject') || "无标题";
      }
    } catch (e) {
      processingErrors.push(`Headers error: ${e.message}`);
    }

    console.log("========== EMAIL RECEIVED ==========");
    console.log("To:", recipient);
    console.log("From:", sender);
    console.log("Subject:", subject);

    // 步骤1: 转换原始数据为 Buffer
    try {
      if (!message?.raw) {
        throw new Error("message.raw is undefined");
      }

      const rawType = typeof message.raw;
      const rawConstructor = message.raw?.constructor?.name;

      if (rawType === 'string') {
        rawBuffer = new TextEncoder().encode(message.raw);
        rawSize = rawBuffer.length;
      }
      else if (message.raw instanceof ReadableStream) {
        const reader = message.raw.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const totalLength = chunks.reduce((sum, chunk) => sum + (chunk.length || chunk.byteLength || 0), 0);
        rawBuffer = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          const chunkArray = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          rawBuffer.set(chunkArray, offset);
          offset += chunkArray.length;
        }
        rawSize = totalLength;
      }
      else if (message.raw instanceof ArrayBuffer) {
        rawBuffer = new Uint8Array(message.raw);
        rawSize = message.raw.byteLength;
      }
      else if (message.raw instanceof Uint8Array) {
        rawBuffer = message.raw;
        rawSize = rawBuffer.length;
      }
      else if (message.raw?.buffer instanceof ArrayBuffer) {
        rawBuffer = new Uint8Array(message.raw.buffer);
        rawSize = message.raw.buffer.byteLength;
      }
      else if (rawConstructor === 'Blob' && typeof message.raw.arrayBuffer === 'function') {
        const arrayBuffer = await message.raw.arrayBuffer();
        rawBuffer = new Uint8Array(arrayBuffer);
        rawSize = arrayBuffer.byteLength;
      }
      else {
        const str = JSON.stringify(message.raw);
        rawBuffer = new TextEncoder().encode(str);
        rawSize = rawBuffer.length;
      }
    } catch (e) {
      processingErrors.push(`Raw data conversion error: ${e.message}`);
      console.error("Failed to convert raw data:", e);
    }

    // 创建日志记录
    try {
      const logResult = await env.DB.prepare(`
        INSERT INTO email_logs (message_id, subject, sender, recipient, raw_size, status, received_at)
        VALUES (?, ?, ?, ?, ?, 'processing', datetime('now'))
      `).bind(`pending_${Date.now()}`, subject, sender, recipient, rawSize).run();
      logId = logResult.meta?.last_row_id;
    } catch (logError) {
      console.error("Failed to create log entry:", logError);
    }

    // 步骤2: 解析邮件内容
    let emailData = null;
    try {
      if (!rawBuffer) {
        throw new Error("No raw buffer available for parsing");
      }

      const parser = new PostalMime();
      emailData = await parser.parse(rawBuffer.buffer);
      console.log("Email parsed successfully");
      
      // 更新日志：解析成功
      if (logId) {
        await env.DB.prepare(`
          UPDATE email_logs SET parsed_success = 1 WHERE id = ?
        `).bind(logId).run();
      }
    } catch (e) {
      processingErrors.push(`Parse error: ${e.message}`);
      console.error("Email parse failed:", e);
    }

    // 步骤3: 提取邮件字段
    let messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    let fromAddress = sender;
    let fromName = "";
    let replyTo = fromAddress;
    let ccAddresses = "";
    let dateSent = new Date().toISOString();
    let contentHtml = "";
    let contentText = "";

    if (emailData) {
      try {
        messageId = emailData.messageId || messageId;
        fromAddress = emailData.from?.address || sender;
        fromName = emailData.from?.name || "";
        replyTo = emailData.replyTo?.address || fromAddress;
        ccAddresses = Array.isArray(emailData.cc) 
          ? emailData.cc.map(c => c?.address || '').filter(Boolean).join(', ')
          : "";

        if (emailData.date) {
          try {
            const dateObj = new Date(emailData.date);
            if (!isNaN(dateObj.getTime())) {
              dateSent = dateObj.toISOString();
            }
          } catch (e) {
            processingErrors.push(`Date parse error: ${e.message}`);
          }
        }

        contentHtml = emailData.html || "";
        contentText = emailData.text || "无正文内容";
      } catch (extractError) {
        processingErrors.push(`Field extraction error: ${extractError.message}`);
      }
    }

    // 步骤4: 检查重复并存入数据库
    try {
      if (!env.DB) {
        throw new Error("Database binding (env.DB) is not available");
      }

      const existing = await env.DB.prepare(
        "SELECT id FROM emails WHERE message_id = ?"
      ).bind(messageId).first();

      // 转换 raw buffer 为字符串
      let rawBodyString = "";
      try {
        rawBodyString = rawBuffer ? new TextDecoder('utf-8', { fatal: false }).decode(rawBuffer) : "";
      } catch (e) {
        console.warn("Failed to decode raw buffer:", e);
      }

      // 截断过长的字段
      const maxLength = 500000;
      const truncatedHtml = contentHtml.length > maxLength ? contentHtml.substring(0, maxLength) + "..." : contentHtml;
      const truncatedText = contentText.length > maxLength ? contentText.substring(0, maxLength) + "..." : contentText;
      const truncatedRaw = rawBodyString.length > maxLength ? rawBodyString.substring(0, maxLength) + "..." : rawBodyString;

      if (existing) {
        // 更新现有邮件
        await env.DB.prepare(`
          UPDATE emails SET
            content_html = ?, content_text = ?, raw_body = ?,
            updated_at = datetime('now')
          WHERE message_id = ?
        `).bind(truncatedHtml, truncatedText, truncatedRaw, messageId).run();

        if (logId) {
          await env.DB.prepare(`
            UPDATE email_logs SET 
              status = 'duplicate', db_insert_success = 1, processing_time_ms = ?
            WHERE id = ?
          `).bind(Date.now() - startTime, logId).run();
        }

        console.log(`邮件已更新: ${subject}`);
      } else {
        // 插入新邮件
        const result = await env.DB.prepare(`
          INSERT INTO emails (
            message_id, subject, sender, sender_name, content_html, content_text,
            raw_body, reply_to, cc, date_sent, date_received, category, priority, tags
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'inbox', 0, '[]')
        `).bind(
          messageId, subject, fromAddress, fromName, truncatedHtml, truncatedText,
          truncatedRaw, replyTo, ccAddresses, dateSent
        ).run();

        if (logId) {
          const errorInfo = processingErrors.length > 0 ? processingErrors.join('; ') : null;
          await env.DB.prepare(`
            UPDATE email_logs SET 
              status = 'success', db_insert_success = 1, processing_time_ms = ?, error_message = ?
            WHERE id = ?
          `).bind(Date.now() - startTime, errorInfo, logId).run();
        }

        console.log(`邮件已保存: ${subject}`);
      }
    } catch (dbError) {
      const processingTime = Date.now() - startTime;
      processingErrors.push(`Database error: ${dbError.message}`);
      console.error("Database operation failed:", dbError);

      if (logId) {
        try {
          await env.DB.prepare(`
            UPDATE email_logs SET 
              status = 'failed', error_message = ?, processing_time_ms = ?
            WHERE id = ?
          `).bind(processingErrors.join('; '), processingTime, logId).run();
        } catch (e) {
          console.error("Failed to update error log:", e);
        }
      }
    }

    console.log("========== EMAIL HANDLER END ==========");
    return new Response('OK');
  },

  // HTTP 访问
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error('Request error:', error);
      return new Response(renderErrorPage(error.message), { status: 500 });
    }
  },

  // 定时任务：抓取 RSS 订阅
  async scheduled(event, env, ctx) {
    console.log('Cron triggered at:', new Date().toISOString());
    try {
      // 拉取 RSS 订阅
      const result = await fetchAllDueFeeds(env, addLog);
      console.log('RSS fetch result:', result);

      // 每天清理一次旧文章（保留一周）
      const now = new Date();
      if (now.getHours() === 3 && now.getMinutes() < 5) {
        const cleanResult = await cleanOldArticles(env);
        console.log('Clean old articles result:', cleanResult);
      }
    } catch (error) {
      console.error('Cron error:', error);
    }
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 邮件接收端点
  if (path === '/api/receive' && request.method === 'POST') {
    return handleReceiveEmail(request, env);
  }

  // 分类筛选
  const category = url.searchParams.get('category');
  const isRead = url.searchParams.get('is_read');
  const search = url.searchParams.get('search') || url.searchParams.get('q') || '';

  if (path === '/' || path.startsWith('/?')) return handleHomePage(request, env, { category, isRead, search });
  if (path.startsWith('/view/')) return handleEmailView(request, path.split('/')[2], env);

  // RSS 订阅管理
  if (path === '/feeds') return handleFeedsPage(request, env);
  if (path === '/api/feeds' && request.method === 'GET') return handleGetFeeds(request, env);
  if (path === '/api/feeds' && request.method === 'POST') return handleAddFeed(request, env);
  if (path.match(/^\/api\/feeds\/\d+$/) && request.method === 'PUT') return handleUpdateFeed(request, path.split('/')[3], env);
  if (path.match(/^\/api\/feeds\/\d+$/) && request.method === 'DELETE') return handleDeleteFeed(request, path.split('/')[3], env);
  if (path.match(/^\/api\/feeds\/\d+\/fetch$/)) return handleFetchFeed(request, path.split('/')[3], env);

  // RSS 文章
  if (path === '/api/articles') return handleGetArticles(request, env);
  if (path.startsWith('/article/')) return handleArticleView(request, path.split('/')[2], env);
  if (path === '/api/articles/mark-read') return handleMarkArticlesRead(request, env);
  if (path === '/api/articles/delete') return handleDeleteArticles(request, env);

  // 合并视图
  if (path === '/api/unified') return handleUnifiedContent(request, env);
  if (path === '/api/rss/refresh' && request.method === 'POST') return handleRssRefresh(request, env);

  if (path === '/api/emails') return handleApiEmails(request, env);
  if (path === '/api/mark-read') return handleMarkRead(request, env);
  if (path === '/api/delete') return handleDeleteEmail(request, env);
  if (path === '/api/forward') return handleForwardEmail(request, env);
  if (path === '/rss') return handleRssFeed(request, env);
  if (path === '/logs') return handleLogsPage(request, env);
  if (path === '/api/clear-logs') return handleClearLogs(request, env);
  if (path === '/api/debug') return handleDebug(request, env);
  if (path === '/api/stats') return handleStats(request, env);
  if (path.startsWith('/api/logs/')) return handleLogDetail(request, path.split('/')[3], env);
  if (path === '/diagnostics') return handleDiagnosticsPage(request, env);
  if (path === '/live') return handleLivePage(request, env);
  if (path === '/api/live-config' && request.method === 'GET') return handleGetLiveConfig(request, env);
  if (path === '/api/live-config' && request.method === 'POST') return handleSaveLiveConfig(request, env);

  return new Response('Not Found', { status: 404 });
}

// 处理传统的表单接收（兼容 Cloudflare Email Routing HTTP 回调）
async function handleReceiveEmail(request, env) {
  try {
    const formData = await request.formData();
    const from = formData.get('from') || '';
    const to = formData.get('to') || '';
    const subject = formData.get('subject') || '(无主题)';
    const text = formData.get('text') || '';
    const html = formData.get('html') || '';
    const headers = formData.get('headers') || '';

    const senderMatch = from.match(/(.*)<(.*)>/);
    const senderName = senderMatch ? senderMatch[1].trim() : '';
    const senderEmail = senderMatch ? senderMatch[2].trim() : from;

    const messageId = headers.match(/Message-ID:\s*<([^>]+)>/)?.[1] ||
      `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // HTTP 回调方式接收邮件，直接处理（日志由主邮件处理器统一记录）

    const existing = await env.DB.prepare('SELECT id FROM emails WHERE message_id = ?').bind(messageId).first();
    if (existing) {
      // 重复邮件更新
      await env.DB.prepare(`
        UPDATE emails SET content_text = ?, content_html = ?, updated_at = datetime('now')
        WHERE message_id = ?
      `).bind(text, html, messageId).run();
      return new Response(JSON.stringify({ success: true, duplicate: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await env.DB.prepare(`
      INSERT INTO emails (message_id, subject, sender, sender_name, content_text, content_html, date_sent, date_received, category, priority, tags)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'inbox', 0, '[]')
    `).bind(messageId, subject, senderEmail, senderName, text, html).run();

    return new Response(JSON.stringify({ success: true, subject }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleHomePage(request, env, filters = {}) {
  const { category, isRead, search } = filters;
  const url = new URL(request.url);
  const contentType = url.searchParams.get('type') || 'all'; // all, email, rss

  let items = [];

  // 获取邮件
  if (contentType === 'all' || contentType === 'email') {
    const emails = await getEmails(search, { category, isRead }, env);
    items.push(...emails.map(e => ({
      id: e.id,
      type: 'email',
      title: e.subject,
      content: e.content_text,
      date: e.date_sent,
      source: e.sender_name || e.sender,
      url: `/view/${e.id}`,
      is_read: e.is_read
    })));
  }

  // 获取 RSS 文章
  if (contentType === 'all' || contentType === 'rss') {
    try {
      const { results: articles } = await env.DB.prepare(`
        SELECT a.id, a.title, a.description, a.published_at, a.is_read,
               f.name as feed_name
        FROM rss_articles a
        JOIN rss_feeds f ON a.feed_id = f.id
        WHERE a.is_deleted = 0
        ORDER BY a.published_at DESC
        LIMIT 50
      `).all();

      items.push(...(articles || []).map(a => ({
        id: a.id,
        type: 'rss',
        title: a.title,
        content: a.description,
        date: a.published_at,
        source: a.feed_name,
        url: `/article/${a.id}`,
        is_read: a.is_read
      })));
    } catch (e) {
      console.error('RSS fetch error:', e);
    }
  }

  // 按日期排序
  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  const html = renderKoobaiPage({
    page: 'inbox',
    content: renderUnifiedList(items, { contentType, category, isRead, search })
  });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleEmailView(request, emailId, env) {
  const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ? AND is_deleted = 0').bind(emailId).first();
  if (!email) return new Response(renderKoobaiPage({ page: 'view', content: '<div class="empty">邮件不存在</div>' }), { status: 404 });
  
  await env.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').bind(emailId).run();
  // 不记录查看日志，只保留邮件接收处理日志
  
  const html = renderKoobaiPage({ page: 'view', emailId, content: renderEmailDetail(email) });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleLogsPage(request, env) {
  // 获取日志和统计数据（查询更多记录以确保显示完整）
  const logs = await getLogs(env, 200);

  // 获取统计信息
  let stats = { total: 0, success: 0, failed: 0, duplicate: 0, processing: 0 };
  try {
    const { results } = await env.DB.prepare(`
      SELECT status, COUNT(*) as count
      FROM email_logs
      WHERE status IN ('success', 'failed', 'duplicate', 'processing')
      GROUP BY status
    `).all();

    results?.forEach(row => {
      stats[row.status] = row.count;
      stats.total += row.count;
    });
  } catch (e) {
    console.log('Stats query failed:', e.message);
  }

  const html = renderKoobaiPage({
    page: 'logs',
    content: renderLogsContent(logs, stats)
  });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleStats(request, env) {
  try {
    const stats = await env.DB.prepare(`
      SELECT 
        status,
        COUNT(*) as count,
        ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM email_logs), 2) as percentage
      FROM email_logs 
      GROUP BY status
    `).all();
    
    return new Response(JSON.stringify({ success: true, stats: stats.results }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleDiagnosticsPage(request, env) {
  // 获取诊断数据
  const diagnostics = {
    timestamp: new Date().toISOString(),
    tables: [],
    emails: { total: 0, unread: 0, today: 0 },
    recentLogs: [],
    recentFailures: []
  };

  try {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    diagnostics.tables = results ? results.map(r => r.name) : [];
  } catch (e) {}

  try {
    const { results } = await env.DB.prepare('SELECT COUNT(*) as count FROM emails').all();
    diagnostics.emails.total = results ? results[0].count : 0;
  } catch (e) {}

  try {
    const { results } = await env.DB.prepare('SELECT COUNT(*) as count FROM emails WHERE is_read = 0 AND is_deleted = 0').all();
    diagnostics.emails.unread = results ? results[0].count : 0;
  } catch (e) {}

  try {
    const { results } = await env.DB.prepare(`
      SELECT received_at, sender, subject, status, error_message, processing_time_ms
      FROM email_logs 
      WHERE status IN ('processing', 'success', 'failed', 'duplicate')
      ORDER BY received_at DESC 
      LIMIT 20
    `).all();
    diagnostics.recentLogs = results || [];
  } catch (e) {}

  try {
    const { results } = await env.DB.prepare(`
      SELECT received_at, sender, subject, status, error_message 
      FROM email_logs 
      WHERE status IN ('failed', 'processing')
      ORDER BY received_at DESC 
      LIMIT 10
    `).all();
    diagnostics.recentFailures = results || [];
  } catch (e) {}

  const content = renderDiagnosticsContent(diagnostics);
  const html = renderKoobaiPage({ page: 'diagnostics', content });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 获取实时面板配置
async function handleGetLiveConfig(request, env) {
  // 默认配置
  const defaultConfig = {
    panel_1: {
      title: '市场行情',
      url: 'https://m.123.com.cn/wap2/market_live',
      autoRefresh: false,
      interval: 60,
      x: 0, y: 0, width: 48, height: 100
    },
    panel_2: {
      title: '财联社快讯',
      url: 'https://api3.cls.cn/share/subject/1103?sv=859&os=web',
      autoRefresh: false,
      interval: 60,
      x: 50, y: 0, width: 48, height: 100
    }
  };

  try {
    // 尝试从数据库获取配置
    const result = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'live_panel_config'"
    ).first();

    if (result && result.value) {
      return new Response(result.value, {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (e) {
    // 数据库错误（如表不存在），忽略并使用默认配置
    console.log('DB error in handleGetLiveConfig, using default config:', e.message);
  }

  // 返回默认配置
  return new Response(JSON.stringify(defaultConfig), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 保存实时面板配置
async function handleSaveLiveConfig(request, env) {
  try {
    const config = await request.json();
    const configStr = JSON.stringify(config);

    // 确保settings表存在
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // 插入或更新配置
    await env.DB.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES ('live_panel_config', ?, datetime('now'))
    `).bind(configStr).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 实时行情页面 - 嵌入外部市场数据
async function handleLivePage(request, env) {
  const content = `
    <div class="live-container" id="liveContainer">
      <!-- 窗口由JavaScript动态生成 -->
    </div>

    <!-- 添加窗口按钮 -->
    <button class="add-panel-btn" onclick="addNewPanel()" title="添加窗口">
      <span data-lucide="plus"></span>
    </button>

    <!-- 设置弹窗 -->
    <div class="settings-modal" id="settingsModal">
      <div class="settings-content">
        <div class="settings-header">
          <h3>面板设置</h3>
          <button class="settings-close" onclick="closeSettings()">
            <span data-lucide="x"></span>
          </button>
        </div>
        <div class="settings-body">
          <div class="settings-field">
            <label>标题名称</label>
            <input type="text" id="settingTitle" placeholder="输入标题">
          </div>
          <div class="settings-field">
            <label>页面URL</label>
            <input type="url" id="settingUrl" placeholder="https://...">
          </div>
          <div class="settings-field">
            <label>移动端模式</label>
            <div class="settings-row">
              <label class="toggle">
                <input type="checkbox" id="settingMobileMode" checked>
                <span class="toggle-slider"></span>
              </label>
              <span class="toggle-desc">模拟移动设备访问（显示手机版网站）</span>
            </div>
          </div>
          <div class="settings-field">
            <label>自动刷新</label>
            <div class="settings-row">
              <label class="toggle">
                <input type="checkbox" id="settingAutoRefresh">
                <span class="toggle-slider"></span>
              </label>
              <input type="number" id="settingInterval" min="5" max="3600" value="60" class="interval-input">
              <span class="interval-unit">秒</span>
            </div>
          </div>
        </div>
        <div class="settings-footer">
          <button class="settings-btn delete" id="deleteBtn" onclick="deletePanel()">删除窗口</button>
          <button class="settings-btn cancel" onclick="closeSettings()">取消</button>
          <button class="settings-btn save" onclick="saveSettings()">保存</button>
        </div>
      </div>
    </div>

    <style>
      /* 扩展容器宽度 */
      body.live-page .main {
        max-width: 100%;
        padding: 20px 40px 10px;
      }
      body.live-page {
        padding-bottom: 0;
      }
      .live-container {
        position: relative;
        width: 100%;
        height: calc(100vh - 80px);
        padding: 0;
      }
      .live-panel {
        position: absolute;
        display: flex;
        flex-direction: column;
        background: var(--bg-card);
        border-radius: var(--radius);
        overflow: hidden;
        box-shadow: 0 2px 8px rgba(0,0,0,0.04);
        border: 1px solid var(--border);
        min-width: 200px;
        min-height: 150px;
      }
      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px;
        background: var(--accent-light);
        border-bottom: 1px solid var(--border);
        transition: all 0.3s ease;
      }
      .panel-header.drag-handle {
        cursor: move;
      }
      /* 标题栏隐藏状态 */
      .live-panel.header-hidden .panel-header {
        transform: translateY(-100%);
        opacity: 0;
        pointer-events: none;
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 5;
      }
      .live-panel.header-hidden .panel-frame {
        margin-top: 0;
      }
      /* 显示标题栏的悬浮按钮 */
      .panel-show-header {
        position: absolute;
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        width: 36px;
        height: 20px;
        border: none;
        background: rgba(180, 167, 214, 0.9);
        border-radius: 0 0 10px 10px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        opacity: 0;
        transition: all 0.3s ease;
        z-index: 10;
      }
      .panel-show-header [data-lucide] {
        width: 14px;
        height: 14px;
      }
      .live-panel.header-hidden .panel-show-header {
        opacity: 0.6;
        top: 0;
      }
      .live-panel.header-hidden .panel-show-header:hover {
        opacity: 1;
        height: 24px;
      }
      .panel-title-group {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .panel-icon {
        width: 18px;
        height: 18px;
        color: var(--accent);
      }
      .panel-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
      }
      .panel-actions {
        display: flex;
        gap: 4px;
      }
      .panel-btn {
        width: 32px;
        height: 32px;
        border: none;
        background: transparent;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-secondary);
        transition: all 0.2s;
      }
      .panel-btn:hover {
        background: var(--hover-bg);
        color: var(--accent);
      }
      .panel-btn [data-lucide] {
        width: 16px;
        height: 16px;
      }
      .panel-frame {
        flex: 1;
        overflow: hidden;
        position: relative;
      }
      .mobile-iframe {
        width: 100%;
        height: 100%;
        border: none;
        /* 模拟移动端视口 */
        max-width: 414px;
        margin: 0 auto;
      }
      .desktop-iframe {
        width: 100%;
        height: 100%;
        border: none;
      }
      /* iframe 加载失败提示 */
      .iframe-error {
        display: none;
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--bg-card);
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 16px;
        padding: 24px;
        text-align: center;
      }
      .iframe-error.show {
        display: flex;
      }
      .iframe-error-icon {
        width: 48px;
        height: 48px;
        color: var(--text-muted);
      }
      .iframe-error-title {
        font-size: 16px;
        font-weight: 500;
        color: var(--text);
      }
      .iframe-error-desc {
        font-size: 14px;
        color: var(--text-secondary);
        max-width: 400px;
      }
      .iframe-error-btn {
        padding: 10px 20px;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: 14px;
        transition: all 0.2s;
      }
      .iframe-error-btn:hover {
        background: #9d8fc4;
        transform: translateY(-1px);
      }
      /* 调整大小手柄 */
      .resize-handle {
        position: absolute;
        background: transparent;
        z-index: 10;
      }
      .resize-right {
        right: 0;
        top: 0;
        width: 6px;
        height: 100%;
        cursor: ew-resize;
      }
      .resize-bottom {
        bottom: 0;
        left: 0;
        width: 100%;
        height: 6px;
        cursor: ns-resize;
      }
      .resize-corner {
        right: 0;
        bottom: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
      }
      .resize-corner::after {
        content: '';
        position: absolute;
        right: 3px;
        bottom: 3px;
        width: 8px;
        height: 8px;
        border-right: 2px solid var(--accent);
        border-bottom: 2px solid var(--accent);
        opacity: 0.5;
      }
      .live-panel:hover .resize-corner::after {
        opacity: 1;
      }
      .live-panel.dragging,
      .live-panel.resizing {
        z-index: 100;
        box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      }
      .live-panel.dragging iframe,
      .live-panel.resizing iframe {
        pointer-events: none;
      }
      /* 添加窗口按钮 */
      .add-panel-btn {
        position: fixed;
        right: 30px;
        bottom: 100px;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        border: none;
        background: var(--accent);
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(180, 167, 214, 0.4);
        transition: all 0.2s;
        z-index: 100;
      }
      .add-panel-btn:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 20px rgba(180, 167, 214, 0.5);
      }
      .add-panel-btn [data-lucide] {
        width: 24px;
        height: 24px;
      }
      /* 设置弹窗 */
      .settings-modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.5);
        z-index: 1000;
        align-items: center;
        justify-content: center;
      }
      .settings-modal.open {
        display: flex;
      }
      .settings-content {
        background: var(--bg-card);
        border-radius: var(--radius);
        width: 90%;
        max-width: 400px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      }
      .settings-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border);
      }
      .settings-header h3 {
        font-size: 16px;
        font-weight: 600;
        color: var(--text);
      }
      .settings-close {
        width: 32px;
        height: 32px;
        border: none;
        background: transparent;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-secondary);
      }
      .settings-close:hover {
        background: var(--hover-bg);
      }
      .settings-close [data-lucide] {
        width: 18px;
        height: 18px;
      }
      .settings-body {
        padding: 20px;
      }
      .settings-field {
        margin-bottom: 16px;
      }
      .settings-field:last-child {
        margin-bottom: 0;
      }
      .settings-field label {
        display: block;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
        margin-bottom: 8px;
      }
      .settings-field input[type="text"],
      .settings-field input[type="url"] {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 14px;
        background: var(--bg);
        color: var(--text);
      }
      .settings-field input:focus {
        outline: none;
        border-color: var(--accent);
      }
      .settings-row {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .toggle {
        position: relative;
        width: 44px;
        height: 24px;
        cursor: pointer;
      }
      .toggle input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .toggle-slider {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--border);
        border-radius: 24px;
        transition: 0.3s;
      }
      .toggle-slider:before {
        content: "";
        position: absolute;
        width: 18px;
        height: 18px;
        left: 3px;
        bottom: 3px;
        background: white;
        border-radius: 50%;
        transition: 0.3s;
      }
      .toggle input:checked + .toggle-slider {
        background: var(--accent);
      }
      .toggle input:checked + .toggle-slider:before {
        transform: translateX(20px);
      }
      .interval-input {
        width: 70px;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 14px;
        background: var(--bg);
        color: var(--text);
        text-align: center;
      }
      .interval-unit {
        font-size: 13px;
        color: var(--text-secondary);
      }
      .toggle-desc {
        font-size: 13px;
        color: var(--text-secondary);
        margin-left: 12px;
      }
      .settings-footer {
        display: flex;
        gap: 12px;
        padding: 16px 20px;
        border-top: 1px solid var(--border);
      }
      .settings-btn {
        flex: 1;
        padding: 10px 16px;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }
      .settings-btn.delete {
        background: #ff4757;
        color: white;
        flex: 0 0 auto;
      }
      .settings-btn.delete:hover {
        background: #ff3344;
      }
      .settings-btn.cancel {
        background: var(--bg);
        color: var(--text-secondary);
      }
      .settings-btn.cancel:hover {
        background: var(--hover-bg);
      }
      .settings-btn.save {
        background: var(--accent);
        color: white;
      }
      .settings-btn.save:hover {
        opacity: 0.9;
      }
      /* 实时页面底部导航 - 3秒后变透明 */
      body.live-page .bottom-nav {
        transition: opacity 0.5s ease;
      }
      body.live-page .bottom-nav.faded {
        opacity: 0.15;
      }
      body.live-page .bottom-nav:hover {
        opacity: 1 !important;
      }
      /* 移动端 */
      @media (max-width: 768px) {
        body.live-page .main {
          padding: 16px;
        }
        .live-container {
          flex-direction: column;
          height: auto;
          min-height: calc(100vh - 140px);
        }
        .live-panel {
          min-height: 50vh;
        }
      }
    </style>

    <script>
      // 面板配置 - 动态对象
      let panelConfig = {};

      // 默认配置
      const defaultPanels = {
        panel_1: {
          title: '市场行情',
          url: 'https://m.123.com.cn/wap2/market_live',
          autoRefresh: false,
          interval: 60,
          mobileMode: true,
          x: 0, y: 0, width: 48, height: 100
        },
        panel_2: {
          title: '财联社快讯',
          url: 'https://api3.cls.cn/share/subject/1103?sv=859&os=web',
          autoRefresh: false,
          interval: 60,
          mobileMode: true,
          x: 50, y: 0, width: 48, height: 100
        }
      };

      // 自动刷新定时器
      const refreshTimers = {};

      // 当前编辑的面板
      let currentPanel = null;

      // 拖拽状态
      let dragState = null;

      // 生成唯一ID
      function generateId() {
        return 'panel_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
      }

      // 创建面板DOM
      function createPanelElement(panelId, config) {
        console.log('[Live] createPanelElement called:', panelId, config);
        const div = document.createElement('div');
        div.className = 'live-panel';
        div.dataset.panel = panelId;
        div.id = 'panel-' + panelId;

        // 检测是否是 Telegram 链接
        const isTelegram = config.url.includes('t.me/');
        console.log('[Live] isTelegram:', isTelegram);

        div.innerHTML = \`
          <div class="panel-header drag-handle">
            <div class="panel-title-group">
              <span data-lucide="layout" class="panel-icon"></span>
              <span class="panel-title">\${config.title}</span>
            </div>
            <div class="panel-actions">
              <button class="panel-btn" onclick="goHome('\${panelId}')" title="主页">
                <span data-lucide="home"></span>
              </button>
              <button class="panel-btn" onclick="refreshPanel('\${panelId}')" title="刷新">
                <span data-lucide="refresh-cw"></span>
              </button>
              <button class="panel-btn" onclick="openSettings('\${panelId}')" title="设置">
                <span data-lucide="settings"></span>
              </button>
            </div>
          </div>
          <button class="panel-show-header" onclick="showPanelHeader('\${panelId}')" title="显示工具栏">
            <span data-lucide="chevron-down"></span>
          </button>
          <div class="panel-frame" id="frame-\${panelId}">
            \${isTelegram ? '' : \`<iframe id="iframe-\${panelId}" src="\${config.url}" class="\${config.mobileMode !== false ? 'mobile-iframe' : 'desktop-iframe'}" frameborder="0" allowfullscreen sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe><div class="iframe-error" id="error-\${panelId}"><span data-lucide="alert-circle" class="iframe-error-icon"></span><div class="iframe-error-title">无法加载此页面</div><div class="iframe-error-desc">该网站禁止被嵌入到 iframe 中（X-Frame-Options 限制）</div><button class="iframe-error-btn" onclick="window.open('\${config.url}', '_blank')">在新标签页打开</button></div>\`}
          </div>
          <div class="resize-handle resize-right" data-panel="\${panelId}" data-dir="right"></div>
          <div class="resize-handle resize-bottom" data-panel="\${panelId}" data-dir="bottom"></div>
          <div class="resize-handle resize-corner" data-panel="\${panelId}" data-dir="corner"></div>
        \`;

        div.style.left = config.x + '%';
        div.style.top = config.y + '%';
        div.style.width = config.width + '%';
        div.style.height = config.height + '%';

        // Telegram 处理：有消息ID用Widget，无消息ID用iframe显示频道流
        if (isTelegram) {
          console.log('[Live] Telegram URL detected:', config.url);
          setTimeout(() => {
            const frameDiv = document.getElementById('frame-' + panelId);
            console.log('[Live] Frame div found:', frameDiv);
            if (frameDiv) {
              const telegramMatch = config.url.match(new RegExp('t\\\\.me/s?/([^/]+)(?:/(\\\\d+))?'));
              console.log('[Live] Telegram regex match result:', telegramMatch);
              if (telegramMatch) {
                const channelName = telegramMatch[1];
                const messageId = telegramMatch[2];
                console.log('[Live] Channel:', channelName, 'Message ID:', messageId);

                if (messageId) {
                  // 有消息ID：使用 Widget 显示单条消息
                  const container = document.createElement('div');
                  container.className = 'telegram-widget-container';
                  container.style.cssText = 'width:100%;height:100%;overflow-y:auto;padding:10px;';

                  const script = document.createElement('script');
                  script.async = true;
                  script.src = 'https://telegram.org/js/telegram-widget.js?22';
                  const postAttr = channelName + '/' + messageId;
                  console.log('[Live] Using Widget for single post:', postAttr);
                  script.setAttribute('data-telegram-post', postAttr);
                  script.setAttribute('data-width', '100%');
                  script.setAttribute('data-userpic', 'false');
                  script.setAttribute('data-color', 'b4a7d6');

                  container.appendChild(script);
                  frameDiv.appendChild(container);
                  console.log('[Live] Telegram widget added');
                } else {
                  // 无消息ID：Telegram 禁止 iframe 嵌入，显示提示
                  const channelUrl = 'https://t.me/s/' + channelName;
                  console.log('[Live] Telegram channel (no iframe support):', channelUrl);

                  const notice = document.createElement('div');
                  notice.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px;text-align:center;color:var(--text-secondary);';
                  notice.innerHTML = '<div style="font-size:48px;margin-bottom:20px;">📱</div><div style="font-size:18px;font-weight:600;margin-bottom:12px;color:var(--text);">Telegram 频道</div><div style="font-size:14px;margin-bottom:24px;line-height:1.6;">Telegram 不支持嵌入频道页面<br>请在新标签页中打开查看最新消息</div><button onclick="window.open(\'' + channelUrl + '\', \'_blank\')" style="padding:12px 24px;background:var(--accent);color:white;border:none;border-radius:8px;font-size:14px;cursor:pointer;transition:opacity 0.2s;" onmouseover="this.style.opacity=\'0.8\'" onmouseout="this.style.opacity=\'1\'">在新标签页打开</button>';

                  frameDiv.appendChild(notice);
                  console.log('[Live] Telegram notice added');
                }
              } else {
                console.error('[Live] Telegram URL did not match regex:', config.url);
              }
            } else {
              console.error('[Live] Frame div not found for panel:', panelId);
            }
          }, 100);
        }

        // 2秒后自动隐藏标题栏
        setTimeout(() => {
          div.classList.add('header-hidden');
        }, 2000);

        // 非 Telegram 的 iframe 错误检测（已禁用 - 跨域是正常的）
        if (!isTelegram) {
          // 只监听真正的 error 事件，不检查 contentDocument（会导致跨域误判）
          setTimeout(() => {
            const iframe = document.getElementById('iframe-' + panelId);
            const errorDiv = document.getElementById('error-' + panelId);
            if (iframe && errorDiv) {
              iframe.addEventListener('error', () => {
                console.log('[Live] iframe error event for', panelId);
                errorDiv.classList.add('show');
              });
              // 移除 contentDocument 检查 - 跨域访问会抛出异常但 iframe 实际正常工作
            }
          }, 100);
        }

        return div;
      }

      // 渲染所有面板
      function renderPanels() {
        console.log('[Live] renderPanels called, panelConfig:', panelConfig);
        const container = document.getElementById('liveContainer');
        console.log('[Live] Container element:', container);
        if (!container) {
          console.error('[Live] liveContainer not found!');
          return;
        }
        container.innerHTML = '';
        const panelKeys = Object.keys(panelConfig);
        console.log('[Live] Panel keys to render:', panelKeys);
        panelKeys.forEach(panelId => {
          console.log('[Live] Creating panel:', panelId, panelConfig[panelId]);
          const el = createPanelElement(panelId, panelConfig[panelId]);
          console.log('[Live] Panel element created:', el);
          container.appendChild(el);
          console.log('[Live] Panel appended to container');
        });
        console.log('[Live] All panels rendered, container children:', container.children.length);
        if (typeof lucide !== 'undefined') {
          console.log('[Live] Initializing Lucide icons...');
          lucide.createIcons();
        } else {
          console.warn('[Live] Lucide not available');
        }
        initDragResize();
      }

      // 从服务端加载配置
      async function loadConfig() {
        console.log('[Live] loadConfig started');
        try {
          console.log('[Live] Fetching /api/live-config...');
          const res = await fetch('/api/live-config');
          console.log('[Live] API response status:', res.status, res.ok);
          if (res.ok) {
            const config = await res.json();
            console.log('[Live] Config loaded:', config);
            if (config && Object.keys(config).length > 0) {
              panelConfig = config;
              console.log('[Live] Using loaded config, keys:', Object.keys(panelConfig));
            } else {
              panelConfig = { ...defaultPanels };
              console.log('[Live] Empty config, using defaults');
            }
          } else {
            panelConfig = { ...defaultPanels };
            console.log('[Live] API error, using defaults');
          }
        } catch (e) {
          console.error('[Live] Load config failed:', e);
          panelConfig = { ...defaultPanels };
        }
        console.log('[Live] Final panelConfig:', panelConfig);
        console.log('[Live] Calling renderPanels...');
        renderPanels();
        setupAutoRefresh();
        setupBottomNavFade();
      }

      // 设置底部导航栏3秒后变透明
      function setupBottomNavFade() {
        const bottomNav = document.querySelector('.bottom-nav');
        if (bottomNav) {
          setTimeout(() => {
            bottomNav.classList.add('faded');
          }, 3000);
        }
      }

      // 设置自动刷新
      function setupAutoRefresh() {
        Object.keys(refreshTimers).forEach(id => {
          clearInterval(refreshTimers[id]);
          delete refreshTimers[id];
        });
        Object.keys(panelConfig).forEach(panelId => {
          const config = panelConfig[panelId];
          if (config.autoRefresh && config.interval > 0) {
            refreshTimers[panelId] = setInterval(() => {
              refreshPanel(panelId);
            }, config.interval * 1000);
          }
        });
      }

      // 主页 - 回到初始URL
      function goHome(panelId) {
        const config = panelConfig[panelId];
        if (config) {
          const iframe = document.getElementById('iframe-' + panelId);
          if (iframe) {
            iframe.src = config.url;
          }
        }
      }

      // 显示面板标题栏
      function showPanelHeader(panelId) {
        const panel = document.getElementById('panel-' + panelId);
        if (panel) {
          panel.classList.remove('header-hidden');
          // 2秒后再次隐藏
          setTimeout(() => {
            panel.classList.add('header-hidden');
          }, 2000);
        }
      }

      // 刷新面板
      function refreshPanel(panelId) {
        const iframe = document.getElementById('iframe-' + panelId);
        const btn = document.querySelector('[data-panel="' + panelId + '"] .panel-btn');
        if (btn) {
          btn.classList.add('rotating');
          setTimeout(() => btn.classList.remove('rotating'), 500);
        }
        if (iframe) iframe.src = iframe.src;
      }

      // 打开设置
      function openSettings(panelId) {
        currentPanel = panelId;
        const config = panelConfig[panelId];

        document.getElementById('settingTitle').value = config.title;
        document.getElementById('settingUrl').value = config.url;
        document.getElementById('settingMobileMode').checked = config.mobileMode !== false;
        document.getElementById('settingAutoRefresh').checked = config.autoRefresh;
        document.getElementById('settingInterval').value = config.interval;

        // 显示删除按钮（至少保留一个窗口）
        const deleteBtn = document.getElementById('deleteBtn');
        deleteBtn.style.display = Object.keys(panelConfig).length > 1 ? 'block' : 'none';

        document.getElementById('settingsModal').classList.add('open');
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }

      // 关闭设置
      function closeSettings() {
        document.getElementById('settingsModal').classList.remove('open');
        currentPanel = null;
      }

      // 保存设置
      async function saveSettings() {
        if (!currentPanel) return;

        const oldConfig = panelConfig[currentPanel];
        panelConfig[currentPanel] = {
          ...oldConfig,
          title: document.getElementById('settingTitle').value || oldConfig.title,
          url: document.getElementById('settingUrl').value || oldConfig.url,
          mobileMode: document.getElementById('settingMobileMode').checked,
          autoRefresh: document.getElementById('settingAutoRefresh').checked,
          interval: parseInt(document.getElementById('settingInterval').value) || 60
        };

        await saveConfigToServer();

        // 更新DOM - 需要重新渲染以应用 mobileMode 变化
        renderPanels();

        setupAutoRefresh();
        closeSettings();
      }

      // 删除面板
      async function deletePanel() {
        if (!currentPanel || Object.keys(panelConfig).length <= 1) return;

        if (!confirm('确定要删除这个窗口吗？')) return;

        delete panelConfig[currentPanel];
        await saveConfigToServer();
        renderPanels();
        setupAutoRefresh();
        closeSettings();
      }

      // 添加新面板
      async function addNewPanel() {
        const panelId = generateId();
        const existingCount = Object.keys(panelConfig).length;

        panelConfig[panelId] = {
          title: '新窗口 ' + (existingCount + 1),
          url: 'https://example.com',
          mobileMode: true,
          autoRefresh: false,
          interval: 60,
          x: Math.min(existingCount * 10, 50),
          y: Math.min(existingCount * 10, 50),
          width: 40,
          height: 60
        };

        await saveConfigToServer();
        renderPanels();
        setupAutoRefresh();

        // 打开设置让用户配置
        setTimeout(() => openSettings(panelId), 100);
      }

      // 保存配置到服务端
      async function saveConfigToServer() {
        try {
          const res = await fetch('/api/live-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(panelConfig)
          });
          if (!res.ok) throw new Error('Save failed');
        } catch (e) {
          console.error('Save config failed:', e);
        }
      }

      // 拖拽和调整大小
      function initDragResize() {
        const container = document.getElementById('liveContainer');
        const containerRect = () => container.getBoundingClientRect();

        // 拖拽开始
        document.querySelectorAll('.drag-handle').forEach(handle => {
          handle.onmousedown = (e) => {
            if (e.target.closest('.panel-btn')) return;
            const panel = handle.closest('.live-panel');
            const panelId = panel.dataset.panel;
            const rect = panel.getBoundingClientRect();
            const cRect = containerRect();

            dragState = {
              type: 'drag',
              panel: panelId,
              startX: e.clientX,
              startY: e.clientY,
              startLeft: ((rect.left - cRect.left) / cRect.width) * 100,
              startTop: ((rect.top - cRect.top) / cRect.height) * 100
            };

            panel.classList.add('dragging');
            e.preventDefault();
          };
        });

        // 调整大小开始
        document.querySelectorAll('.resize-handle').forEach(handle => {
          handle.onmousedown = (e) => {
            const panel = handle.closest('.live-panel');
            const panelId = panel.dataset.panel;
            const dir = handle.dataset.dir;
            const rect = panel.getBoundingClientRect();
            const cRect = containerRect();

            dragState = {
              type: 'resize',
              dir: dir,
              panel: panelId,
              startX: e.clientX,
              startY: e.clientY,
              startWidth: (rect.width / cRect.width) * 100,
              startHeight: (rect.height / cRect.height) * 100
            };

            panel.classList.add('resizing');
            e.preventDefault();
          };
        });
      }

      // 全局鼠标事件
      document.addEventListener('mousemove', (e) => {
        if (!dragState) return;

        const container = document.getElementById('liveContainer');
        const cRect = container.getBoundingClientRect();
        const dx = ((e.clientX - dragState.startX) / cRect.width) * 100;
        const dy = ((e.clientY - dragState.startY) / cRect.height) * 100;
        const panel = document.getElementById('panel-' + dragState.panel);
        const config = panelConfig[dragState.panel];

        if (dragState.type === 'drag') {
          const newX = Math.max(0, Math.min(100 - config.width, dragState.startLeft + dx));
          const newY = Math.max(0, Math.min(100 - config.height, dragState.startTop + dy));
          panel.style.left = newX + '%';
          panel.style.top = newY + '%';
          config.x = newX;
          config.y = newY;
        } else if (dragState.type === 'resize') {
          if (dragState.dir === 'right' || dragState.dir === 'corner') {
            const newWidth = Math.max(15, Math.min(100 - config.x, dragState.startWidth + dx));
            panel.style.width = newWidth + '%';
            config.width = newWidth;
          }
          if (dragState.dir === 'bottom' || dragState.dir === 'corner') {
            const newHeight = Math.max(15, Math.min(100 - config.y, dragState.startHeight + dy));
            panel.style.height = newHeight + '%';
            config.height = newHeight;
          }
        }
      });

      document.addEventListener('mouseup', () => {
        if (dragState) {
          const panel = document.getElementById('panel-' + dragState.panel);
          if (panel) panel.classList.remove('dragging', 'resizing');
          saveConfigToServer();
          dragState = null;
        }
      });

      // 添加body类
      document.body.classList.add('live-page');

      // 页面加载时初始化
      loadConfig();

      // 添加旋转动画样式
      const style = document.createElement('style');
      style.textContent = \`
        .panel-btn.rotating [data-lucide] {
          animation: spin 0.5s ease;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      \`;
      document.head.appendChild(style);
    </script>
  `;
  const html = renderKoobaiPage({ page: 'live', content });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleLogDetail(request, logId, env) {
  try {
    const log = await env.DB.prepare('SELECT * FROM email_logs WHERE id = ?').bind(logId).first();
    if (!log) return new Response('日志不存在', { status: 404 });
    
    return new Response(JSON.stringify(log, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

async function handleForwardEmail(request, env) {
  const data = await request.json();
  try {
    const { emailId, toAddress } = data;
    
    // 记录转发历史
    await env.DB.prepare(`
      INSERT INTO forward_history (email_id, to_address, status, forwarded_at)
      VALUES (?, ?, 'success', datetime('now'))
    `).bind(emailId, toAddress).run();
    
    // 更新邮件状态
    await env.DB.prepare(`
      UPDATE emails SET is_forwarded = 1, forwarded_to = ?, forwarded_at = datetime('now')
      WHERE id = ?
    `).bind(toAddress, emailId).run();
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============ Koobai 风格页面 ============

function renderKoobaiPage({ page, emailId, content }) {
  const isInbox = page === 'inbox';
  const isLogs = page === 'logs';
  const isView = page === 'view';
  const isDiagnostics = page === 'diagnostics';

  const isFeeds = page === 'feeds';
  const isLive = page === 'live';

  const navButtons = [
    { id: 'inbox', icon: 'mail', label: '收件箱', href: '/', active: isInbox },
    { id: 'logs', icon: 'activity', label: '日志', href: '/logs', active: isLogs || isDiagnostics, locked: true },
    { id: 'feeds', icon: 'rss', label: '订阅', href: '/feeds', active: isFeeds, locked: true },
    { id: 'live', icon: 'trending-up', label: '实时', href: '/live', active: isLive },
  ];

  const actionButtons = isInbox ? [
    { id: 'filter', icon: 'filter', label: '筛选', onclick: 'toggleFilterMenu()', locked: true },
    { id: 'search', icon: 'search', label: '搜索', onclick: 'toggleSearchBox()', locked: true },
    { id: 'edit', icon: 'pen-square', label: '编辑', onclick: 'toggleEditMenu()', locked: true },
  ] : isView ? [
    { id: 'back', icon: 'arrow-left', label: '返回', onclick: 'history.back()' },
    { id: 'forward', icon: 'forward', label: '转发', onclick: `forwardEmail(${emailId})`, locked: true },
    { id: 'delete', icon: 'trash-2', label: '删除', onclick: `deleteEmail(${emailId})`, locked: true },
  ] : [];

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>MailBox</title>
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<style>
/* ========== Koobai 设计规范 ========== */
:root {
  --bg: #f2f0eb;
  --bg-card: #fffdfa;  /* Koobai 云上舞白 */
  --text: #222222;
  --text-secondary: #666666;
  --text-muted: #999999;
  --border: rgba(0,0,0,0.08);
  --accent: #b4a7d6;  /* 浅薰衣草色 */
  --accent-light: rgba(180, 167, 214, 0.1);
  --hover-bg: rgba(0,0,0,0.06);
  --active-bg: rgba(0,0,0,0.1);
  --nav-bg: rgba(242, 240, 235, 0.5);
  --radius: 16px;
  --radius-sm: 12px;
  --font: JetBrainsMono, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Helvetica, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; -webkit-font-smoothing: antialiased; }

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
  line-height: 1.6;
  padding-bottom: 120px;
}

.main {
  max-width: 900px;  /* 从 720px 增加到 900px，更适合宽屏阅读 */
  margin: 0 auto;
  padding: 24px;
}

.email-detail {
  background: var(--bg-card);
  padding: 40px;     /* 增加内边距，提升阅读呼吸感 */
  border-radius: var(--radius);
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}

@media (max-width: 1200px) {
  .main {
    max-width: 100%;
  }
}

@media (max-width: 768px) {
  body {
    padding-left: 16px;
    padding-right: 16px;
  }
  .main {
    padding: 16px;
  }
}

.page-title {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 8px;
  letter-spacing: -0.2px;
  color: var(--text);
}

.page-subtitle { color: var(--text-muted); font-size: 14px; margin-bottom: 32px; }

/* 分类筛选 */
.filter-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
  align-items: center;
}

.filter-btn {
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 14px;
  color: var(--text-secondary);
  background: var(--bg-card);
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none;
}

.filter-btn:hover, .filter-btn.active {
  background: var(--active-bg);
  color: var(--text);
}

/* 搜索 */
.search-box { position: relative; margin-bottom: 24px; }

.search-input {
  width: 100%;
  padding: 14px 16px 14px 48px;
  border: none;
  border-radius: var(--radius);
  font-size: 15px;
  background: var(--bg-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: all 0.2s ease;
  font-family: var(--font);
}

.search-input:focus { outline: none; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
.search-input::placeholder { color: var(--text-muted); }

.search-icon { position: absolute; left: 18px; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 18px; }

/* 邮件列表 - Koobai 风格 */
.email-list { display: flex; flex-direction: column; gap: 16px; }

.email-item {
  background: var(--bg-card);
  padding: 15px;
  border-radius: var(--radius);
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  position: relative;
}

.email-item:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.08); }

.email-item.unread::before {
  content: '';
  position: absolute;
  left: 0;
  top: 24px;
  bottom: 24px;
  width: 3px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}

.email-checkbox {
  width: 20px;
  height: 20px;
  margin-top: 2px;
  accent-color: var(--accent);
  opacity: 0;
  transition: opacity 0.2s;
  cursor: pointer;
  flex-shrink: 0;
}

.select-mode .email-checkbox { opacity: 1; }

/* Koobai 风格邮件内容布局 */
.email-content-wrapper {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.email-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 左上角日期 - Koobai 风格 */
.email-date {
  font-size: 13px;
  color: var(--text-muted);
  font-weight: 400;
  letter-spacing: 0.3px;
}

.email-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.email-subject {
  color: var(--text);
  font-size: 17px;
  font-weight: 500;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.email-preview {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 左下角发件人标签 - Koobai 风格 */
.email-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.email-sender-tag {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 400;
}

.email-sender-tag::before {
  content: '#';
  opacity: 0.7;
}

/* 空状态 */
.empty { text-align: center; padding: 100px 20px; color: var(--text-muted); }
.empty-icon { font-size: 56px; margin-bottom: 20px; opacity: 0.4; }
.empty-text { font-size: 15px; color: var(--text-secondary); }

/* 邮件详情 */
.email-detail { background: var(--bg-card); border-radius: var(--radius); padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }

.email-detail-header { margin-bottom: 28px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }

.email-detail-subject {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.4;
  margin-bottom: 16px;
  color: var(--text);
  letter-spacing: -0.2px;
}

.email-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 14px;
  color: var(--text-secondary);
}

.email-detail-body { line-height: 1.9; color: var(--text); font-size: 18px !important; letter-spacing: 0.3px; }
.email-detail-body img { max-width: 100% !important; width: auto !important; height: auto !important; border-radius: var(--radius-sm); margin: 20px 0; display: block; }
.email-detail-body p { margin-bottom: 18px; font-size: 18px !important; line-height: 1.9 !important; }
.email-detail-body span { font-size: inherit !important; }
.email-detail-body td { font-size: 18px !important; }
.email-detail-body p:empty { display: none; }
.email-detail-body b, .email-detail-body strong { font-weight: 600; color: #111; }
.email-detail-body a { color: var(--accent) !important; text-decoration: none !important; border-bottom: 1px solid rgba(180, 167, 214, 0.4); transition: all 0.2s; }
.email-detail-body a:hover { border-bottom-color: var(--accent); }
.email-detail-body blockquote { margin: 20px 0; padding: 16px 20px; background: rgba(180, 167, 214, 0.08); border-left: 4px solid var(--accent); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-size: 15px; color: var(--text-secondary); }
.email-detail-body blockquote p { margin-bottom: 8px; }
.email-detail-body blockquote p:last-child { margin-bottom: 0; }
.email-detail-body ul, .email-detail-body ol { margin: 16px 0; padding-left: 24px; }
.email-detail-body li { margin-bottom: 8px; line-height: 1.8; }
.email-detail-body h1, .email-detail-body h2, .email-detail-body h3 { font-weight: 600; color: #111; margin: 24px 0 16px; line-height: 1.4; }
.email-detail-body h1 { font-size: 24px; }
.email-detail-body h2 { font-size: 20px; }
.email-detail-body h3 { font-size: 18px; }
.email-detail-body pre { background: #f5f5f5; padding: 16px; border-radius: var(--radius-sm); overflow-x: auto; font-size: 14px; line-height: 1.6; }
.email-detail-body code { background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 4px; font-size: 14px; font-family: 'JetBrains Mono', monospace; }
.email-detail-body pre code { background: none; padding: 0; }
.email-detail-body table { width: 100% !important; max-width: 100% !important; border-collapse: collapse; margin: 16px 0; font-size: 15px; }
.email-detail-body th, .email-detail-body td { padding: 12px !important; border: 1px solid var(--border); text-align: left; width: auto !important; }
.email-detail-body th { background: rgba(0,0,0,0.03); font-weight: 600; }
.email-detail-body hr { border: none; height: 1px; background: var(--border); margin: 24px 0; }
.email-detail-body div, .email-detail-body span { max-width: 100% !important; }
.email-detail-body * { box-sizing: border-box; }

/* 底部导航栏 - Koobai 风格 */
.bottom-nav {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  min-width: 120px;
  max-width: 600px;
  width: auto;
  background: rgba(242, 240, 235, 0.75);
  backdrop-filter: blur(20px) saturate(1.8);
  -webkit-backdrop-filter: blur(20px) saturate(1.8);
  border-radius: 50px;
  padding: 12px 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: rgba(0, 0, 0, 0.08) 0px 2px 8px 0px, rgba(0, 0, 0, 0.08) 0px 8px 24px 0px;
  z-index: 1000;
}

.lock-btn {
  position: fixed;
  top: 24px;
  right: 24px;
  width: 36px;
  height: 36px;
  border: none;
  background: rgba(242, 240, 235, 0.6);
  backdrop-filter: blur(10px);
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  opacity: 0.3;
  transition: all 0.2s;
  z-index: 999;
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}
.lock-btn:hover {
  opacity: 1;
  background: rgba(242, 240, 235, 0.9);
  color: var(--accent);
  transform: scale(1.05);
}
.lock-btn svg {
  width: 16px;
  height: 16px;
}
body.unlocked .lock-btn {
  color: var(--accent);
  opacity: 0.5;
  background: rgba(180, 167, 214, 0.15);
}
body.unlocked .lock-btn:hover {
  opacity: 1;
  background: rgba(180, 167, 214, 0.25);
}

.nav-menu {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nav-divider {
  width: 1px;
  height: 24px;
  background: rgba(0, 0, 0, 0.08);
  margin: 0 4px;
}

.nav-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 10px 16px;
  font-size: 12.8px;
  color: #666666;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  text-decoration: none;
  border-radius: 16px;
  white-space: nowrap;
  font-weight: 400;
  letter-spacing: 0.2px;
}

.nav-btn:hover {
  color: var(--accent);
  background: rgba(180, 167, 214, 0.1);
  transform: translateY(-1px);
}

.nav-btn.active {
  color: var(--accent);
  background: rgba(180, 167, 214, 0.15);
  font-weight: 500;
}

.nav-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.nav-btn .icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.nav-btn .icon svg {
  width: 20px;
  height: 20px;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
  stroke: currentColor;
}

/* 日志页面 */
.logs-list { display: flex; flex-direction: column; gap: 12px; }

.log-item {
  background: var(--bg-card);
  padding: 16px 20px;
  border-radius: var(--radius);
  font-size: 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: all 0.2s ease;
}

.log-item:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }

.log-header { display: flex; gap: 12px; margin-bottom: 8px; align-items: center; }

.log-time { color: var(--text-muted); font-family: JetBrainsMono, monospace; font-size: 12px; letter-spacing: 0.5px; }

.log-type {
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.log-type-success { background: rgba(16, 185, 129, 0.1); color: #059669; }
.log-type-failed { background: rgba(239, 68, 68, 0.1); color: #dc2626; }
.log-type-processing { background: rgba(59, 130, 246, 0.1); color: #2563eb; }
.log-type-duplicate { background: rgba(245, 158, 11, 0.1); color: #d97706; }
.log-type-receive { background: rgba(139, 92, 246, 0.1); color: #7c3aed; }
.log-type-read { background: rgba(139, 92, 246, 0.1); color: #7c3aed; }
.log-type-delete { background: rgba(239, 68, 68, 0.1); color: #dc2626; }
.log-type-error { background: rgba(239, 68, 68, 0.1); color: #dc2626; }
.log-type-request { background: var(--border); color: var(--text-secondary); }

/* 转发弹窗 */
.modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.modal-overlay.show { display: flex; }
.modal-overlay.open { display: flex; }

.modal {
  background: var(--bg-card);
  padding: 24px;
  border-radius: var(--radius);
  width: 90%;
  max-width: 400px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.2);
}

.modal-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; }

.modal-input {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 15px;
  margin-bottom: 16px;
  font-family: var(--font);
}

.modal-input:focus { outline: none; border-color: var(--accent); }

.modal-buttons { display: flex; gap: 12px; justify-content: flex-end; }

.modal-btn {
  padding: 10px 20px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
  font-family: var(--font);
}

.modal-btn-cancel { background: var(--hover-bg); color: var(--text-secondary); }
.modal-btn-cancel:hover { background: var(--active-bg); }

.modal-btn-confirm { background: var(--accent); color: white; }
.modal-btn-confirm:hover { opacity: 0.9; }

/* 响应式 - Koobai 风格 */
@media (max-width: 900px) {
  .main { max-width: 720px; }
}

@media (max-width: 768px) {
  .main { padding: 20px; max-width: 100%; }
  .email-detail { padding: 24px; }
  .bottom-nav { width: auto; min-width: auto; max-width: 90vw; padding: 16px 24px; }
  .nav-menu { gap: 20px; }
  .email-item { padding: 15px; }
  .email-subject { font-size: 16px; }
  .email-preview { font-size: 13px; }
  /* 日志卡片 */
  .email-log-item { padding: 15px; }
  .email-log-subject { font-size: 15px; }
}

@media (max-width: 600px) {
  .main { padding: 16px; }
  .page-title { font-size: 22px; }
  .page-subtitle { margin-bottom: 24px; font-size: 13px; }
  
  /* 邮件卡片移动端优化 */
  .email-list { gap: 12px; }
  .email-item { padding: 15px; gap: 12px; border-radius: 14px; }
  .email-item.unread::before { top: 20px; bottom: 20px; }
  .email-content-wrapper { gap: 10px; }
  .email-date { font-size: 12px; }
  .email-subject { font-size: 15px; line-height: 1.5; -webkit-line-clamp: 2; }
  .email-preview { font-size: 13px; line-height: 1.5; -webkit-line-clamp: 2; }
  .email-sender-tag { font-size: 11px; }
  /* 日志卡片移动端 */
  .email-logs-list { gap: 12px; }
  .email-log-item { padding: 15px; gap: 10px; border-radius: 14px; }
  .email-log-date { font-size: 12px; }
  .email-log-subject { font-size: 15px; }
  .email-log-sender-tag { font-size: 11px; }
  
  /* 底部导航移动端 */
  .bottom-nav {
    bottom: 12px;
    width: auto;
    min-width: auto;
    max-width: calc(100% - 24px);
    padding: 10px 16px;
    border-radius: 40px;
    backdrop-filter: blur(16px) saturate(1.5);
    -webkit-backdrop-filter: blur(16px) saturate(1.5);
  }
  .nav-menu { gap: 6px; }
  .nav-btn { font-size: 11px; gap: 4px; padding: 8px 12px; }
  .nav-btn .icon svg { width: 18px; height: 18px; }
  
  .email-detail { padding: 20px; }
  .email-detail-subject { font-size: 18px; }
}

@media (max-width: 400px) {
  .main { padding: 12px; }
  .email-item { padding: 12px; }
  .email-subject { font-size: 14px; }
  .email-preview { font-size: 12px; }
  .bottom-nav { padding: 10px 14px; }
  .nav-menu { gap: 10px; }
  .nav-btn { font-size: 10px; }
  /* 日志卡片小屏 */
  .email-log-item { padding: 12px; }
  .email-log-subject { font-size: 14px; }
}
</style>
</head>
<body>

<main class="main">
  ${content}
</main>

<!-- Koobai 风格底部导航 -->
<div class="bottom-nav">
  <div class="nav-menu">
    ${navButtons.map(btn => `
      <a href="${btn.href}" ${btn.id === 'rss' ? 'target="_blank"' : ''}
         class="nav-btn ${btn.active ? 'active' : ''} ${btn.locked ? 'locked' : ''}"
         ${btn.locked ? 'onclick="return window.checkUnlocked(event)"' : ''}>
        <span class="icon" data-lucide="${btn.icon}"></span>
        <span>${btn.label}</span>
      </a>
    `).join('')}
  </div>
</div>

<!-- 右上角解锁按钮 -->
<button class="lock-btn" id="lockBtn" title="解锁编辑功能">
  <span data-lucide="lock"></span>
</button>

<!-- 解锁密码弹窗 -->
<div class="modal-overlay" id="unlockModal">
  <div class="modal">
    <div class="modal-title">🔒 输入密码解锁</div>
    <input type="password" class="modal-input" id="unlockPassword" placeholder="请输入密码">
    <div class="modal-buttons">
      <button class="modal-btn modal-btn-cancel" onclick="window.closeUnlockModal()">取消</button>
      <button class="modal-btn modal-btn-confirm" onclick="window.confirmUnlock()">解锁</button>
    </div>
  </div>
</div>

<!-- 转发弹窗 -->
<div class="modal-overlay" id="forwardModal">
  <div class="modal">
    <div class="modal-title">转发邮件</div>
    <input type="email" class="modal-input" id="forwardEmail" placeholder="输入目标邮箱地址">
    <div class="modal-buttons">
      <button class="modal-btn modal-btn-cancel" onclick="closeForwardModal()">取消</button>
      <button class="modal-btn modal-btn-confirm" onclick="confirmForward()">转发</button>
    </div>
  </div>
</div>

<script>
  // 锁定状态管理
  let isUnlocked = localStorage.getItem('unlocked') === 'true';
  const UNLOCK_PASSWORD = '666';

  // 初始化锁定状态
  function initLockState() {
    if (isUnlocked) {
      document.body.classList.add('unlocked');
      const lockBtn = document.querySelector('.lock-btn [data-lucide]');
      if (lockBtn) lockBtn.setAttribute('data-lucide', 'unlock');
    }
    window.updateLockedElements();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  // 更新锁定元素的显示
  window.updateLockedElements = function() {
    document.querySelectorAll('.locked').forEach(el => {
      el.style.display = isUnlocked ? '' : 'none';
    });
  }

  // 切换锁定状态
  window.toggleLock = function() {
    console.log('toggleLock called, isUnlocked:', isUnlocked);
    if (isUnlocked) {
      // 锁定
      isUnlocked = false;
      localStorage.setItem('unlocked', 'false');
      document.body.classList.remove('unlocked');
      const lockBtn = document.querySelector('.lock-btn [data-lucide]');
      if (lockBtn) lockBtn.setAttribute('data-lucide', 'lock');
      window.updateLockedElements();
      if (typeof lucide !== 'undefined') lucide.createIcons();
    } else {
      // 显示解锁弹窗
      const modal = document.getElementById('unlockModal');
      console.log('unlockModal element:', modal);
      if (modal) {
        modal.classList.add('open');
        console.log('Modal opened, classes:', modal.className);
      } else {
        console.error('unlockModal not found!');
      }
      setTimeout(() => {
        const input = document.getElementById('unlockPassword');
        console.log('unlockPassword input:', input);
        if (input) input.focus();
      }, 100);
    }
  }

  // 检查是否已解锁
  window.checkUnlocked = function(event) {
    if (!isUnlocked) {
      event.preventDefault();
      window.toggleLock();
      return false;
    }
    return true;
  }

  // 关闭解锁弹窗
  window.closeUnlockModal = function() {
    document.getElementById('unlockModal').classList.remove('open');
    document.getElementById('unlockPassword').value = '';
  }

  // 确认解锁
  window.confirmUnlock = function() {
    const password = document.getElementById('unlockPassword').value;
    if (password === UNLOCK_PASSWORD) {
      isUnlocked = true;
      localStorage.setItem('unlocked', 'true');
      document.body.classList.add('unlocked');
      const lockBtn = document.querySelector('.lock-btn [data-lucide]');
      if (lockBtn) lockBtn.setAttribute('data-lucide', 'unlock');
      window.updateLockedElements();
      window.closeUnlockModal();
      if (typeof lucide !== 'undefined') lucide.createIcons();
    } else {
      alert('密码错误');
      document.getElementById('unlockPassword').value = '';
      document.getElementById('unlockPassword').focus();
    }
  }

  // 回车键解锁
  document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded fired');

    // 绑定锁按钮点击事件
    const lockBtn = document.getElementById('lockBtn');
    console.log('lockBtn element:', lockBtn);
    if (lockBtn) {
      lockBtn.addEventListener('click', () => {
        console.log('Lock button clicked!');
        window.toggleLock();
      });
      console.log('Lock button event listener attached');
    } else {
      console.error('lockBtn not found!');
    }

    const unlockInput = document.getElementById('unlockPassword');
    console.log('unlockPassword element:', unlockInput);
    if (unlockInput) {
      unlockInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') window.confirmUnlock();
      });
    }

    initLockState();
    console.log('Lock state initialized');

    // 首页自动刷新 RSS（后台静默拉取）
    if (window.location.pathname === '/' || window.location.pathname === '') {
      fetch('/api/rss/refresh', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
          console.log('RSS refresh result:', data);
          // 如果有新文章，可以选择刷新页面或显示提示
          if (data.fetched > 0) {
            console.log('Fetched ' + data.fetched + ' feeds with new articles');
          }
        })
        .catch(err => console.error('RSS refresh error:', err));
    }
  });

  // 初始化 Lucide 图标 - 多重保险机制
  function initLucideIcons() {
    if (typeof lucide !== 'undefined') {
      try {
        lucide.createIcons();
        console.log('✓ Lucide icons initialized');
        return true;
      } catch (error) {
        console.error('✗ Failed to initialize Lucide icons:', error);
        return false;
      }
    } else {
      console.warn('⚠ Lucide library not loaded');
      return false;
    }
  }

  // 尝试多次初始化
  let initAttempts = 0;
  const maxAttempts = 5;

  function tryInitIcons() {
    if (initLucideIcons() || initAttempts >= maxAttempts) {
      return;
    }
    initAttempts++;
    setTimeout(tryInitIcons, 200);
  }

  // DOM 加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInitIcons);
  } else {
    // 如果 DOM 已加载，立即初始化
    tryInitIcons();
  }

  // 窗口加载完成后再次初始化（最后保险）
  window.addEventListener('load', function() {
    setTimeout(initLucideIcons, 100);
  });

  let selectMode = false;
  let selectedIds = new Set();
  let currentForwardId = null;
  let filterMenuOpen = false;
  let searchBoxOpen = false;
  let editMenuOpen = false;

  // 切换筛选菜单
  function toggleFilterMenu() {
    filterMenuOpen = !filterMenuOpen;
    const menu = document.getElementById('filterMenu');
    const btn = document.getElementById('filterBtn');

    if (menu) {
      menu.style.display = filterMenuOpen ? 'block' : 'none';
    }
    if (btn) {
      if (filterMenuOpen) btn.classList.add('active');
      else btn.classList.remove('active');
    }

    // 关闭搜索框
    if (filterMenuOpen && searchBoxOpen) {
      toggleSearchBox();
    }
  }

  // 关闭 FAB 菜单
  function closeFabMenu() {
    // FAB 菜单通过 CSS hover 控制，此函数用于兼容性
    const fabMain = document.getElementById('fabMain');
    if (fabMain) {
      fabMain.blur();
    }
  }

  // 切换搜索框
  function toggleSearchBox() {
    searchBoxOpen = !searchBoxOpen;
    const box = document.getElementById('searchBox');
    const btn = document.getElementById('searchBtn');
    const input = document.getElementById('searchInput');

    if (box) {
      box.style.display = searchBoxOpen ? 'block' : 'none';
    }
    if (btn) {
      if (searchBoxOpen) btn.classList.add('active');
      else btn.classList.remove('active');
    }

    // 聚焦输入框
    if (searchBoxOpen && input) {
      setTimeout(() => input.focus(), 100);
    }

    // 关闭筛选菜单
    if (searchBoxOpen && filterMenuOpen) {
      toggleFilterMenu();
    }

    // 关闭编辑菜单
    if (searchBoxOpen && editMenuOpen) {
      toggleEditMenu();
    }
  }

  // 切换编辑菜单
  function toggleEditMenu() {
    editMenuOpen = !editMenuOpen;
    const menu = document.getElementById('editMenu');
    const btn = document.getElementById('editBtn');

    if (menu) {
      menu.style.display = editMenuOpen ? 'block' : 'none';
    }
    if (btn) {
      if (editMenuOpen) btn.classList.add('active');
      else btn.classList.remove('active');
    }

    // 关闭其他菜单
    if (editMenuOpen && filterMenuOpen) {
      toggleFilterMenu();
    }
    if (editMenuOpen && searchBoxOpen) {
      toggleSearchBox();
    }
  }

  // 从编辑菜单触发选择模式
  function toggleSelectFromMenu() {
    toggleSelect();
    // 关闭编辑菜单
    toggleEditMenu();
  }

  // 从编辑菜单触发标记已读
  function markReadFromMenu() {
    markRead();
    toggleEditMenu();
  }

  // 从编辑菜单触发删除
  function deleteFromMenu() {
    doDelete();
    toggleEditMenu();
  }

  // 更新编辑菜单按钮状态
  function updateEditMenuButtons() {
    const count = selectedIds.size;
    const readBtn = document.getElementById('editReadBtn');
    const deleteBtn = document.getElementById('editDeleteBtn');
    const selectBtn = document.getElementById('editSelectBtn');

    if (readBtn) readBtn.disabled = count === 0;
    if (deleteBtn) deleteBtn.disabled = count === 0;

    // 更新选择按钮图标和文字
    if (selectBtn) {
      const icon = selectBtn.querySelector('[data-lucide]');
      if (selectMode) {
        selectBtn.innerHTML = '<span data-lucide="check-square" class="edit-menu-icon"></span><span>退出选择</span>';
      } else {
        selectBtn.innerHTML = '<span data-lucide="square" class="edit-menu-icon"></span><span>选择邮件</span>';
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  // 执行搜索
  function doSearch() {
    const input = document.getElementById('searchInput');
    const query = input ? input.value.trim() : '';
    if (query) {
      window.location.href = '/?search=' + encodeURIComponent(query);
    } else {
      window.location.href = '/';
    }
  }

  // 回车搜索
  document.addEventListener('DOMContentLoaded', function() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
          doSearch();
        }
      });
    }
  });

  function toggleSelect() {
    selectMode = !selectMode;
    const list = document.querySelector('.email-list');

    if (selectMode) {
      list.classList.add('select-mode');
    } else {
      list.classList.remove('select-mode');
      document.querySelectorAll('.email-checkbox').forEach(cb => cb.checked = false);
      selectedIds.clear();
      updateButtons();
    }

    // 更新编辑菜单按钮状态
    updateEditMenuButtons();
  }

  function updateSelection() {
    selectedIds = new Set();
    document.querySelectorAll('.email-checkbox:checked').forEach(cb => selectedIds.add(cb.value));
    updateButtons();
  }

  function updateButtons() {
    const count = selectedIds.size;
    // 更新编辑菜单按钮状态
    updateEditMenuButtons();
  }

  async function markRead() {
    if (selectedIds.size === 0) return;
    await fetch('/api/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selectedIds) })
    });
    location.reload();
  }

  async function doDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm('确定删除 ' + selectedIds.size + ' 封邮件？')) return;
    await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selectedIds) })
    });
    location.reload();
  }

  async function deleteEmail(id) {
    if (!confirm('确定删除这封邮件？')) return;
    await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    });
    location.href = '/';
  }

  function forwardEmail(id) {
    currentForwardId = id;
    document.getElementById('forwardModal').classList.add('show');
    document.getElementById('forwardEmail').focus();
  }

  function closeForwardModal() {
    document.getElementById('forwardModal').classList.remove('show');
    currentForwardId = null;
  }

  async function confirmForward() {
    const toAddress = document.getElementById('forwardEmail').value;
    if (!toAddress || !currentForwardId) return;
    
    await fetch('/api/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailId: currentForwardId, toAddress })
    });
    
    closeForwardModal();
    alert('邮件已转发');
    location.reload();
  }

  function doSearch() {
    const search = document.querySelector('.search-input').value;
    location.href = '/?search=' + encodeURIComponent(search);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.querySelector('.search-input');
    if (searchInput) {
      searchInput.addEventListener('keypress', e => { if (e.key === 'Enter') doSearch(); });
    }

    document.querySelectorAll('.email-item').forEach(item => {
      item.addEventListener('click', e => {
        if (selectMode && e.target.type !== 'checkbox') {
          e.preventDefault();
          const cb = item.querySelector('.email-checkbox');
          cb.checked = !cb.checked;
          updateSelection();
        }
      });
    });
  });
</script>

</body>
</html>`;
}

// ============ 邮件列表渲染 ============

function renderEmailList(emails, filters = {}) {
  const { category, isRead, search, tags = [] } = filters;

  const items = emails.map(email => {
    const preview = (email.content_text || '').substring(0, 80).replace(/\s+/g, ' ');
    const isUnread = !email.is_read;
    const senderName = email.sender_name || email.sender || '未知';
    
    return `
      <div class="email-item ${isUnread ? 'unread' : ''}" data-id="${email.id}">
        <input type="checkbox" class="email-checkbox" value="${email.id}" onclick="event.stopPropagation(); updateSelection();">
        <div class="email-content-wrapper" onclick="if(!selectMode) location.href='/view/${email.id}'">
          <div class="email-header-row">
            <div class="email-date">${formatKoobaiDate(email.date_sent)}</div>
          </div>
          <div class="email-body">
            <div class="email-subject">${escapeHtml(email.subject || '(无主题)')}</div>
            <div class="email-preview">${escapeHtml(preview)}</div>
          </div>
          <div class="email-footer">
            <span class="email-sender-tag">${escapeHtml(senderName)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // 筛选菜单（默认隐藏，点击筛选按钮显示）
  const categories = [
    { id: '', label: '全部', icon: 'inbox' },
    { id: 'inbox', label: '收件箱', icon: 'mail' },
    { id: 'important', label: '重要', icon: 'star' },
    { id: 'unread', label: '未读', icon: 'circle' },
  ];

  const filterMenuHtml = `
    <div id="filterMenu" class="filter-menu" style="display: none;">
      <div class="filter-menu-content">
        ${categories.map(cat => `
          <a href="/?${cat.id ? (cat.id === 'unread' ? 'is_read=0' : `category=${cat.id}`) : ''}"
             class="filter-menu-item ${(category === cat.id || (cat.id === 'unread' && isRead === '0')) ? 'active' : ''}">
            <span data-lucide="${cat.icon}" class="filter-menu-icon"></span>
            <span>${cat.label}</span>
          </a>
        `).join('')}
      </div>
    </div>
  `;

  // 搜索框（默认隐藏，点击搜索按钮显示）
  const searchBoxHtml = `
    <div id="searchBox" class="search-box-popup" style="display: none;">
      <div class="search-box-content">
        <span data-lucide="search" class="search-box-icon"></span>
        <input type="text" id="searchInput" class="search-box-input" placeholder="搜索邮件..." value="${escapeHtml(search || '')}">
        <button onclick="doSearch()" class="search-box-btn">搜索</button>
        <button onclick="toggleSearchBox()" class="search-box-btn secondary">取消</button>
      </div>
    </div>
  `;

  // 编辑菜单（默认隐藏，点击编辑按钮显示）
  const editMenuHtml = `
    <div id="editMenu" class="edit-menu" style="display: none;">
      <div class="edit-menu-content">
        <button class="edit-menu-item" id="editSelectBtn" onclick="toggleSelectFromMenu()">
          <span data-lucide="square" class="edit-menu-icon"></span>
          <span>选择邮件</span>
        </button>
        <button class="edit-menu-item" id="editReadBtn" onclick="markReadFromMenu()" disabled>
          <span data-lucide="check" class="edit-menu-icon"></span>
          <span>标记已读</span>
        </button>
        <button class="edit-menu-item" id="editDeleteBtn" onclick="deleteFromMenu()" disabled>
          <span data-lucide="trash-2" class="edit-menu-icon"></span>
          <span>删除邮件</span>
        </button>
      </div>
    </div>
  `;

  return `
    ${filterMenuHtml}
    ${searchBoxHtml}
    ${editMenuHtml}

    ${emails.length > 0 ? `
      <div class="email-list">
        ${items}
      </div>
    ` : `
      <div class="empty" style="margin-top: 40px;">
        <div class="empty-icon">📭</div>
        <div class="empty-text">没有邮件</div>
      </div>
    `}

    <style>
      /* 筛选菜单 */
      .filter-menu {
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        z-index: 1001;
        min-width: 180px;
      }
      .filter-menu-content {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .filter-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        border-radius: var(--radius-sm);
        font-size: 14px;
        color: var(--text);
        text-decoration: none;
        transition: all 0.2s ease;
      }
      .filter-menu-item:hover {
        background: var(--hover-bg);
      }
      .filter-menu-item.active {
        background: var(--accent-light);
        color: var(--accent);
      }
      .filter-menu-icon {
        width: 18px;
        height: 18px;
      }

      /* 编辑菜单 */
      .edit-menu {
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        z-index: 1001;
        min-width: 180px;
      }
      .edit-menu-content {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .edit-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        border-radius: var(--radius-sm);
        font-size: 14px;
        color: var(--text);
        background: transparent;
        border: none;
        cursor: pointer;
        transition: all 0.2s ease;
        text-align: left;
        width: 100%;
      }
      .edit-menu-item:hover:not(:disabled) {
        background: var(--hover-bg);
      }
      .edit-menu-item:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .edit-menu-item.active {
        background: var(--accent-light);
        color: var(--accent);
      }
      .edit-menu-icon {
        width: 18px;
        height: 18px;
      }

      /* 搜索框 */
      .search-box-popup {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%);
        width: calc(100% - 48px);
        max-width: 600px;
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 16px 20px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        z-index: 1001;
      }
      .search-box-content {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .search-box-icon {
        width: 20px;
        height: 20px;
        color: var(--text-muted);
        flex-shrink: 0;
      }
      .search-box-input {
        flex: 1;
        padding: 8px 0;
        border: none;
        font-size: 16px;
        background: transparent;
        color: var(--text);
        outline: none;
      }
      .search-box-input::placeholder {
        color: var(--text-muted);
      }
      .search-box-btn {
        padding: 8px 16px;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 20px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .search-box-btn:hover {
        opacity: 0.9;
      }
      .search-box-btn.secondary {
        background: var(--hover-bg);
        color: var(--text);
      }
    </style>
  `;
}

// ============ 邮件详情渲染 ============

function renderEmailDetail(email) {
  const content = email.content_html || `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(email.content_text || '')}</pre>`;
  
  let tagsHtml = '';
  try {
    const tags = JSON.parse(email.tags || '[]');
    if (tags.length > 0) {
      tagsHtml = `<div style="margin-top: 12px;">${tags.map(t => `<span class="email-tag">${escapeHtml(t)}</span>`).join(' ')}</div>`;
    }
  } catch (e) {}

  return `
    <div class="email-detail">
      <div class="email-detail-header">
        <div class="email-detail-subject">${escapeHtml(email.subject || '(无主题)')}</div>
        <div class="email-detail-meta">
          <span>${escapeHtml(email.sender_name || email.sender || '未知')}</span>
          <span>·</span>
          <span>${formatFullTime(email.date_sent)}</span>
          ${email.category ? `<span>·</span><span>${email.category}</span>` : ''}
        </div>
        ${tagsHtml}
      </div>
      <div class="email-detail-body">${content}</div>
    </div>
  `;
}

// ============ 日志页面 ============

function renderLogsContent(logs, stats = {}) {
  const statusLabels = {
    processing: '处理中',
    success: '成功',
    failed: '失败',
    duplicate: '重复'
  };

  const statusColors = {
    processing: '#f59e0b',
    success: '#22c55e',
    failed: '#ef4444',
    duplicate: '#3b82f6'
  };

  // 过滤"处理中"状态的记录（中间状态，处理完成后会变成 success/failed）
  const filteredLogs = logs.filter(log => log.type !== 'processing');

  // 计算成功率
  const successRate = stats.total > 0
    ? Math.round((stats.success / stats.total) * 100)
    : 0;

  return `
    <h1 class="page-title">邮件处理日志</h1>

    <!-- 统计小组件 -->
    <div class="stats-grid">
      <div class="stat-card stat-total">
        <div class="stat-icon" data-lucide="mail"></div>
        <div class="stat-content">
          <div class="stat-value">${stats.total}</div>
          <div class="stat-label">总处理</div>
        </div>
      </div>
      <div class="stat-card stat-success">
        <div class="stat-icon" data-lucide="check-circle"></div>
        <div class="stat-content">
          <div class="stat-value">${stats.success}</div>
          <div class="stat-label">成功</div>
        </div>
        <div class="stat-badge" style="background: #22c55e20; color: #22c55e">${successRate}%</div>
      </div>
      <div class="stat-card stat-failed">
        <div class="stat-icon" data-lucide="x-circle"></div>
        <div class="stat-content">
          <div class="stat-value">${stats.failed}</div>
          <div class="stat-label">失败</div>
        </div>
      </div>
      <div class="stat-card stat-duplicate">
        <div class="stat-icon" data-lucide="copy"></div>
        <div class="stat-content">
          <div class="stat-value">${stats.duplicate}</div>
          <div class="stat-label">重复</div>
        </div>
      </div>
    </div>

    <div class="logs-divider"></div>

    <div class="logs-header">
      <h2 class="logs-title">最近记录</h2>
      <span class="logs-count">${filteredLogs.length} 条</span>
    </div>

    <div class="email-logs-list">
      ${filteredLogs.length > 0 ? filteredLogs.map(log => {
        // 解析 details
        let details = {};
        try {
          details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details || {};
        } catch (e) {
          details = {};
        }

        // RSS 日志特殊处理
        if (log.type === 'rss') {
          const sourceLabel = details.source === 'cron-auto' ? '定时自动' :
                             details.source === 'page-refresh' ? '页面刷新' :
                             details.source === 'manual' ? '手动触发' : '未知';
          return `
            <div class="email-log-item">
              <div class="email-log-header-row">
                <div class="email-log-date">${details.time || formatKoobaiDate(log.timestamp)}</div>
              </div>
              <div class="email-log-body">
                <div class="email-log-subject">📰 RSS拉取: ${escapeHtml(details.feed || log.action)}</div>
                <div class="email-log-details">
                  新增 ${details.newCount || 0} 篇 / 共 ${details.total || 0} 篇 · ${sourceLabel}
                </div>
              </div>
              <div class="email-log-footer">
                <span class="email-log-sender-tag">RSS订阅</span>
                <span class="email-log-status-badge" style="background: #b4a7d615; color: #b4a7d6">成功</span>
              </div>
            </div>
          `;
        }

        // 邮件日志
        return `
          <div class="email-log-item">
            <div class="email-log-header-row">
              <div class="email-log-date">${formatKoobaiDate(log.timestamp)}</div>
            </div>
            <div class="email-log-body">
              <div class="email-log-subject">${escapeHtml(log.action)}</div>
              ${log.error ? '<div class="email-log-error">' + escapeHtml(log.error) + '</div>' : ''}
            </div>
            <div class="email-log-footer">
              <span class="email-log-sender-tag">${escapeHtml(log.sender || '系统')}</span>
              <span class="email-log-status-badge" style="background: ${statusColors[log.type] || '#999'}15; color: ${statusColors[log.type] || '#999'}">${statusLabels[log.type] || log.type}</span>
            </div>
          </div>
        `;
      }).join('') : `
        <div class="empty" style="margin-top: 20px;">
          <div class="empty-icon">◈</div>
          <div class="empty-text">暂无处理记录</div>
        </div>
      `}
    </div>

    <style>
      /* 统计小组件 */
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
        margin-bottom: 24px;
      }
      @media (max-width: 600px) {
        .stats-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .stat-card {
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.04);
        position: relative;
      }
      .stat-icon {
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 12px;
        background: var(--hover-bg);
        color: var(--text-secondary);
      }
      .stat-icon svg {
        width: 24px;
        height: 24px;
      }
      .stat-success .stat-icon {
        background: #22c55e20;
        color: #22c55e;
      }
      .stat-failed .stat-icon {
        background: #ef444420;
        color: #ef4444;
      }
      .stat-duplicate .stat-icon {
        background: #3b82f620;
        color: #3b82f6;
      }
      .stat-content {
        flex: 1;
      }
      .stat-value {
        font-size: 24px;
        font-weight: 600;
        color: var(--text);
        line-height: 1.2;
      }
      .stat-label {
        font-size: 13px;
        color: var(--text-muted);
        margin-top: 2px;
      }
      .stat-badge {
        position: absolute;
        top: 12px;
        right: 12px;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 12px;
        font-weight: 500;
      }

      /* 分隔线 */
      .logs-divider {
        height: 1px;
        background: var(--border);
        margin: 0 0 20px 0;
      }

      /* 日志头部 */
      .logs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }
      .logs-title {
        font-size: 17px;
        font-weight: 500;
        color: var(--text);
      }
      .logs-count {
        font-size: 13px;
        color: var(--text-muted);
      }

      .email-logs-list {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .email-log-item {
        background: var(--bg-card);
        padding: 15px;
        border-radius: var(--radius);
        box-shadow: 0 1px 3px rgba(0,0,0,0.04);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .email-log-header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .email-log-date {
        font-size: 13px;
        color: var(--text-muted);
        font-weight: 400;
        letter-spacing: 0.3px;
      }
      .email-log-body {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .email-log-subject {
        font-size: 16px;
        font-weight: 500;
        color: var(--text);
        line-height: 1.5;
      }
      .email-log-footer {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 4px;
      }
      .email-log-sender-tag {
        font-size: 12px;
        color: var(--text-muted);
        font-weight: 400;
      }
      .email-log-sender-tag::before {
        content: '#';
        opacity: 0.7;
      }
      .email-log-status-badge {
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 500;
      }
      .email-log-error {
        padding: 8px 12px;
        background: #fee2e2;
        color: #991b1b;
        border-radius: 6px;
        font-size: 12px;
        font-family: JetBrainsMono, monospace;
      }
      .email-log-details {
        font-size: 13px;
        color: var(--text-secondary);
        margin-top: 4px;
      }
    </style>
  `;
}

// ============ 诊断页面 ============

function renderDiagnosticsContent(data) {
  const statusColors = {
    success: '#22c55e',
    failed: '#ef4444',
    error: '#ef4444',
    processing: '#f59e0b',
    duplicate: '#3b82f6',
    receive: '#8b5cf6'
  };

  return `
    <h1 class="page-title">系统诊断</h1>
    <p class="page-subtitle">邮件系统状态检查 · ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>

    <div class="diagnostics-grid">
      <!-- 邮件统计卡片 -->
      <div class="diag-card">
        <div class="diag-card-title">
          <span data-lucide="mail" class="diag-icon"></span>
          邮件统计
        </div>
        <div class="diag-stats">
          <div class="diag-stat">
            <div class="diag-stat-value">${data.emails.total}</div>
            <div class="diag-stat-label">总邮件数</div>
          </div>
          <div class="diag-stat">
            <div class="diag-stat-value">${data.emails.unread}</div>
            <div class="diag-stat-label">未读邮件</div>
          </div>
          <div class="diag-stat">
            <div class="diag-stat-value">${data.emails.today}</div>
            <div class="diag-stat-label">今日收到</div>
          </div>
        </div>
      </div>

      <!-- 数据库表状态 -->
      <div class="diag-card">
        <div class="diag-card-title">
          <span data-lucide="database" class="diag-icon"></span>
          数据库表
        </div>
        <div class="diag-tables">
          ${data.tables.map(t => `
            <span class="diag-table-tag ${t.startsWith('email') ? 'active' : ''}">${t}</span>
          `).join('')}
        </div>
      </div>

      <!-- 最近失败记录 -->
      <div class="diag-card diag-card-full">
        <div class="diag-card-title">
          <span data-lucide="alert-circle" class="diag-icon"></span>
          最近异常记录
          ${data.recentFailures.length > 0 ? `<span class="diag-badge error">${data.recentFailures.length}</span>` : ''}
        </div>
        ${data.recentFailures.length > 0 ? `
          <div class="diag-failures">
            ${data.recentFailures.map(f => `
              <div class="diag-failure-item">
                <div class="diag-failure-header">
                  <span class="diag-failure-time">${formatShortTime(f.received_at)}</span>
                  <span class="diag-failure-status" style="background: ${statusColors[f.status] || '#999'}20; color: ${statusColors[f.status] || '#999'}">${f.status}</span>
                </div>
                <div class="diag-failure-subject">${escapeHtml(f.subject || '(无主题)')}</div>
                <div class="diag-failure-sender">${escapeHtml(f.sender || '未知')}</div>
                ${f.error_message ? `<div class="diag-failure-error">${escapeHtml(f.error_message)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : '<div class="diag-empty">暂无异常记录 ✓</div>'}
      </div>

      <!-- 最近日志 -->
      <div class="diag-card diag-card-full">
        <div class="diag-card-title">
          <span data-lucide="activity" class="diag-icon"></span>
          最近处理记录
        </div>
        <div class="diag-logs">
          ${data.recentLogs.map(log => `
            <div class="diag-log-item">
              <span class="diag-log-time">${formatShortTime(log.received_at)}</span>
              <span class="diag-log-status" style="background: ${statusColors[log.status] || '#999'}20; color: ${statusColors[log.status] || '#999'}">${log.status}</span>
              <span class="diag-log-subject" title="${escapeHtml(log.subject || '')}">${escapeHtml(log.subject || '(无主题)')}</span>
              <span class="diag-log-sender">${escapeHtml(log.sender || '')}</span>
              ${log.processing_time_ms ? `<span class="diag-log-time">${log.processing_time_ms}ms</span>` : ''}
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 检查清单 -->
      <div class="diag-card diag-card-full">
        <div class="diag-card-title">
          <span data-lucide="check-circle" class="diag-icon"></span>
          故障排查检查清单
        </div>
        <div class="diag-checklist">
          <div class="diag-check-item">
            <span class="diag-check-status ${data.tables.includes('emails') ? 'ok' : 'error'}"></span>
            <span>emails 表存在</span>
          </div>
          <div class="diag-check-item">
            <span class="diag-check-status ${data.tables.includes('email_logs') ? 'ok' : 'error'}"></span>
            <span>email_logs 表存在</span>
          </div>
          <div class="diag-check-item">
            <span class="diag-check-status ${data.emails.total > 0 ? 'ok' : 'warning'}"></span>
            <span>有历史邮件数据 (${data.emails.total} 封)</span>
          </div>
          <div class="diag-check-item">
            <span class="diag-check-status ${data.recentLogs.length > 0 ? 'ok' : 'warning'}"></span>
            <span>有邮件处理日志 (${data.recentLogs.length} 条)</span>
          </div>
          <div class="diag-check-item">
            <span class="diag-check-status ${data.recentFailures.length === 0 ? 'ok' : 'error'}"></span>
            <span>无最近失败记录</span>
          </div>
        </div>
        <div class="diag-hint">
          <strong>如果未收到新邮件：</strong><br>
          1. 检查 Cloudflare Email Routing 是否已启用并指向此 Worker<br>
          2. 检查域名 DNS 的 MX 记录是否正确配置<br>
          3. 检查垃圾邮件文件夹<br>
          4. 发送测试邮件后刷新此页面查看日志
        </div>
      </div>
    </div>

    <style>
      .diagnostics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px;
        margin-top: 24px;
      }
      .diag-card {
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 20px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      }
      .diag-card-full {
        grid-column: 1 / -1;
      }
      .diag-card-title {
        font-size: 15px;
        font-weight: 500;
        color: var(--text);
        margin-bottom: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .diag-icon {
        width: 18px;
        height: 18px;
        color: var(--accent);
      }
      .diag-stats {
        display: flex;
        gap: 24px;
      }
      .diag-stat-value {
        font-size: 28px;
        font-weight: 600;
        color: var(--text);
      }
      .diag-stat-label {
        font-size: 13px;
        color: var(--text-muted);
        margin-top: 4px;
      }
      .diag-tables {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .diag-table-tag {
        padding: 4px 10px;
        background: var(--hover-bg);
        border-radius: 20px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .diag-table-tag.active {
        background: var(--accent-light);
        color: var(--accent);
      }
      .diag-badge {
        margin-left: auto;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 500;
      }
      .diag-badge.error {
        background: #fee2e2;
        color: #991b1b;
      }
      .diag-failures, .diag-logs {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .diag-failure-item, .diag-log-item {
        padding: 12px;
        background: var(--hover-bg);
        border-radius: 8px;
        font-size: 13px;
      }
      .diag-failure-header, .diag-log-item {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .diag-failure-time, .diag-log-time {
        color: var(--text-muted);
        font-family: JetBrainsMono, monospace;
        font-size: 12px;
      }
      .diag-failure-status, .diag-log-status {
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        text-transform: uppercase;
      }
      .diag-failure-subject, .diag-log-subject {
        font-weight: 500;
        color: var(--text);
        flex: 1;
        min-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .diag-failure-sender, .diag-log-sender {
        color: var(--text-secondary);
      }
      .diag-failure-error {
        margin-top: 8px;
        padding: 8px;
        background: #fee2e2;
        color: #991b1b;
        border-radius: 4px;
        font-family: JetBrainsMono, monospace;
        font-size: 12px;
        overflow-x: auto;
      }
      .diag-empty {
        text-align: center;
        padding: 24px;
        color: #22c55e;
        font-size: 14px;
      }
      .diag-checklist {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }
      .diag-check-item {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: var(--text-secondary);
      }
      .diag-check-status {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #999;
      }
      .diag-check-status.ok {
        background: #22c55e;
      }
      .diag-check-status.error {
        background: #ef4444;
      }
      .diag-check-status.warning {
        background: #f59e0b;
      }
      .diag-hint {
        padding: 16px;
        background: rgba(153, 77, 97, 0.05);
        border-radius: 8px;
        font-size: 13px;
        line-height: 1.8;
        color: var(--text-secondary);
      }
    </style>
  `;
}

function renderErrorPage(message) {
  return renderKoobaiPage({
    page: 'error',
    content: `<div class="empty"><div class="empty-icon">⚠</div><div>${escapeHtml(message)}</div></div>`
  });
}

// ============ 工具函数 ============

function formatTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const options = { timeZone: 'Asia/Shanghai' };
  if (now - date < 24 * 60 * 60 * 1000 && now.getDate() === date.getDate()) {
    return date.toLocaleTimeString('zh-CN', { ...options, hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { ...options, month: 'numeric', day: 'numeric' });
}

// Koobai 风格日期格式：01月24日 15:55 (东八区)
function formatKoobaiDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  // 转换为东八区时间
  const options = { timeZone: 'Asia/Shanghai', hour12: false };
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    ...options,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const month = parts.find(p => p.type === 'month')?.value || '';
  const day = parts.find(p => p.type === 'day')?.value || '';
  const hour = parts.find(p => p.type === 'hour')?.value || '';
  const minute = parts.find(p => p.type === 'minute')?.value || '';
  return `${month}月${day}日 ${hour}:${minute}`;
}

function formatFullTime(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function formatShortTime(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// HTML 实体解码（处理双重编码的 RSS 内容）
function decodeHtmlEntities(html) {
  if (!html) return '';
  const entities = {
    '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"',
    '&#039;': "'", '&apos;': "'", '&nbsp;': ' ',
    '&ndash;': '\u2013', '&mdash;': '\u2014',
    '&lsquo;': '\u2018', '&rsquo;': '\u2019',
    '&ldquo;': '\u201C', '&rdquo;': '\u201D',
    '&hellip;': '\u2026', '&copy;': '\u00A9',
    '&reg;': '\u00AE', '&trade;': '\u2122',
    '&bull;': '\u2022', '&middot;': '\u00B7', '&deg;': '\u00B0'
  };
  let result = html.replace(/&[a-z]+;/gi, m => entities[m.toLowerCase()] || m);
  result = result.replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)));
  result = result.replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return result;
}

// 深度解码（处理多重编码）
function deepDecodeHTML(html) {
  if (!html) return '';
  let prev = '', current = html;
  for (let i = 0; i < 3 && current !== prev; i++) {
    prev = current;
    current = decodeHtmlEntities(current);
  }
  return current;
}

// ============ API 处理 ============

async function getEmails(search, filters = {}, env) {
  try {
    let query = 'SELECT * FROM emails WHERE is_deleted = 0';
    let params = [];
    
    if (filters.category) {
      query += ' AND category = ?';
      params.push(filters.category);
    }
    
    if (filters.isRead === '0') {
      query += ' AND is_read = 0';
    }
    
    if (search) {
      query += ' AND (subject LIKE ? OR content_text LIKE ? OR sender LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%', '%' + search + '%');
    }
    
    query += ' ORDER BY date_sent DESC';
    const { results } = await env.DB.prepare(query).bind(...params).all();
    return results || [];
  } catch (error) {
    return [];
  }
}

async function handleApiEmails(request, env) {
  const url = new URL(request.url);
  const emails = await getEmails(url.searchParams.get('search') || '', {}, env);
  return new Response(JSON.stringify(emails), { headers: { 'Content-Type': 'application/json' } });
}

async function handleMarkRead(request, env) {
  const data = await request.json();
  try {
    if (data.ids) {
      const ids = data.ids.map(id => parseInt(id)).filter(id => !isNaN(id));
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE emails SET is_read = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
      }
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

async function handleDeleteEmail(request, env) {
  const data = await request.json();
  try {
    if (data.ids) {
      const ids = data.ids.map(id => parseInt(id)).filter(id => !isNaN(id));
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE emails SET is_deleted = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
      }
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

async function handleRssFeed(request, env) {
  const emails = await getEmails('', {}, env);
  const items = emails.map(e => `
    <item>
      <title>${escapeHtml(e.subject || '(无主题)')}</title>
      <link>https://email.zjyyy.top/view/${e.id}</link>
      <description>${escapeHtml((e.content_text || '').substring(0, 200))}</description>
      <pubDate>${e.date_sent}</pubDate>
    </item>
  `).join('');

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>MailBox</title>
<link>https://email.zjyyy.top</link>
<description>邮件订阅</description>
${items}
</channel>
</rss>`, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}

async function handleClearLogs(request, env) {
  operationLogs = [];
  try {
    await env.DB.prepare('DELETE FROM email_logs').run();
  } catch (e) {}
  return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleDebug(request, env) {
  const startTime = Date.now();
  const diagnostics = {
    success: true,
    timestamp: new Date().toISOString(),
    worker: {
      name: 'email',
      version: '2.0',
      compatibility_date: '2026-01-24'
    }
  };

  // 检查数据库表
  let tables = [];
  try {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    tables = results ? results.map(r => r.name) : [];
    diagnostics.tables = tables;
  } catch (e) {
    diagnostics.tables = ['error: ' + e.message];
  }

  // 邮件统计
  try {
    const { results } = await env.DB.prepare('SELECT COUNT(*) as count FROM emails').all();
    diagnostics.emails = {
      total: results ? results[0].count : 0
    };
  } catch (e) {
    diagnostics.emails = { error: e.message };
  }

  // 未读邮件数
  try {
    const { results } = await env.DB.prepare('SELECT COUNT(*) as count FROM emails WHERE is_read = 0 AND is_deleted = 0').all();
    diagnostics.emails.unread = results ? results[0].count : 0;
  } catch (e) {}

  // 今日邮件数
  try {
    const { results } = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM emails 
      WHERE date(date_received) = date('now', 'localtime')
    `).all();
    diagnostics.emails.today = results ? results[0].count : 0;
  } catch (e) {}

  // 数据库日志统计（只统计邮件处理日志）
  try {
    const { results } = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM email_logs 
      WHERE status IN ('processing', 'success', 'failed', 'duplicate')
    `).all();
    diagnostics.logsInDB = results ? results[0].count : 0;
  } catch (e) {
    diagnostics.logsInDB = 0;
  }

  // 最近的失败记录
  try {
    const { results } = await env.DB.prepare(`
      SELECT received_at, sender, subject, status, error_message 
      FROM email_logs 
      WHERE status = 'failed'
      ORDER BY received_at DESC 
      LIMIT 5
    `).all();
    diagnostics.recentFailures = results || [];
  } catch (e) {
    diagnostics.recentFailures = [];
  }

  // 转发历史统计
  try {
    const { results } = await env.DB.prepare('SELECT COUNT(*) as count FROM forward_history').all();
    diagnostics.forwardHistory = { count: results ? results[0].count : 0 };
  } catch (e) {
    diagnostics.forwardHistory = { error: e.message };
  }

  diagnostics.queryTime = Date.now() - startTime;

  return new Response(JSON.stringify(diagnostics, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}// ============ RSS 订阅功能 ============

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
// RSS 手动刷新
async function handleRssRefresh(request, env) {
  try {
    const result = await fetchAllFeedsManual(env, addLog);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleUnifiedContent(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'all';
  const search = url.searchParams.get('search') || '';
  const rssDays = parseInt(url.searchParams.get('rss_days') || '3'); // 默认3天

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

  // 获取 RSS 文章（过滤最近N天）
  if (type === 'all' || type === 'rss') {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - rssDays);
    const cutoffISO = cutoffDate.toISOString();

    const { results: articles } = await env.DB.prepare(`
      SELECT a.id, a.title, a.link, a.description as content_text,
             a.published_at as date, 'rss' as type, f.name as feed_name
      FROM rss_articles a
      JOIN rss_feeds f ON a.feed_id = f.id
      WHERE a.is_deleted = 0 AND a.published_at >= ?
      ORDER BY a.published_at DESC LIMIT 50
    `).bind(cutoffISO).all();
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
// ============ RSS UI 渲染函数 ============

// 渲染订阅管理页面
function renderFeedsManagement(feeds) {
  const feedCards = feeds.map(feed => `
    <div class="feed-card" data-feed-id="${feed.id}">
      <div class="feed-header">
        <div class="feed-info">
          <span class="feed-icon">🌐</span>
          <div class="feed-details">
            <div class="feed-name">${escapeHtml(feed.name)}</div>
            <div class="feed-url">${escapeHtml(feed.url)}</div>
          </div>
        </div>
        <div class="feed-actions">
          <button class="btn-icon" onclick="editFeed(${feed.id})" title="编辑">
            <span data-lucide="edit-2"></span>
          </button>
          <button class="btn-icon" onclick="fetchFeed(${feed.id})" title="立即抓取">
            <span data-lucide="refresh-cw"></span>
          </button>
          <button class="btn-icon" onclick="deleteFeed(${feed.id})" title="删除">
            <span data-lucide="trash-2"></span>
          </button>
        </div>
      </div>
      <div class="feed-meta">
        <div class="feed-stat">
          <span data-lucide="clock"></span>
          <span>${feed.last_fetch_at ? formatTime(feed.last_fetch_at) : '未抓取'}</span>
        </div>
        <div class="feed-stat">
          <span data-lucide="calendar"></span>
          <span>${feed.cron_expression || '0 * * * *'}</span>
        </div>
        <div class="feed-stat ${feed.is_active ? 'status-active' : 'status-inactive'}">
          <span data-lucide="${feed.is_active ? 'check-circle' : 'x-circle'}"></span>
          <span>${feed.is_active ? '启用' : '禁用'}</span>
          <button class="toggle-btn-small" onclick="toggleFeedStatus(${feed.id}, ${feed.is_active ? 0 : 1})" title="${feed.is_active ? '禁用' : '启用'}">
            ${feed.is_active ? '禁用' : '启用'}
          </button>
        </div>
      </div>
      ${feed.last_error ? `
        <div class="feed-error">
          <span data-lucide="alert-circle"></span>
          <span>${escapeHtml(feed.last_error)}</span>
        </div>
      ` : ''}
    </div>
  `).join('');

  return `
    <h1 class="page-title">RSS 订阅管理</h1>
    <p class="page-subtitle">管理您的 RSS 订阅源</p>

    <button class="btn-primary" onclick="showAddFeedModal()">
      <span data-lucide="plus"></span>
      <span>添加订阅源</span>
    </button>

    <div class="feeds-container">
      <div class="feeds-header">
        <h2>我的订阅 (${feeds.length})</h2>
      </div>
      ${feeds.length > 0 ? `
        <div class="feeds-list">
          ${feedCards}
        </div>
      ` : `
        <div class="empty" style="margin-top: 40px;">
          <div class="empty-icon">📡</div>
          <div class="empty-text">暂无订阅源</div>
        </div>
      `}
    </div>

    <!-- 添加订阅弹窗 -->
    <div class="modal-overlay" id="addFeedModal">
      <div class="modal">
        <div class="modal-title">✨ 添加 RSS 订阅</div>
        <div class="modal-body">
          <label class="form-label">订阅源名称</label>
          <input type="text" class="modal-input" id="feedName" placeholder="例如：阮一峰的网络日志">

          <label class="form-label">RSS 地址</label>
          <input type="url" class="modal-input" id="feedUrl" placeholder="https://example.com/feed">

          <label class="form-label">分类</label>
          <div class="category-buttons">
            <button class="category-btn active" data-category="tech">技术</button>
            <button class="category-btn" data-category="news">新闻</button>
            <button class="category-btn" data-category="blog">博客</button>
            <button class="category-btn" data-category="other">其他</button>
          </div>

          <label class="form-label">
            抓取频率 (Cron 表达式)
            <span class="form-help" title="格式: 分 时 日 月 周&#10;例如: 0 * * * * (每小时)&#10;0 */6 * * * (每6小时)">ⓘ</span>
          </label>
          <input type="text" class="modal-input" id="feedCron" value="0 * * * *" placeholder="0 * * * *">
          <div class="cron-presets">
            <button class="preset-btn" onclick="setCron('0 * * * *')">每小时</button>
            <button class="preset-btn" onclick="setCron('0 */6 * * *')">每6小时</button>
            <button class="preset-btn" onclick="setCron('0 0 * * *')">每天</button>
          </div>
        </div>
        <div class="modal-buttons">
          <button class="modal-btn modal-btn-cancel" onclick="closeAddFeedModal()">取消</button>
          <button class="modal-btn modal-btn-confirm" onclick="confirmAddFeed()">添加订阅</button>
        </div>
      </div>
    </div>

    <!-- 编辑订阅弹窗 -->
    <div class="modal-overlay" id="editFeedModal">
      <div class="modal">
        <div class="modal-title">✏️ 编辑 RSS 订阅</div>
        <div class="modal-body">
          <label class="form-label">订阅源名称</label>
          <input type="text" class="modal-input" id="editFeedName" placeholder="例如：阮一峰的网络日志">

          <label class="form-label">RSS 地址</label>
          <input type="url" class="modal-input" id="editFeedUrl" placeholder="https://example.com/feed">

          <label class="form-label">分类</label>
          <div class="category-buttons" id="editCategoryButtons">
            <button class="category-btn" data-category="tech">技术</button>
            <button class="category-btn" data-category="news">新闻</button>
            <button class="category-btn" data-category="blog">博客</button>
            <button class="category-btn" data-category="other">其他</button>
          </div>

          <label class="form-label">
            抓取频率 (Cron 表达式)
            <span class="form-help" title="格式: 分 时 日 月 周&#10;例如: 0 * * * * (每小时)&#10;0 */6 * * * (每6小时)">ⓘ</span>
          </label>
          <input type="text" class="modal-input" id="editFeedCron" value="0 * * * *" placeholder="0 * * * *">
          <div class="cron-presets">
            <button class="preset-btn" onclick="setEditCron('0 * * * *')">每小时</button>
            <button class="preset-btn" onclick="setEditCron('0 */6 * * *')">每6小时</button>
            <button class="preset-btn" onclick="setEditCron('0 0 * * *')">每天</button>
          </div>

          <label class="form-label">状态</label>
          <div class="toggle-switch">
            <input type="checkbox" id="editFeedActive" class="toggle-input">
            <label for="editFeedActive" class="toggle-label">
              <span class="toggle-slider"></span>
              <span class="toggle-text-off">禁用</span>
              <span class="toggle-text-on">启用</span>
            </label>
          </div>
        </div>
        <div class="modal-buttons">
          <button class="modal-btn modal-btn-cancel" onclick="closeEditFeedModal()">取消</button>
          <button class="modal-btn modal-btn-confirm" onclick="confirmEditFeed()">保存</button>
        </div>
      </div>
    </div>

    <style>
      .btn-primary {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 12px 24px;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: var(--radius);
        font-size: 15px;
        cursor: pointer;
        transition: all 0.2s;
        margin-bottom: 24px;
      }
      .btn-primary:hover { opacity: 0.9; }

      .feeds-container { margin-top: 24px; }
      .feeds-header { margin-bottom: 16px; }
      .feeds-header h2 { font-size: 18px; font-weight: 500; }

      .feeds-list { display: flex; flex-direction: column; gap: 16px; }

      .feed-card {
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 20px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.04);
        transition: all 0.2s;
      }
      .feed-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }

      .feed-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 12px;
      }

      .feed-info {
        display: flex;
        gap: 12px;
        flex: 1;
      }

      .feed-icon {
        font-size: 24px;
        flex-shrink: 0;
      }

      .feed-details { flex: 1; min-width: 0; }

      .feed-name {
        font-size: 16px;
        font-weight: 500;
        color: var(--text);
        margin-bottom: 4px;
      }

      .feed-url {
        font-size: 13px;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .feed-actions {
        display: flex;
        gap: 8px;
      }

      .btn-icon {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s;
      }
      .btn-icon:hover { background: var(--hover-bg); color: var(--text); }
      .btn-icon svg { width: 18px; height: 18px; }

      .feed-meta {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
      }

      .feed-stat {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--text-secondary);
      }
      .feed-stat svg { width: 14px; height: 14px; }
      .feed-stat.status-active { color: #22c55e; }
      .feed-stat.status-inactive { color: #ef4444; }

      .toggle-btn-small {
        margin-left: 8px;
        padding: 2px 8px;
        font-size: 11px;
        border-radius: 4px;
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
        cursor: pointer;
        transition: all 0.2s;
      }
      .toggle-btn-small:hover { background: rgba(0,0,0,0.05); }

      /* 切换开关样式 */
      .toggle-switch {
        margin-top: 8px;
      }

      .toggle-input {
        display: none;
      }

      .toggle-label {
        display: flex;
        align-items: center;
        gap: 12px;
        cursor: pointer;
        user-select: none;
      }

      .toggle-slider {
        position: relative;
        width: 48px;
        height: 24px;
        background: #ddd;
        border-radius: 24px;
        transition: all 0.3s;
        flex-shrink: 0;
      }

      .toggle-slider::before {
        content: '';
        position: absolute;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: white;
        top: 2px;
        left: 2px;
        transition: all 0.3s;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
      }

      .toggle-input:checked + .toggle-label .toggle-slider {
        background: var(--accent);
      }

      .toggle-input:checked + .toggle-label .toggle-slider::before {
        left: 26px;
      }

      .toggle-text-off,
      .toggle-text-on {
        font-size: 14px;
        color: var(--text-secondary);
      }

      .toggle-input:checked + .toggle-label .toggle-text-off {
        display: none;
      }

      .toggle-input:not(:checked) + .toggle-label .toggle-text-on {
        display: none;
      }

      .feed-error {
        margin-top: 12px;
        padding: 10px 12px;
        background: #fee2e2;
        color: #991b1b;
        border-radius: 8px;
        font-size: 13px;
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }
      .feed-error svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }

      .form-label {
        display: block;
        font-size: 14px;
        font-weight: 500;
        color: var(--text);
        margin: 16px 0 8px;
      }
      .form-label:first-child { margin-top: 0; }

      .form-help {
        display: inline-block;
        width: 16px;
        height: 16px;
        background: var(--text-muted);
        color: white;
        border-radius: 50%;
        text-align: center;
        line-height: 16px;
        font-size: 12px;
        cursor: help;
        margin-left: 4px;
      }

      .category-buttons {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
      }

      .category-btn {
        flex: 1;
        padding: 8px 16px;
        background: var(--hover-bg);
        color: var(--text-secondary);
        border: none;
        border-radius: 20px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
      }
      .category-btn:hover { background: var(--active-bg); }
      .category-btn.active {
        background: var(--accent-light);
        color: var(--accent);
      }

      .cron-presets {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }

      .preset-btn {
        padding: 6px 12px;
        background: var(--hover-bg);
        color: var(--text-secondary);
        border: none;
        border-radius: 12px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
      }
      .preset-btn:hover { background: var(--active-bg); color: var(--text); }
    </style>

    <script>
      let selectedCategory = 'tech';

      function showAddFeedModal() {
        document.getElementById('addFeedModal').classList.add('show');
      }

      function closeAddFeedModal() {
        document.getElementById('addFeedModal').classList.remove('show');
      }

      document.querySelectorAll('.category-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          selectedCategory = btn.dataset.category;
        });
      });

      function setCron(cron) {
        document.getElementById('feedCron').value = cron;
      }

      async function confirmAddFeed() {
        const name = document.getElementById('feedName').value.trim();
        const url = document.getElementById('feedUrl').value.trim();
        const cron = document.getElementById('feedCron').value.trim();

        if (!name || !url) {
          alert('请填写订阅源名称和地址');
          return;
        }

        try {
          const response = await fetch('/api/feeds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              url,
              category: selectedCategory,
              cron_expression: cron
            })
          });

          const result = await response.json();
          if (result.success) {
            alert(\`订阅添加成功！抓取了 \${result.fetch_result?.newCount || 0} 篇文章\`);
            location.reload();
          } else {
            alert('添加失败：' + result.error);
          }
        } catch (error) {
          alert('添加失败：' + error.message);
        }
      }

      async function deleteFeed(id) {
        if (!confirm('确定删除这个订阅源吗？')) return;

        try {
          const response = await fetch(\`/api/feeds/\${id}\`, { method: 'DELETE' });
          const result = await response.json();
          if (result.success) {
            location.reload();
          } else {
            alert('删除失败：' + result.error);
          }
        } catch (error) {
          alert('删除失败：' + error.message);
        }
      }

      async function fetchFeed(id) {
        try {
          const response = await fetch(\`/api/feeds/\${id}/fetch\`, { method: 'POST' });
          const result = await response.json();
          if (result.success) {
            alert(\`抓取成功！新增 \${result.newCount} 篇文章\`);
            location.reload();
          } else {
            alert('抓取失败：' + result.error);
          }
        } catch (error) {
          alert('抓取失败：' + error.message);
        }
      }

      async function toggleFeedStatus(id, active) {
        try {
          const response = await fetch(\`/api/feeds/\${id}\`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: active === 1 })
          });
          const result = await response.json();
          if (result.success) {
            location.reload();
          } else {
            alert('操作失败：' + result.error);
          }
        } catch (error) {
          alert('操作失败：' + error.message);
        }
      }

      function editFeed(id) {
        // 获取当前订阅源数据
        fetch(\`/api/feeds\`)
          .then(res => res.json())
          .then(data => {
            const feed = data.feeds.find(f => f.id === id);
            if (!feed) {
              alert('订阅源不存在');
              return;
            }

            // 填充表单
            document.getElementById('editFeedName').value = feed.name;
            document.getElementById('editFeedUrl').value = feed.url;
            document.getElementById('editFeedCron').value = feed.cron_expression || '0 * * * *';
            document.getElementById('editFeedActive').checked = feed.is_active === 1;

            // 设置分类
            document.querySelectorAll('#editCategoryButtons .category-btn').forEach(btn => {
              btn.classList.remove('active');
              if (btn.dataset.category === feed.category) {
                btn.classList.add('active');
              }
            });

            // 存储当前编辑的 ID
            window.currentEditFeedId = id;

            // 显示弹窗
            document.getElementById('editFeedModal').classList.add('show');
          })
          .catch(err => {
            alert('获取订阅源信息失败：' + err.message);
          });
      }

      function closeEditFeedModal() {
        document.getElementById('editFeedModal').classList.remove('show');
        window.currentEditFeedId = null;
      }

      function setEditCron(cron) {
        document.getElementById('editFeedCron').value = cron;
      }

      async function confirmEditFeed() {
        if (!window.currentEditFeedId) {
          alert('无效的编辑操作');
          return;
        }

        const name = document.getElementById('editFeedName').value.trim();
        const url = document.getElementById('editFeedUrl').value.trim();
        const cron = document.getElementById('editFeedCron').value.trim();
        const isActive = document.getElementById('editFeedActive').checked;
        const category = document.querySelector('#editCategoryButtons .category-btn.active')?.dataset.category || 'tech';

        if (!name || !url) {
          alert('请填写订阅源名称和地址');
          return;
        }

        try {
          const response = await fetch(\`/api/feeds/\${window.currentEditFeedId}\`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              url,
              category,
              cron_expression: cron,
              is_active: isActive
            })
          });

          const result = await response.json();
          if (result.success) {
            alert('订阅源更新成功！');
            location.reload();
          } else {
            alert('更新失败：' + result.error);
          }
        } catch (error) {
          alert('更新失败：' + error.message);
        }
      }

      // 编辑弹窗的分类按钮事件
      document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('#editCategoryButtons .category-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll('#editCategoryButtons .category-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          });
        });
      });

      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }
    </script>
  `;
}

// 渲染 RSS 文章详情
function renderArticleDetail(article) {
  // 深度解码 HTML 内容（处理双重编码的 RSS 源）
  const rawContent = article.content_html || '';
  const decodedContent = deepDecodeHTML(rawContent);
  const content = decodedContent || `<div class="text-content">${escapeHtml(article.content_text || article.description || '')}</div>`;

  return `
    <div class="email-detail article-detail">
      <div class="email-detail-header">
        <div class="article-source">
          <span data-lucide="rss"></span>
          <span>${escapeHtml(article.feed_name)}</span>
        </div>
        <div class="email-detail-subject">${escapeHtml(article.title)}</div>
        <div class="email-detail-meta">
          ${article.author ? `<span>${escapeHtml(article.author)}</span><span>·</span>` : ''}
          <span>${formatFullTime(article.published_at)}</span>
          <span>·</span>
          <a href="${article.link}" target="_blank" rel="noopener">查看原文 ↗</a>
        </div>
      </div>
      <div class="email-detail-body article-content">${content}</div>
    </div>

    <style>
      .article-source {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 14px;
        color: var(--accent);
        margin-bottom: 16px;
      }
      .article-source svg { width: 16px; height: 16px; }

      .article-detail {
        max-width: 900px;
        margin: 0 auto;
        padding: 40px;
        line-height: 1.8;
      }

      .article-content {
        font-size: 17px;
        color: #333;
      }

      .article-content img {
        max-width: 100%;
        height: auto;
        border-radius: 8px;
        margin: 20px 0;
      }

      .article-content pre, .article-content code {
        background: #f5f5f5;
        padding: 4px 8px;
        border-radius: 4px;
        font-family: var(--font);
        font-size: 15px;
      }

      .article-content pre {
        padding: 16px;
        overflow-x: auto;
        margin: 20px 0;
      }

      .article-content blockquote {
        border-left: 4px solid var(--accent);
        padding-left: 20px;
        margin-left: 0;
        color: #666;
        font-style: italic;
      }

      .text-content {
        white-space: pre-wrap;
      }
    </style>

    <script>
      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }
    </script>
  `;
}

// ============ 合并视图渲染 ============

function renderUnifiedList(items, filters = {}) {
  const { contentType = 'all', category, isRead, search } = filters;

  const listItems = items.map(item => {
    const preview = (item.content || '').substring(0, 80).replace(/\s+/g, ' ');
    const isUnread = !item.is_read;
    const typeIcon = item.type === 'email' ? '📧' : '📰';
    const typeBadge = item.type === 'email' ? 'email' : 'rss';

    return `
      <div class="email-item ${isUnread ? 'unread' : ''}" data-id="${item.id}" data-type="${item.type}">
        <input type="checkbox" class="email-checkbox" value="${item.id}" data-type="${item.type}" onclick="event.stopPropagation(); updateSelection();">
        <div class="email-content-wrapper" onclick="if(!selectMode) location.href='${item.url}'">
          <div class="email-header-row">
            <div class="email-date">${formatKoobaiDate(item.date)}</div>
            <span class="content-type-badge content-type-${typeBadge}">${typeIcon}</span>
          </div>
          <div class="email-body">
            <div class="email-subject">${escapeHtml(item.title || '(无标题)')}</div>
            <div class="email-preview">${escapeHtml(preview)}</div>
          </div>
          <div class="email-footer">
            <span class="email-sender-tag">${escapeHtml(item.source)}</span>
            ${item.type === 'rss' ? '<span class="rss-indicator">🌐</span>' : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // 类型筛选按钮
  const typeFilters = `
    <div class="type-filter-bar">
      <a href="/?type=all${search ? '&search=' + encodeURIComponent(search) : ''}" class="filter-type-btn ${contentType === 'all' ? 'active' : ''}">
        <span data-lucide="layers"></span>
        <span>全部</span>
      </a>
      <a href="/?type=email${search ? '&search=' + encodeURIComponent(search) : ''}" class="filter-type-btn ${contentType === 'email' ? 'active' : ''}">
        <span data-lucide="mail"></span>
        <span>邮件</span>
      </a>
      <a href="/?type=rss${search ? '&search=' + encodeURIComponent(search) : ''}" class="filter-type-btn ${contentType === 'rss' ? 'active' : ''}">
        <span data-lucide="rss"></span>
        <span>RSS</span>
      </a>
    </div>
  `;

  // 右下角圆形悬浮按钮（FAB）
  const fabButton = `
    <div class="fab-container" id="fabContainer">
      <button class="fab-main" id="fabMain">
        <span data-lucide="menu" class="fab-icon"></span>
      </button>
      <div class="fab-menu" id="fabMenu">
        <button class="fab-menu-item" onclick="toggleFilterMenu(); closeFabMenu()">
          <span data-lucide="filter" class="fab-menu-icon"></span>
          <span>筛选</span>
        </button>
        <button class="fab-menu-item" onclick="toggleSearchBox(); closeFabMenu()">
          <span data-lucide="search" class="fab-menu-icon"></span>
          <span>搜索</span>
        </button>
        <button class="fab-menu-item" onclick="toggleEditMenu(); closeFabMenu()">
          <span data-lucide="edit-3" class="fab-menu-icon"></span>
          <span>编辑</span>
        </button>
      </div>
    </div>
  `;

  // 筛选菜单（邮件专用）
  const categories = [
    { id: '', label: '全部', icon: 'inbox' },
    { id: 'inbox', label: '收件箱', icon: 'mail' },
    { id: 'important', label: '重要', icon: 'star' },
    { id: 'unread', label: '未读', icon: 'circle' },
  ];

  const filterMenuHtml = `
    <div id="filterMenu" class="filter-menu" style="display: none;">
      <div class="filter-menu-content">
        ${categories.map(cat => `
          <a href="/?type=${contentType}${cat.id ? (cat.id === 'unread' ? '&is_read=0' : `&category=${cat.id}`) : ''}"
             class="filter-menu-item ${(category === cat.id || (cat.id === 'unread' && isRead === '0')) ? 'active' : ''}">
            <span data-lucide="${cat.icon}" class="filter-menu-icon"></span>
            <span>${cat.label}</span>
          </a>
        `).join('')}
      </div>
    </div>
  `;

  // 搜索框
  const searchBoxHtml = `
    <div id="searchBox" class="search-box-popup" style="display: none;">
      <div class="search-box-content">
        <span data-lucide="search" class="search-box-icon"></span>
        <input type="text" id="searchInput" class="search-box-input" placeholder="搜索邮件和文章..." value="${escapeHtml(search || '')}">
        <button onclick="doSearch()" class="search-box-btn">搜索</button>
        <button onclick="toggleSearchBox()" class="search-box-btn secondary">取消</button>
      </div>
    </div>
  `;

  // 编辑菜单
  const editMenuHtml = `
    <div id="editMenu" class="edit-menu" style="display: none;">
      <div class="edit-menu-content">
        <button class="edit-menu-item" id="editSelectBtn" onclick="toggleSelectFromMenu()">
          <span data-lucide="square" class="edit-menu-icon"></span>
          <span>选择内容</span>
        </button>
        <button class="edit-menu-item" id="editReadBtn" onclick="markReadFromMenu()" disabled>
          <span data-lucide="check" class="edit-menu-icon"></span>
          <span>标记已读</span>
        </button>
        <button class="edit-menu-item" id="editDeleteBtn" onclick="deleteFromMenu()" disabled>
          <span data-lucide="trash-2" class="edit-menu-icon"></span>
          <span>删除</span>
        </button>
      </div>
    </div>
  `;

  return `
    ${filterMenuHtml}
    ${searchBoxHtml}
    ${editMenuHtml}
    ${typeFilters}
    ${fabButton}

    ${items.length > 0 ? `
      <div class="email-list">
        ${listItems}
      </div>
    ` : `
      <div class="empty" style="margin-top: 40px;">
        <div class="empty-icon">📭</div>
        <div class="empty-text">暂无内容</div>
      </div>
    `}

    <style>
      .type-filter-bar {
        position: fixed;
        left: 24px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px;
        background: rgba(242, 240, 235, 0.5);
        backdrop-filter: blur(20px) saturate(1.8);
        -webkit-backdrop-filter: blur(20px) saturate(1.8);
        border-radius: 50px;
        box-shadow: rgba(0, 0, 0, 0.1) 0px 0px 1px 0px, rgba(0, 0, 0, 0.12) 0px 10px 30px 0px;
        z-index: 999;
      }

      .filter-type-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 12px;
        background: transparent;
        color: var(--text-secondary);
        border: none;
        border-radius: 50%;
        font-size: 11px;
        text-decoration: none;
        cursor: pointer;
        transition: all 0.2s;
        min-width: 60px;
        min-height: 60px;
      }
      .filter-type-btn svg { width: 20px; height: 20px; }
      .filter-type-btn:hover { background: var(--hover-bg); color: var(--text); }
      .filter-type-btn.active {
        background: var(--accent-light);
        color: var(--accent);
      }

      .content-type-badge {
        position: absolute;
        top: 15px;
        right: 15px;
        font-size: 18px;
      }

      .rss-indicator {
        font-size: 12px;
        margin-left: 4px;
      }

      /* 右下角圆形悬浮按钮（FAB） */
      .fab-container {
        position: fixed;
        right: 24px;
        bottom: 120px;
        z-index: 999;
      }

      .fab-main {
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: var(--accent);
        color: white;
        border: none;
        box-shadow: 0 4px 12px rgba(180, 167, 214, 0.4), 0 8px 24px rgba(0, 0, 0, 0.15);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
      }

      .fab-main:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 16px rgba(180, 167, 214, 0.5), 0 12px 32px rgba(0, 0, 0, 0.2);
      }

      .fab-main:active {
        transform: scale(0.95);
      }

      .fab-icon {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .fab-icon svg {
        width: 24px;
        height: 24px;
        stroke-width: 2;
        stroke: currentColor;
        fill: none;
      }

      /* FAB 弹出菜单 */
      .fab-menu {
        position: absolute;
        bottom: 70px;
        right: 0;
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
        min-width: 160px;
        opacity: 0;
        visibility: hidden;
        transform: translateY(10px) scale(0.9);
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        backdrop-filter: blur(20px) saturate(1.5);
        -webkit-backdrop-filter: blur(20px) saturate(1.5);
      }

      .fab-container:hover .fab-menu,
      .fab-menu:hover {
        opacity: 1;
        visibility: visible;
        transform: translateY(0) scale(1);
      }

      .fab-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-radius: var(--radius-sm);
        background: transparent;
        border: none;
        color: var(--text);
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s ease;
        width: 100%;
        text-align: left;
      }

      .fab-menu-item:hover {
        background: var(--hover-bg);
        color: var(--accent);
      }

      .fab-menu-icon {
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .fab-menu-icon svg {
        width: 18px;
        height: 18px;
        stroke-width: 2;
        stroke: currentColor;
        fill: none;
      }

      /* 筛选菜单 */
      .filter-menu {
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        z-index: 1001;
        min-width: 180px;
      }
      .filter-menu-content {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .filter-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        border-radius: var(--radius-sm);
        font-size: 14px;
        color: var(--text);
        text-decoration: none;
        transition: all 0.2s ease;
      }
      .filter-menu-item:hover {
        background: var(--hover-bg);
      }
      .filter-menu-item.active {
        background: var(--accent-light);
        color: var(--accent);
      }
      .filter-menu-icon {
        width: 18px;
        height: 18px;
      }

      /* 编辑菜单 */
      .edit-menu {
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        z-index: 1001;
        min-width: 180px;
      }
      .edit-menu-content {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .edit-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        border-radius: var(--radius-sm);
        font-size: 14px;
        color: var(--text);
        background: transparent;
        border: none;
        cursor: pointer;
        transition: all 0.2s ease;
        text-align: left;
        width: 100%;
      }
      .edit-menu-item:hover:not(:disabled) {
        background: var(--hover-bg);
      }
      .edit-menu-item:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .edit-menu-item.active {
        background: var(--accent-light);
        color: var(--accent);
      }
      .edit-menu-icon {
        width: 18px;
        height: 18px;
      }

      /* 搜索框 */
      .search-box-popup {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%);
        width: calc(100% - 48px);
        max-width: 600px;
        background: var(--bg-card);
        border-radius: var(--radius);
        padding: 16px 20px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        z-index: 1001;
      }
      .search-box-content {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .search-box-icon {
        width: 20px;
        height: 20px;
        color: var(--text-muted);
        flex-shrink: 0;
      }
      .search-box-input {
        flex: 1;
        padding: 8px 0;
        border: none;
        font-size: 16px;
        background: transparent;
        color: var(--text);
        outline: none;
      }
      .search-box-input::placeholder {
        color: var(--text-muted);
      }
      .search-box-btn {
        padding: 8px 16px;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 20px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .search-box-btn:hover {
        opacity: 0.9;
      }
      .search-box-btn.secondary {
        background: var(--hover-bg);
        color: var(--text);
      }

      @media (max-width: 600px) {
        .type-filter-bar {
          position: static;
          transform: none;
          flex-direction: row;
          border-radius: 50px;
          margin-bottom: 16px;
          left: auto;
          top: auto;
          justify-content: center;
        }
        .filter-type-btn {
          padding: 8px 12px;
          font-size: 11px;
          min-width: auto;
          min-height: auto;
        }
        .filter-type-btn span:last-child {
          display: block;
        }

        .fab-container {
          right: 16px;
          bottom: 100px;
        }
        .fab-main {
          width: 48px;
          height: 48px;
        }
        .fab-icon svg {
          width: 20px;
          height: 20px;
        }
      }
    </style>
  `;
}

// 删除 RSS 文章
async function handleDeleteArticles(request, env) {
  const data = await request.json();
  try {
    if (data.ids) {
      const ids = data.ids.map(id => parseInt(id)).filter(id => !isNaN(id));
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE rss_articles SET is_deleted = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
      }
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}
