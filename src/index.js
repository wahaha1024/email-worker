// src/index.js - 邮件管理系统 - Koobai 风格 + 完整功能
import PostalMime from 'postal-mime';

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

// 获取日志（从数据库）
async function getLogs(env, limit = 50) {
  try {
    if (env.DB) {
      const { results } = await env.DB.prepare(`
        SELECT * FROM email_logs 
        ORDER BY received_at DESC 
        LIMIT ?
      `).bind(limit).all();
      
      return (results || []).map(row => ({
        id: row.id,
        timestamp: row.received_at || row.created_at,
        type: row.status || 'info',
        action: row.subject || row.action || '',
        details: JSON.stringify({
          sender: row.sender,
          recipient: row.recipient,
          error: row.error_message,
          processing_time: row.processing_time_ms
        })
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
    const url = new URL(request.url);
    await addLog(env, 'request', `${request.method} ${url.pathname}`, { query: url.search });
    
    try {
      return await handleRequest(request, env);
    } catch (error) {
      await addLog(env, 'error', error.message, { stack: error.stack });
      return new Response(renderErrorPage(error.message), { status: 500 });
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

    await addLog(env, 'receive', `收到邮件: ${subject}`, { from: senderEmail, to });

    const existing = await env.DB.prepare('SELECT id FROM emails WHERE message_id = ?').bind(messageId).first();
    if (existing) {
      await addLog(env, 'receive', `重复邮件更新: ${subject}`, { messageId });
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

    await addLog(env, 'receive', `邮件已保存: ${subject}`, { from: senderEmail });
    return new Response(JSON.stringify({ success: true, subject }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    await addLog(env, 'error', `邮件接收失败: ${error.message}`);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleHomePage(request, env, filters = {}) {
  const { category, isRead, search } = filters;
  const emails = await getEmails(search, { category, isRead }, env);
  
  // 获取标签列表
  let tags = [];
  try {
    const { results } = await env.DB.prepare('SELECT * FROM tags ORDER BY name').all();
    tags = results || [];
  } catch (e) {
    tags = [];
  }
  
  const html = renderKoobaiPage({
    page: 'inbox',
    content: renderEmailList(emails, { category, isRead, search, tags })
  });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleEmailView(request, emailId, env) {
  const email = await env.DB.prepare('SELECT * FROM emails WHERE id = ? AND is_deleted = 0').bind(emailId).first();
  if (!email) return new Response(renderKoobaiPage({ page: 'view', content: '<div class="empty">邮件不存在</div>' }), { status: 404 });
  
  await env.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').bind(emailId).run();
  await addLog(env, 'read', `查看邮件: ${email.subject}`, { id: emailId });
  
  const html = renderKoobaiPage({ page: 'view', emailId, content: renderEmailDetail(email) });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleLogsPage(request, env) {
  const logs = await getLogs(env, 50);
  const html = renderKoobaiPage({
    page: 'logs',
    content: renderLogsContent(logs)
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
      ORDER BY received_at DESC 
      LIMIT 20
    `).all();
    diagnostics.recentLogs = results || [];
  } catch (e) {}

  try {
    const { results } = await env.DB.prepare(`
      SELECT received_at, sender, subject, status, error_message 
      FROM email_logs 
      WHERE status IN ('failed', 'error', 'processing')
      ORDER BY received_at DESC 
      LIMIT 10
    `).all();
    diagnostics.recentFailures = results || [];
  } catch (e) {}

  const content = renderDiagnosticsContent(diagnostics);
  const html = renderKoobaiPage({ page: 'diagnostics', content });
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

  const navButtons = [
    { id: 'inbox', icon: 'mail', label: '收件箱', href: '/', active: isInbox },
    { id: 'logs', icon: 'activity', label: '日志', href: '/logs', active: isLogs || isDiagnostics },
    { id: 'rss', icon: 'rss', label: '订阅', href: '/rss', active: false },
  ];

  const actionButtons = isInbox ? [
    { id: 'filter', icon: 'filter', label: '筛选', onclick: 'toggleFilterMenu()' },
    { id: 'search', icon: 'search', label: '搜索', onclick: 'toggleSearchBox()' },
    { id: 'edit', icon: 'pen-square', label: '编辑', onclick: 'toggleEditMenu()' },
  ] : isView ? [
    { id: 'back', icon: 'arrow-left', label: '返回', onclick: 'history.back()' },
    { id: 'forward', icon: 'forward', label: '转发', onclick: `forwardEmail(${emailId})` },
    { id: 'delete', icon: 'trash-2', label: '删除', onclick: `deleteEmail(${emailId})` },
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
  --bg-card: #fffdfe;
  --text: #222222;
  --text-secondary: #666666;
  --text-muted: #999999;
  --border: rgba(0,0,0,0.08);
  --accent: #994d61;
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

.main { max-width: 800px; margin: 0 auto; padding: 24px; }

.page-title {
  font-size: 28px;
  font-weight: 600;
  margin-bottom: 8px;
  letter-spacing: -0.3px;
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

/* 邮件列表 */
.email-list { display: flex; flex-direction: column; gap: 12px; }

.email-item {
  background: var(--bg-card);
  padding: 20px;
  border-radius: var(--radius);
  display: flex;
  align-items: flex-start;
  gap: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}

.email-item:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.08); }

.email-item.unread { border-left: 3px solid var(--accent); }

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

.email-content { flex: 1; min-width: 0; }

.email-sender {
  font-weight: 500;
  font-size: 15px;
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.email-subject {
  color: var(--text);
  font-size: 17.6px;
  font-weight: 500;
  line-height: 1.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 6px;
}

.email-preview {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.email-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-top: 4px;
}

.email-time {
  font-size: 13px;
  color: var(--text-muted);
  white-space: nowrap;
}

.email-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--hover-bg);
  color: var(--text-secondary);
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

.email-detail-body { line-height: 1.8; color: var(--text); font-size: 16px; }
.email-detail-body img { max-width: 100%; border-radius: var(--radius-sm); margin: 16px 0; }
.email-detail-body p { margin-bottom: 16px; }

/* 底部导航栏 */
.bottom-nav {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  width: 600px;
  max-width: 90vw;
  background: rgba(242, 240, 235, 0.5);
  backdrop-filter: blur(20px) saturate(1.8);
  -webkit-backdrop-filter: blur(20px) saturate(1.8);
  border-radius: 50px;
  padding: 20px 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-shadow: rgba(0, 0, 0, 0.1) 0px 0px 1px 0px, rgba(0, 0, 0, 0.12) 0px 10px 30px 0px;
  z-index: 1000;
}

.nav-menu { display: flex; align-items: center; gap: 32px; }

.nav-divider { width: 1px; height: 20px; background: rgba(0, 0, 0, 0.1); }

.nav-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  font-size: 12.8px;
  color: #444444;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none;
}

.nav-btn:hover { color: #994d61; }
.nav-btn.active { color: #994d61; }
.nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.nav-btn .icon { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; }
.nav-btn .icon svg { width: 20px; height: 20px; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

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

/* 响应式 */
@media (max-width: 768px) {
  .main { padding: 20px; }
  .email-detail { padding: 24px; }
  .bottom-nav { width: auto; min-width: 500px; padding: 16px 24px; }
  .nav-menu { gap: 24px; }
}

@media (max-width: 600px) {
  .main { padding: 16px; }
  .page-title { font-size: 24px; }
  .page-subtitle { margin-bottom: 24px; }
  .email-item { padding: 16px; gap: 12px; }
  .email-subject { font-size: 16px; line-height: 1.5; }
  .bottom-nav { bottom: 16px; width: calc(100% - 32px); max-width: none; padding: 14px 20px; border-radius: 40px; }
  .nav-menu { gap: 16px; }
  .nav-btn { font-size: 12px; }
  .email-detail { padding: 20px; }
  .email-detail-subject { font-size: 20px; }
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
         class="nav-btn ${btn.active ? 'active' : ''}">
        <span class="icon" data-lucide="${btn.icon}"></span>
        <span>${btn.label}</span>
      </a>
    `).join('')}

    ${actionButtons.length > 0 ? '<div class="nav-divider"></div>' : ''}

    ${actionButtons.map(btn => `
      <button class="nav-btn" id="${btn.id}Btn" onclick="${btn.onclick}"
              ${btn.disabled ? 'disabled' : ''}>
        <span class="icon" data-lucide="${btn.icon}"></span>
        <span>${btn.label}</span>
      </button>
    `).join('')}
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
  // 初始化 Lucide 图标
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

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
    const preview = (email.content_text || '').substring(0, 60).replace(/\s+/g, ' ');
    const isUnread = !email.is_read;
    let tagHtml = '';

    try {
      const emailTags = JSON.parse(email.tags || '[]');
      if (emailTags.length > 0) {
        tagHtml = `<span class="email-tag">${emailTags[0]}</span>`;
      }
    } catch (e) {}

    return `
      <div class="email-item ${isUnread ? 'unread' : ''}" data-id="${email.id}">
        <input type="checkbox" class="email-checkbox" value="${email.id}" onclick="event.stopPropagation(); updateSelection();">
        <div class="email-content" onclick="if(!selectMode) location.href='/view/${email.id}'">
          <div class="email-sender">${escapeHtml(email.sender_name || email.sender || '未知')}</div>
          <div class="email-subject">${escapeHtml(email.subject || '(无主题)')}</div>
          <div class="email-preview">${escapeHtml(preview)}</div>
        </div>
        <div class="email-meta">
          ${tagHtml}
          <div class="email-time">${formatTime(email.date_sent)}</div>
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
        background: rgba(153, 77, 97, 0.1);
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
        background: rgba(153, 77, 97, 0.1);
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

function renderLogsContent(logs) {
  return `
    <h1 class="page-title">系统日志</h1>
    <p class="page-subtitle">最近 ${logs.length} 条记录 · <a href="/api/stats" style="color: var(--accent);">查看统计</a> · <a href="/diagnostics" style="color: var(--accent);">诊断页面</a></p>

    <div class="logs-list">
      ${logs.length > 0 ? logs.map(log => `
        <div class="log-item">
          <div class="log-header">
            <span class="log-time">${formatShortTime(log.timestamp)}</span>
            <span class="log-type log-type-${log.type}">${log.type}</span>
          </div>
          <div>${escapeHtml(log.action)}</div>
        </div>
      `).join('') : `
        <div class="empty">
          <div class="empty-icon">◈</div>
          <div class="empty-text">暂无日志</div>
        </div>
      `}
    </div>
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
    <p class="page-subtitle">邮件系统状态检查 · ${new Date(data.timestamp).toLocaleString('zh-CN')}</p>

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
        background: rgba(153, 77, 97, 0.1);
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
  if (now - date < 24 * 60 * 60 * 1000 && now.getDate() === date.getDate()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function formatFullTime(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleString('zh-CN');
}

function formatShortTime(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
</rss>`, { headers: { 'Content-Type': 'application/rss+xml' } });
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

  // 最近日志（内存）
  diagnostics.logsInMemory = operationLogs.length;
  diagnostics.recentLogs = operationLogs.slice(0, 10).map(log => ({
    timestamp: log.timestamp,
    type: log.type,
    action: log.action
  }));

  // 数据库日志统计
  try {
    const { results } = await env.DB.prepare('SELECT COUNT(*) as count FROM email_logs').all();
    diagnostics.logsInDB = results ? results[0].count : 0;
  } catch (e) {
    diagnostics.logsInDB = 0;
  }

  // 最近的失败记录
  try {
    const { results } = await env.DB.prepare(`
      SELECT received_at, sender, subject, status, error_message 
      FROM email_logs 
      WHERE status = 'failed' OR status = 'error'
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
}