// src/index.js

// 邮件处理和数据库操作逻辑
export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 处理不同的API端点
  if (path === '/' || path.startsWith('/?')) {
    return handleHomePage(request, env);
  } else if (path.startsWith('/view/')) {
    return handleEmailView(request, path.split('/')[2], env);
  } else if (path === '/api/emails') {
    return handleApiEmails(request, env);
  } else if (path === '/api/mark-read') {
    return handleMarkRead(request, env);
  } else if (path === '/api/delete') {
    return handleDeleteEmail(request, env);
  } else if (path === '/rss') {
    return handleRssFeed(request, env);
  } else if (path === '/api/debug') {
    return handleDebug(request, env);
  }

  return new Response('Not Found', { status: 404 });
}

async function handleHomePage(request, env) {
  const url = new URL(request.url);
  const queryString = url.search;
  const search = url.searchParams.get('search');
  const filter = url.searchParams.get('filter') || 'all';

  // 从数据库获取邮件列表
  let emails = await getEmails(search, filter, env);

  // 渲染邮件列表页面
  const html = renderList(emails, queryString);
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

async function getEmails(search = '', filter = 'all', env) {
  try {
    // 从D1数据库获取邮件
    let query = 'SELECT * FROM emails';
    let params = [];
    let whereClause = [];

    // 应用过滤
    if (filter === 'unread') {
      whereClause.push('is_read = 0');
    } else if (filter === 'read') {
      whereClause.push('is_read = 1');
    }

    // 应用搜索
    if (search) {
      whereClause.push('(subject LIKE ? OR content LIKE ?)');
      params.push('%' + search + '%');
      params.push('%' + search + '%');
    }

    if (whereClause.length > 0) {
      query += ' WHERE ' + whereClause.join(' AND ');
    }

    query += ' ORDER BY date_sent DESC';

    const { results } = await env.DB.prepare(query).bind(...params).all();
    return results;
  } catch (error) {
    console.error('Error fetching emails:', error);
    // 出错时返回模拟数据
    return [
      {
        id: '1',
        subject: '测试邮件 1',
        date_sent: new Date().toISOString(),
        is_read: false,
        priority: 1,
        content: '这是测试邮件 1 的内容',
      },
      {
        id: '2',
        subject: '测试邮件 2',
        date_sent: new Date(Date.now() - 86400000).toISOString(),
        is_read: true,
        priority: 2,
        content: '这是测试邮件 2 的内容',
      },
      {
        id: '3',
        subject: '测试邮件 3',
        date_sent: new Date(Date.now() - 172800000).toISOString(),
        is_read: false,
        priority: 3,
        content: '这是测试邮件 3 的内容',
      },
    ];
  }
}

function renderList(emails, queryString = "") {
  // 确保 emails 是数组
  if (!Array.isArray(emails)) {
    emails = [];
  }
  const emailItems = emails.map(e => 
    "<div class='email-item " + (!e.is_read ? "unread" : "") + "' data-id='" + e.id + "'>" +
      "<div class='edit-mode-checkbox hidden'>" +
        "<input type='checkbox' class='email-checkbox' value='" + e.id + "' onchange='updateSelection()'>" +
      "</div>" +
      "<div class='email-main'>" +
        "<div class='email-header'>" +
          "<a href='/view/" + e.id + "?" + queryString + "' class='email-subject'>" + e.subject + "</a>" +
          "<span class='email-time'>" + formatTime(e.date_sent) + "</span>" +
        "</div>" +
        "<div class='email-badges'>" +
          (!e.is_read ? "<span class='new-badge'>NEW</span>" : "") +
          (e.priority >= 2 ? "<span class='priority-badge'>!</span>" : "") +
        "</div>" +
      "</div>" +
    "</div>"
  ).join('');

  return "<!DOCTYPE html>" +
    "<html lang='zh-CN'>" +
    "<head>" +
    "<meta charset='UTF-8'>" +
    "<meta name='viewport' content='width=device-width, initial-scale=1.0'>" +
    "<title>邮件列表</title>" +
    "<style>" +
    "/* 全局样式 */" +
    "* {" +
    "margin: 0;" +
    "padding: 0;" +
    "box-sizing: border-box;" +
    "}" +
    "body {" +
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;" +
    "line-height: 1.6;" +
    "color: #333;" +
    "background-color: #F2F0EB;" +
    "padding-bottom: 80px;" +
    "}" +
    "/* 容器样式 */" +
    ".container {" +
    "max-width: 800px;" +
    "margin: 0 auto;" +
    "padding: 20px;" +
    "}" +
    "/* 邮件列表样式 */" +
    ".email-list {" +
    "margin-top: 20px;" +
    "}" +
    "/* 邮件项样式 - 模块框 */" +
    ".email-item {" +
    "background-color: white;" +
    "border-radius: 8px;" +
    "padding: 20px;" +
    "margin-bottom: 20px;" +
    "box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);" +
    "transition: all 0.3s ease;" +
    "position: relative;" +
    "}" +
    ".email-item:hover {" +
    "box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);" +
    "transform: translateY(-1px);" +
    "}" +
    ".email-item.unread {" +
    "border-left: 4px solid #6E6B66;" +
    "}" +
    ".email-main {" +
    "display: flex;" +
    "flex-direction: column;" +
    "gap: 10px;" +
    "}" +
    ".email-header {" +
    "display: flex;" +
    "flex-direction: column;" +
    "gap: 8px;" +
    "}" +
    ".email-time {" +
    "font-size: 14px;" +
    "color: #6E6B66;" +
    "font-weight: 400;" +
    "}" +
    ".email-subject {" +
    "font-size: 18px;" +
    "font-weight: 500;" +
    "color: #333;" +
    "text-decoration: none;" +
    "line-height: 1.4;" +
    "}" +
    ".email-subject:hover {" +
    "color: #6E6B66;" +
    "text-decoration: underline;" +
    "}" +
    ".email-badges {" +
    "display: flex;" +
    "gap: 8px;" +
    "margin-top: 8px;" +
    "}" +
    ".new-badge {" +
    "background-color: #6E6B66;" +
    "color: white;" +
    "font-size: 12px;" +
    "padding: 2px 8px;" +
    "border-radius: 12px;" +
    "font-weight: 500;" +
    "}" +
    ".priority-badge {" +
    "background-color: #6E6B66;" +
    "color: white;" +
    "font-size: 12px;" +
    "padding: 2px 8px;" +
    "border-radius: 12px;" +
    "font-weight: bold;" +
    "}" +
    "/* 悬浮栏样式 */" +
    ".floating-bar {" +
    "position: fixed;" +
    "bottom: 30px;" +
    "left: 50%;" +
    "transform: translateX(-50%);" +
    "background-color: rgba(255, 255, 255, 0.5);" +
    "backdrop-filter: blur(25px);" +
    "-webkit-backdrop-filter: blur(25px);" +
    "-moz-backdrop-filter: blur(25px);" +
    "-o-backdrop-filter: blur(25px);" +
    "border: 1px solid rgba(255, 255, 255, 0.2);" +
    "border-radius: 50px;" +
    "padding: 10px 20px;" +
    "display: flex;" +
    "justify-content: center;" +
    "align-items: center;" +
    "gap: 20px;" +
    "z-index: 1000;" +
    "box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);" +
    "max-width: 90%;" +
    "} "+
    ".floating-item {" +
    "display: flex;" +
    "flex-direction: column;" +
    "align-items: center;" +
    "justify-content: center;" +
    "gap: 4px;" +
    "padding: 8px 12px;" +
    "border-radius: 8px;" +
    "transition: all 0.3s ease;" +
    "cursor: pointer;" +
    "text-decoration: none;" +
    "color: #6E6B66;" +
    "background-color: transparent;" +
    "} " +
    ".floating-item:hover {" +
    "background-color: rgba(110, 107, 102, 0.05);" +
    "transform: translateY(-2px);" +
    "} " +
    ".floating-icon {" +
    "font-size: 18px;" +
    "display: flex;" +
    "align-items: center;" +
    "justify-content: center;" +
    "width: 24px;" +
    "height: 24px;" +
    "font-weight: 500;" +
    "} " +
    ".floating-text {" +
    "font-size: 12px;" +
    "font-weight: 500;" +
    "text-align: center;" +
    "} " +
    ".floating-item.active {" +
    "background-color: rgba(110, 107, 102, 0.1);" +
    "color: #6E6B66;" +
    "} "+
    "/* 搜索和过滤栏 */" +
    ".search-filter-bar {" +
    "margin-bottom: 20px;" +
    "display: flex;" +
    "gap: 12px;" +
    "align-items: center;" +
    "}" +
    ".search-input {" +
    "flex: 1;" +
    "padding: 10px;" +
    "border: 1px solid #6E6B66;" +
    "border-radius: 4px;" +
    "font-size: 14px;" +
    "background-color: white;" +
    "}" +
    ".filter-select {" +
    "padding: 10px;" +
    "border: 1px solid #6E6B66;" +
    "border-radius: 4px;" +
    "font-size: 14px;" +
    "background-color: white;" +
    "}" +
    "/* 响应式设计 */" +
    "@media (max-width: 768px) {" +
    ".container {" +
    "padding: 15px;" +
    "}" +
    ".email-item {" +
    "padding: 16px;" +
    "margin-bottom: 16px;" +
    "}" +
    ".floating-bar {" +
    "flex-direction: column;" +
    "gap: 8px;" +
    "padding: 12px;" +
    "}" +
    ".floating-bar .left-buttons," +
    ".floating-bar .right-buttons {" +
    "width: 100%;" +
    "justify-content: center;" +
    "}" +
    ".search-filter-bar {" +
    "flex-direction: column;" +
    "align-items: stretch;" +
    "}" +
    "}" +
    "/* 隐藏类 */" +
    ".hidden {" +
    "display: none;" +
    "}" +
    "/* 编辑模式 */" +
    ".edit-mode .edit-mode-checkbox {" +
    "display: block;" +
    "position: absolute;" +
    "top: 20px;" +
    "left: 20px;" +
    "}" +
    ".edit-mode .email-main {" +
    "margin-left: 30px;" +
    "}" +
    "</style>" +
    "</head>" +
    "<body>" +
    "<div class='container'>" +
    "<!-- 搜索和过滤栏 -->" +
    "<div class='search-filter-bar'>" +
    "<input type='text' class='search-input' placeholder='搜索邮件...' id='search-input'>" +
    "<select class='filter-select' id='filter-select'>" +
    "<option value='all'>全部</option>" +
    "<option value='unread'>未读</option>" +
    "<option value='read'>已读</option>" +
    "</select>" +
    "<button class='btn btn-primary' id='search-btn'>搜索</button>" +
    "</div>" +
    "<!-- 邮件列表 -->" +
    "<div class='email-list' id='email-list'>" +
    (emailItems || "<p>没有找到邮件</p>") +
    "</div>" +
    "</div>" +
    "<!-- 悬浮栏 -->" +
    "<div class='floating-bar'>" +
    "<div class='floating-item' id='edit-btn'>" +
    "<div class='floating-icon'>编</div>" +
    "<div class='floating-text'>编辑</div>" +
    "</div>" +
    "<div class='floating-item' id='mark-all-read-btn'>" +
    "<div class='floating-icon'>✓</div>" +
    "<div class='floating-text'>已读</div>" +
    "</div>" +
    "<div class='floating-item' id='refresh-btn'>" +
    "<div class='floating-icon'>刷</div>" +
    "<div class='floating-text'>刷新</div>" +
    "</div>" +
    "<div class='floating-item' id='delete-btn'>" +
    "<div class='floating-icon'>删</div>" +
    "<div class='floating-text'>删除</div>" +
    "</div>" +
    "<a href='/rss' class='floating-item'>" +
    "<div class='floating-icon'>📡</div>" +
    "<div class='floating-text'>RSS</div>" +
    "</a>" +
    "<a href='/logs' class='floating-item'>" +
    "<div class='floating-icon'>日</div>" +
    "<div class='floating-text'>日志</div>" +
    "</a>" +
    "</div>" +
    "<script>" +
    "// 搜索功能" +
    "document.getElementById('search-btn').addEventListener('click', function() {" +
    "const search = document.getElementById('search-input').value;" +
    "const filter = document.getElementById('filter-select').value;" +
    "window.location.href = '/?search=' + encodeURIComponent(search) + '&filter=' + filter;" +
    "});" +
    "// 回车搜索" +
    "document.getElementById('search-input').addEventListener('keypress', function(e) {" +
    "if (e.key === 'Enter') {" +
    "document.getElementById('search-btn').click();" +
    "}" +
    "});" +
    "// 过滤功能" +
    "document.getElementById('filter-select').addEventListener('change', function() {" +
    "const search = document.getElementById('search-input').value;" +
    "const filter = this.value;" +
    "window.location.href = '/?search=' + encodeURIComponent(search) + '&filter=' + filter;" +
    "});" +
    "// 刷新功能" +
    "document.getElementById('refresh-btn').addEventListener('click', function() {" +
    "window.location.reload();" +
    "});" +
    "// 编辑模式" +
    "let editMode = false;" +
    "document.getElementById('edit-btn').addEventListener('click', function() {" +
    "editMode = !editMode;" +
    "const emailList = document.getElementById('email-list');" +
    "const editBtn = document.getElementById('edit-btn');" +
    "const editIcon = editBtn.querySelector('.floating-icon');" +
    "const editText = editBtn.querySelector('.floating-text');" +
    "if (editMode) {" +
    "emailList.classList.add('edit-mode');" +
    "editIcon.textContent = '❌';" +
    "editText.textContent = '取消';" +
    "} else {" +
    "emailList.classList.remove('edit-mode');" +
    "editIcon.textContent = '✏️';" +
    "editText.textContent = '编辑';" +
    "// 清除所有选择" +
    "document.querySelectorAll('.email-checkbox').forEach(function(checkbox) {" +
    "checkbox.checked = false;" +
    "});" +
    "updateSelection();" +
    "}" +
    "});" +
    "// 更新选择状态" +
    "function updateSelection() {" +
    "const selectedCount = document.querySelectorAll('.email-checkbox:checked').length;" +
    "// 不需要更新删除按钮文本，因为现在使用图标" +
    "}" +
    "// 批量删除" +
    "document.getElementById('delete-btn').addEventListener('click', async function() {" +
    "const selectedCheckboxes = document.querySelectorAll('.email-checkbox:checked');" +
    "const selectedIds = Array.from(selectedCheckboxes).map(function(cb) { return cb.value; });" +
    "if (selectedIds.length === 0) return;" +
    "if (confirm('确定要删除 ' + selectedIds.length + ' 封邮件吗？')) {" +
    "const response = await fetch('/api/delete', {" +
    "method: 'POST'," +
    "headers: {" +
    "'Content-Type': 'application/json'," +
    "}," +
    "body: JSON.stringify({ ids: selectedIds })," +
    "});" +
    "if (response.ok) {" +
    "window.location.reload();" +
    "} else {" +
    "alert('删除失败');" +
    "}" +
    "}" +
    "});" +
    "// 全部标为已读" +
    "document.getElementById('mark-all-read-btn').addEventListener('click', async function() {" +
    "const response = await fetch('/api/mark-read', {" +
    "method: 'POST'," +
    "headers: {" +
    "'Content-Type': 'application/json'," +
    "}," +
    "body: JSON.stringify({ all: true })," +
    "});" +
    "if (response.ok) {" +
    "window.location.reload();" +
    "} else {" +
    "alert('操作失败');" +
    "}" +
    "});" +
    "</script>" +
    "</body>" +
    "</html>";
}

// 格式化时间
function formatTime(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// 处理邮件查看
async function handleEmailView(request, emailId, env) {
  // 这里应该是从数据库获取邮件详情的逻辑
  return new Response("<h1>查看邮件 " + emailId + "</h1>", {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

// 处理API邮件列表
async function handleApiEmails(request, env) {
  const url = new URL(request.url);
  const search = url.searchParams.get('search');
  const filter = url.searchParams.get('filter') || 'all';

  const emails = await getEmails(search, filter, env);
  return new Response(JSON.stringify(emails), {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

// 处理标为已读
async function handleMarkRead(request, env) {
  const data = await request.json();
  try {
    if (data.all) {
      // 全部标为已读
      await env.DB.prepare('UPDATE emails SET is_read = 1').run();
    } else if (data.ids && Array.isArray(data.ids)) {
      // 批量标为已读
      if (data.ids.length > 0) {
        const placeholders = data.ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE emails SET is_read = 1 WHERE id IN (${placeholders})`)
          .bind(...data.ids)
          .run();
      }
    } else if (data.id) {
      // 单个标为已读
      await env.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?')
        .bind(data.id)
        .run();
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error marking emails as read:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}

// 处理删除邮件
async function handleDeleteEmail(request, env) {
  const data = await request.json();
  try {
    console.log('Delete request received:', data);
    
    if (data.ids && Array.isArray(data.ids)) {
      // 批量删除
      if (data.ids.length > 0) {
        console.log('Deleting emails with IDs:', data.ids);
        const placeholders = data.ids.map(() => '?').join(',');
        const result = await env.DB.prepare(`DELETE FROM emails WHERE id IN (${placeholders})`)
          .bind(...data.ids)
          .run();
        console.log('Delete result:', result);
      }
    } else if (data.id) {
      // 单个删除
      console.log('Deleting email with ID:', data.id);
      const result = await env.DB.prepare('DELETE FROM emails WHERE id = ?')
        .bind(data.id)
        .run();
      console.log('Delete result:', result);
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error deleting emails:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}

// 处理RSS订阅
async function handleRssFeed(request, env) {
  const emails = await getEmails('', 'all', env);
  const rss = generateRssFeed(emails);
  return new Response(rss, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    },
  });
}

// 生成RSS订阅内容
function generateRssFeed(emails) {
  const now = new Date().toISOString();
  let rssItems = "";
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    rssItems += "<item>" +
      "<title>" + email.subject + "</title>" +
      "<link>https://email.zjyyy.top/view/" + email.id + "</link>" +
      "<description>" + email.content + "</description>" +
      "<pubDate>" + email.date_sent + "</pubDate>" +
      "<guid>https://email.zjyyy.top/view/" + email.id + "</guid>" +
      "</item>";
  }
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" ?>" +
    "<rss version=\"2.0\">" +
    "<channel>" +
    "<title>邮件列表</title>" +
    "<link>https://email.zjyyy.top</link>" +
    "<description>邮件订阅</description>" +
    "<lastBuildDate>" + now + "</lastBuildDate>" +
    rssItems +
    "</channel>" +
    "</rss>";
}

// 处理调试信息
async function handleDebug(request, env) {
  try {
    // 获取表结构
    const tableInfo = await env.DB.prepare('PRAGMA table_info(emails)').all();
    
    // 获取示例数据
    const sampleData = await env.DB.prepare('SELECT * FROM emails LIMIT 5').all();
    
    // 获取邮件总数
    const countResult = await env.DB.prepare('SELECT COUNT(*) as count FROM emails').first();
    
    return new Response(JSON.stringify({
      success: true,
      tableInfo: tableInfo.results,
      sampleData: sampleData.results,
      count: countResult.count
    }), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}
