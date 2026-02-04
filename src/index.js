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

  const navButtons = [
    { id: 'inbox', icon: 'mail', label: '收件箱', href: '/', active: isInbox },
    { id: 'logs', icon: 'activity', label: '日志', href: '/logs', active: isLogs },
    { id: 'rss', icon: 'rss', label: '订阅', href: '/rss', active: false },
  ];

  const actionButtons = isInbox ? [
    { id: 'select', icon: 'square', label: '选择', onclick: 'toggleSelect()' },
    { id: 'read', icon: 'check', label: '已读', onclick: 'markRead()', disabled: true },
    { id: 'delete', icon: 'trash-2', label: '删除', onclick: 'doDelete()', disabled: true },
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

  function toggleSelect() {
    selectMode = !selectMode;
    const list = document.querySelector('.email-list');
    const btn = document.getElementById('selectBtn');
    const icon = btn.querySelector('[data-lucide]');

    if (selectMode) {
      list.classList.add('select-mode');
      btn.classList.add('active');
      if (icon) icon.setAttribute('data-lucide', 'check-square');
    } else {
      list.classList.remove('select-mode');
      btn.classList.remove('active');
      if (icon) icon.setAttribute('data-lucide', 'square');
      document.querySelectorAll('.email-checkbox').forEach(cb => cb.checked = false);
      selectedIds.clear();
      updateButtons();
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function updateSelection() {
    selectedIds = new Set();
    document.querySelectorAll('.email-checkbox:checked').forEach(cb => selectedIds.add(cb.value));
    updateButtons();
  }

  function updateButtons() {
    const count = selectedIds.size;
    document.getElementById('readBtn').disabled = count === 0;
    document.getElementById('deleteBtn').disabled = count === 0;
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

  // 生成分类筛选按钮
  const categories = [
    { id: '', label: '全部' },
    { id: 'inbox', label: '收件箱' },
    { id: 'important', label: '重要' },
    { id: 'unread', label: '未读' },
  ];
  
  const filterHtml = `
    <div class="filter-bar">
      ${categories.map(cat => `
        <a href="/?${cat.id ? (cat.id === 'unread' ? 'is_read=0' : `category=${cat.id}`) : ''}" 
           class="filter-btn ${(category === cat.id || (cat.id === 'unread' && isRead === '0')) ? 'active' : ''}">
          ${cat.label}
        </a>
      `).join('')}
    </div>
  `;

  return `
    <h1 class="page-title">收件箱</h1>
    <p class="page-subtitle">${emails.length} 封邮件</p>
    
    ${filterHtml}

    <div class="search-box">
      <span class="search-icon">⌕</span>
      <input type="text" class="search-input" placeholder="搜索邮件..." value="${escapeHtml(search || '')}">
    </div>

    ${emails.length > 0 ? `
      <div class="email-list">
        ${items}
      </div>
    ` : `
      <div class="empty">
        <div class="empty-icon">📭</div>
        <div class="empty-text">没有邮件</div>
      </div>
    `}
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
    <p class="page-subtitle">最近 ${logs.length} 条记录 · <a href="/api/stats" style="color: var(--accent);">查看统计</a></p>

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
  let tables = [];
  try {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    tables = results ? results.map(r => r.name) : [];
  } catch (e) {
    tables = ['error: ' + e.message];
  }

  let emailCount = 0;
  try {
    const { results } = await env.DB.prepare('SELECT COUNT(*) as count FROM emails').all();
    emailCount = results ? results[0].count : 0;
  } catch (e) {
    emailCount = -1;
  }

  return new Response(JSON.stringify({
    success: true,
    tables,
    emailCount,
    logsInMemory: operationLogs.length
  }), { headers: { 'Content-Type': 'application/json' } });
}