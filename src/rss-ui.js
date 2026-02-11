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
        background: rgba(153, 77, 97, 0.1);
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

      function editFeed(id) {
        // 获取当前订阅源数据
        const feedCard = document.querySelector(`[data-feed-id="${id}"]`);
        if (!feedCard) return;

        // 从页面获取当前数据（简单方法）
        fetch(`/api/feeds`)
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

      // 编辑弹窗的分类按钮事件
      document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('#editCategoryButtons .category-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            document.querySelectorAll('#editCategoryButtons .category-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          });
        });
      });

      async function toggleFeedStatus(id, active) {
        try {
          const response = await fetch(`/api/feeds/${id}`, {
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
          const response = await fetch(`/api/feeds/${window.currentEditFeedId}`, {
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

      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }
    </script>
  `;
}

// 渲染 RSS 文章详情
function renderArticleDetail(article) {
  const content = article.content_html || `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(article.content_text || article.description || '')}</pre>`;

  return `
    <div class="email-detail">
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
      <div class="email-detail-body">${content}</div>
    </div>

    <style>
      .article-source {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: #3b82f6;
        margin-bottom: 12px;
      }
      .article-source svg { width: 16px; height: 16px; }
    </style>

    <script>
      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }
    </script>
  `;
}
