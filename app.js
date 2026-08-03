// ===== CONFIG =====
const CONFIG = {
    // GitHub API settings (user fills these in)
    get owner() { return localStorage.getItem('gh_owner') || ''; },
    get repo() { return localStorage.getItem('gh_repo') || ''; },
    get token() { return localStorage.getItem('gh_token') || ''; },
    get branch() { return localStorage.getItem('gh_branch') || 'main'; },

    get isConfigured() {
        return this.owner && this.repo && this.token;
    },

    // Auto-detect if running on GitHub Pages
    get isGitHubPages() {
        return location.hostname.includes('github.io');
    },

    // Build raw GitHub URL
    get rawBaseUrl() {
        if (!this.isGitHubPages) return null;
        const pathParts = location.pathname.split('/').filter(Boolean);
        const user = location.hostname.split('.')[0];
        const repo = pathParts[0] || (user + '.github.io');
        return `https://raw.githubusercontent.com/${user}/${repo}/main/`;
    },

    // API base URL
    get apiBaseUrl() {
        if (!this.isConfigured) return null;
        return `https://api.github.com/repos/${this.owner}/${this.repo}`;
    },

    // URLs for data files
    get postsUrl() { 
        if (this.isConfigured) return this.rawBaseUrl + 'posts.json';
        return this.isGitHubPages ? this.rawBaseUrl + 'posts.json' : null; 
    },
    get settingsUrl() { 
        if (this.isConfigured) return this.rawBaseUrl + 'settings.json';
        return this.isGitHubPages ? this.rawBaseUrl + 'settings.json' : null; 
    }
};

// ===== DATA STORE =====
const Storage = {
    get(key, defaultVal = null) {
        try { return JSON.parse(localStorage.getItem(key)) || defaultVal; }
        catch { return defaultVal; }
    },
    set(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
};

// ===== CACHE =====
let postsCache = null;
let settingsCache = null;

// ===== GITHUB API HELPERS =====
async function githubApi(path, options = {}) {
    if (!CONFIG.isConfigured) throw new Error('GitHub not configured');

    const url = CONFIG.apiBaseUrl + path;
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `token ${CONFIG.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `GitHub API error: ${res.status}`);
    }
    return res.json();
}

async function getFileSha(path) {
    try {
        const data = await githubApi(`/contents/${path}?ref=${CONFIG.branch}`);
        return data.sha;
    } catch (e) {
        return null; // File doesn't exist yet
    }
}

async function commitFile(path, content, message) {
    const sha = await getFileSha(path);
    const body = {
        message: message,
        content: btoa(unescape(encodeURIComponent(content))), // UTF-8 safe base64
        branch: CONFIG.branch
    };
    if (sha) body.sha = sha;

    return githubApi(`/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify(body)
    });
}

async function commitImage(path, base64Data, message) {
    const sha = await getFileSha(path);
    // Remove data:image/xxx;base64, prefix if present
    const cleanBase64 = base64Data.replace(/^data:image\/[^;]+;base64,/, '');

    const body = {
        message: message,
        content: cleanBase64,
        branch: CONFIG.branch
    };
    if (sha) body.sha = sha;

    return githubApi(`/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify(body)
    });
}

// ===== FETCH POSTS =====
async function fetchPosts() {
    if (postsCache) return postsCache;

    if (CONFIG.postsUrl) {
        try {
            const res = await fetch(CONFIG.postsUrl + '?t=' + Date.now());
            if (res.ok) {
                postsCache = await res.json();
                return postsCache;
            }
        } catch (e) {
            console.log('GitHub fetch failed, using localStorage');
        }
    }

    postsCache = Storage.get('blog_posts', []);
    return postsCache;
}

async function fetchSettings() {
    if (settingsCache) return settingsCache;

    if (CONFIG.settingsUrl) {
        try {
            const res = await fetch(CONFIG.settingsUrl + '?t=' + Date.now());
            if (res.ok) {
                settingsCache = await res.json();
                return settingsCache;
            }
        } catch (e) {
            console.log('GitHub settings fetch failed');
        }
    }

    settingsCache = Storage.get('blog_settings', {
        title: 'My Blog',
        description: 'Thoughts, stories, and ideas.',
        postsPerPage: 10,
        themeColor: 'blue'
    });
    return settingsCache;
}

function invalidateCache() {
    postsCache = null;
    settingsCache = null;
}

// ===== POST MANAGEMENT =====
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function getPost(id, posts) {
    return posts.find(p => p.id === id);
}

function generateExcerpt(blocks) {
    const textBlocks = blocks.filter(b => b.type === 'text');
    if (!textBlocks.length) return '';
    const text = textBlocks.map(b => b.content).join(' ');
    return text.length > 200 ? text.substring(0, 200) + '...' : text;
}

// ===== SAVE POST TO GITHUB =====
async function savePostToGitHub(event) {
    event.preventDefault();

    if (!CONFIG.isConfigured) {
        alert('Please configure GitHub credentials in the Setup tab first!');
        showSection('setup');
        return;
    }

    const saveBtn = event.target.querySelector('button[type="submit"]');
    const originalText = saveBtn.innerHTML;
    saveBtn.innerHTML = '⏳ Saving...';
    saveBtn.disabled = true;

    try {
        // 1. Fetch current posts from GitHub
        let posts = await fetchPosts();
        const id = document.getElementById('editingPostId').value;
        const blocks = collectBlocks();

        const postData = {
            id: id || generateId(),
            title: document.getElementById('postTitle').value,
            category: document.getElementById('postCategory').value || 'Uncategorized',
            status: document.getElementById('postStatus').value,
            featuredImage: document.getElementById('postImage').value,
            blocks: blocks,
            excerpt: generateExcerpt(blocks),
            createdAt: id ? (getPost(id, posts)?.createdAt || new Date().toISOString()) : new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        if (id) {
            const idx = posts.findIndex(p => p.id === id);
            if (idx >= 0) posts[idx] = postData;
            else posts.unshift(postData);
        } else {
            posts.unshift(postData);
        }

        // 2. Commit to GitHub
        await commitFile('posts.json', JSON.stringify(posts, null, 2), 
            id ? `Update post: ${postData.title}` : `Add post: ${postData.title}`);

        // 3. Update local cache
        postsCache = posts;
        Storage.set('blog_posts', posts);

        alert('✅ Post saved to GitHub! It will appear on your live blog in ~30 seconds.');
        showSection('posts');
        await renderAdminPosts();
        await updateAdminStats();
        resetEditor();

    } catch (err) {
        alert('❌ Error: ' + err.message);
        console.error(err);
    } finally {
        saveBtn.innerHTML = originalText;
        saveBtn.disabled = false;
    }
}

async function deletePostFromGitHub(id) {
    if (!confirm('Are you sure you want to delete this post from GitHub?')) return;
    if (!CONFIG.isConfigured) {
        alert('Please configure GitHub credentials first!');
        return;
    }

    try {
        let posts = await fetchPosts();
        const post = getPost(id, posts);
        posts = posts.filter(p => p.id !== id);

        await commitFile('posts.json', JSON.stringify(posts, null, 2), 
            `Delete post: ${post?.title || id}`);

        postsCache = posts;
        Storage.set('blog_posts', posts);

        alert('✅ Post deleted from GitHub!');
        await renderAdminPosts();
        await updateAdminStats();

    } catch (err) {
        alert('❌ Error: ' + err.message);
    }
}

// ===== IMAGE UPLOAD TO GITHUB =====
async function uploadImageToGitHub(event) {
    const files = event.target.files;
    if (!files.length) return;
    if (!CONFIG.isConfigured) {
        alert('Please configure GitHub credentials in the Setup tab first!');
        showSection('setup');
        event.target.value = '';
        return;
    }

    const container = document.getElementById('imageUploadStatus');
    container.innerHTML = '<p>⏳ Uploading images to GitHub...</p>';

    const uploadedUrls = [];

    for (const file of Array.from(files)) {
        try {
            const reader = new FileReader();
            await new Promise((resolve, reject) => {
                reader.onload = async (e) => {
                    try {
                        const filename = `images/${Date.now()}-${file.name.replace(/\s+/g, '-')}`;
                        await commitImage(filename, e.target.result, `Upload image: ${file.name}`);

                        const rawUrl = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${filename}`;
                        uploadedUrls.push({ name: file.name, url: rawUrl, filename });
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        } catch (err) {
            container.innerHTML += `<p style="color:#dc2626;">❌ Failed: ${file.name} — ${err.message}</p>`;
        }
    }

    // Store uploaded images
    const existing = Storage.get('blog_images', []);
    Storage.set('blog_images', [...existing, ...uploadedUrls]);

    // Show results
    container.innerHTML = uploadedUrls.map(img => `
        <div style="display:flex;align-items:center;gap:1rem;margin:0.5rem 0;padding:0.75rem;background:#f0fdf4;border-radius:6px;">
            <img src="${img.url}" style="width:60px;height:60px;object-fit:cover;border-radius:4px;">
            <div style="flex:1;">
                <div style="font-weight:500;">${escapeHtml(img.name)}</div>
                <code style="font-size:0.8rem;color:#64748b;">${img.url}</code>
            </div>
            <button class="btn btn-small btn-primary" onclick="useImageUrl('${img.url}')">Use</button>
        </div>
    `).join('') || '<p>No images uploaded.</p>';

    renderImageGallery();
    event.target.value = '';
}

function useImageUrl(url) {
    const imgInput = document.getElementById('postImage');
    if (imgInput) imgInput.value = url;
    // Also add as image block if in editor
    const container = document.getElementById('blocksContainer');
    if (container && !container.querySelector('.blocks-empty')) {
        // Add image block with this URL
        blockCounter++;
        const blockId = `block-${blockCounter}`;
        const blockEl = document.createElement('div');
        blockEl.className = 'block-editor';
        blockEl.dataset.blockId = blockId;
        blockEl.dataset.blockType = 'image';
        blockEl.innerHTML = `
            <div class="block-editor-header">
                <span class="block-type-label">image</span>
                <div class="block-editor-actions">
                    <button type="button" onclick="moveBlock('${blockId}', -1)">⬆️</button>
                    <button type="button" onclick="moveBlock('${blockId}', 1)">⬇️</button>
                    <button type="button" onclick="removeBlock('${blockId}')">❌</button>
                </div>
            </div>
            <input type="text" class="block-content" value="${escapeHtml(url)}">
            <input type="text" class="block-caption" style="margin-top:0.5rem;" placeholder="Caption (optional)...">
        `;
        container.appendChild(blockEl);
    }
}

function renderImageGallery() {
    const grid = document.getElementById('imageGallery');
    if (!grid) return;

    const images = Storage.get('blog_images', []);
    if (!images.length) {
        grid.innerHTML = '<p style="color:#64748b;">No images uploaded yet.</p>';
        return;
    }

    grid.innerHTML = images.map((img, idx) => `
        <div class="media-item">
            <img src="${img.url}" alt="${escapeHtml(img.name)}" onerror="this.parentElement.style.display='none'">
            <div class="media-item-info">
                <div style="font-size:0.75rem;word-break:break-all;">${escapeHtml(img.name)}</div>
                <button class="btn btn-small btn-primary" style="margin-top:0.5rem;width:100%;" onclick="useImageUrl('${img.url}')">Use in Post</button>
            </div>
        </div>
    `).join('');
}

// ===== GITHUB SETUP =====
function saveGitHubConfig(event) {
    event.preventDefault();
    localStorage.setItem('gh_owner', document.getElementById('ghOwner').value.trim());
    localStorage.setItem('gh_repo', document.getElementById('ghRepo').value.trim());
    localStorage.setItem('gh_token', document.getElementById('ghToken').value.trim());
    localStorage.setItem('gh_branch', document.getElementById('ghBranch').value.trim() || 'main');

    alert('✅ GitHub credentials saved! You can now publish posts directly.');
    updateSetupStatus();
}

function loadGitHubConfig() {
    const owner = document.getElementById('ghOwner');
    const repo = document.getElementById('ghRepo');
    const token = document.getElementById('ghToken');
    const branch = document.getElementById('ghBranch');

    if (owner) owner.value = CONFIG.owner;
    if (repo) repo.value = CONFIG.repo;
    if (token) token.value = CONFIG.token;
    if (branch) branch.value = CONFIG.branch || 'main';

    updateSetupStatus();
}

function updateSetupStatus() {
    const status = document.getElementById('setupStatus');
    if (!status) return;

    if (CONFIG.isConfigured) {
        status.innerHTML = `
            <div style="background:#f0fdf4;border-left:4px solid #16a34a;padding:1rem;border-radius:6px;">
                <strong>✅ GitHub is configured!</strong><br>
                Owner: <code>${CONFIG.owner}</code><br>
                Repo: <code>${CONFIG.repo}</code><br>
                Branch: <code>${CONFIG.branch}</code><br>
                You can now publish posts and upload images directly.
            </div>
        `;
    } else {
        status.innerHTML = `
            <div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:1rem;border-radius:6px;">
                <strong>⚠️ GitHub not configured</strong><br>
                Enter your credentials below to enable direct publishing.
            </div>
        `;
    }
}

function clearGitHubConfig() {
    localStorage.removeItem('gh_owner');
    localStorage.removeItem('gh_repo');
    localStorage.removeItem('gh_token');
    localStorage.removeItem('gh_branch');
    alert('GitHub credentials cleared.');
    updateSetupStatus();
}

// ===== BLOCKS EDITOR =====
let blockCounter = 0;

function addBlock(type) {
    const container = document.getElementById('blocksContainer');
    const emptyMsg = container.querySelector('.blocks-empty');
    if (emptyMsg) emptyMsg.remove();

    blockCounter++;
    const blockId = `block-${blockCounter}`;
    const blockEl = document.createElement('div');
    blockEl.className = 'block-editor';
    blockEl.dataset.blockId = blockId;
    blockEl.dataset.blockType = type;

    let innerHTML = `
        <div class="block-editor-header">
            <span class="block-type-label">${type}</span>
            <div class="block-editor-actions">
                <button type="button" onclick="moveBlock('${blockId}', -1)" title="Move up">⬆️</button>
                <button type="button" onclick="moveBlock('${blockId}', 1)" title="Move down">⬇️</button>
                <button type="button" onclick="removeBlock('${blockId}')" title="Remove">❌</button>
            </div>
        </div>
    `;

    switch(type) {
        case 'text':
            innerHTML += `<textarea placeholder="Write your text here..." class="block-content"></textarea>`;
            break;
        case 'heading':
            innerHTML += `<input type="text" placeholder="Heading text..." class="block-content">`;
            break;
        case 'image':
            innerHTML += `
                <input type="text" placeholder="Image URL..." class="block-content">
                <input type="text" placeholder="Caption (optional)..." class="block-caption" style="margin-top:0.5rem;">
            `;
            break;
        case 'box':
            innerHTML += `
                <select class="block-style" style="margin-bottom:0.5rem;">
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="success">Success</option>
                    <option value="danger">Danger</option>
                </select>
                <textarea placeholder="Box content..." class="block-content"></textarea>
            `;
            break;
        case 'quote':
            innerHTML += `<textarea placeholder="Quote text..." class="block-content"></textarea>`;
            break;
        case 'link':
            innerHTML += `
                <input type="text" placeholder="Link URL..." class="block-url" style="margin-bottom:0.5rem;">
                <input type="text" placeholder="Link text..." class="block-content">
            `;
            break;
        case 'code':
            innerHTML += `<textarea placeholder="Paste code here..." class="block-content" style="font-family:monospace;"></textarea>`;
            break;
        case 'divider':
            innerHTML += `<input type="hidden" class="block-content" value="divider">`;
            break;
        case 'list':
            innerHTML += `<textarea placeholder="Enter items (one per line)..." class="block-content"></textarea>`;
            break;
    }

    blockEl.innerHTML = innerHTML;
    container.appendChild(blockEl);
}

function removeBlock(id) {
    const el = document.querySelector(`[data-block-id="${id}"]`);
    if (el) el.remove();
    const container = document.getElementById('blocksContainer');
    if (!container.children.length) {
        container.innerHTML = '<p class="blocks-empty">Click buttons above to add content blocks</p>';
    }
}

function moveBlock(id, direction) {
    const el = document.querySelector(`[data-block-id="${id}"]`);
    if (!el) return;
    if (direction === -1 && el.previousElementSibling) {
        el.parentNode.insertBefore(el, el.previousElementSibling);
    } else if (direction === 1 && el.nextElementSibling) {
        el.parentNode.insertBefore(el.nextElementSibling, el);
    }
}

function collectBlocks() {
    const blocks = [];
    document.querySelectorAll('.block-editor').forEach(el => {
        const type = el.dataset.blockType;
        const content = el.querySelector('.block-content')?.value || '';
        const block = { type, content };

        if (type === 'image') block.caption = el.querySelector('.block-caption')?.value || '';
        if (type === 'box') block.style = el.querySelector('.block-style')?.value || 'info';
        if (type === 'link') block.url = el.querySelector('.block-url')?.value || '#';

        blocks.push(block);
    });
    return blocks;
}

function loadBlocksIntoEditor(blocks) {
    const container = document.getElementById('blocksContainer');
    container.innerHTML = '';

    blocks.forEach(block => {
        blockCounter++;
        const blockId = `block-${blockCounter}`;
        const blockEl = document.createElement('div');
        blockEl.className = 'block-editor';
        blockEl.dataset.blockId = blockId;
        blockEl.dataset.blockType = block.type;

        let innerHTML = `
            <div class="block-editor-header">
                <span class="block-type-label">${block.type}</span>
                <div class="block-editor-actions">
                    <button type="button" onclick="moveBlock('${blockId}', -1)">⬆️</button>
                    <button type="button" onclick="moveBlock('${blockId}', 1)">⬇️</button>
                    <button type="button" onclick="removeBlock('${blockId}')">❌</button>
                </div>
            </div>
        `;

        switch(block.type) {
            case 'text':
                innerHTML += `<textarea class="block-content">${escapeHtml(block.content)}</textarea>`;
                break;
            case 'heading':
                innerHTML += `<input type="text" class="block-content" value="${escapeHtml(block.content)}">`;
                break;
            case 'image':
                innerHTML += `
                    <input type="text" class="block-content" value="${escapeHtml(block.content)}">
                    <input type="text" class="block-caption" style="margin-top:0.5rem;" value="${escapeHtml(block.caption || '')}">
                `;
                break;
            case 'box':
                innerHTML += `
                    <select class="block-style" style="margin-bottom:0.5rem;">
                        <option value="info" ${block.style==='info'?'selected':''}>Info</option>
                        <option value="warning" ${block.style==='warning'?'selected':''}>Warning</option>
                        <option value="success" ${block.style==='success'?'selected':''}>Success</option>
                        <option value="danger" ${block.style==='danger'?'selected':''}>Danger</option>
                    </select>
                    <textarea class="block-content">${escapeHtml(block.content)}</textarea>
                `;
                break;
            case 'quote':
                innerHTML += `<textarea class="block-content">${escapeHtml(block.content)}</textarea>`;
                break;
            case 'link':
                innerHTML += `
                    <input type="text" class="block-url" style="margin-bottom:0.5rem;" value="${escapeHtml(block.url || '#')}">
                    <input type="text" class="block-content" value="${escapeHtml(block.content)}">
                `;
                break;
            case 'code':
                innerHTML += `<textarea class="block-content" style="font-family:monospace;">${escapeHtml(block.content)}</textarea>`;
                break;
            case 'divider':
                innerHTML += `<input type="hidden" class="block-content" value="divider">`;
                break;
            case 'list':
                innerHTML += `<textarea class="block-content">${escapeHtml(block.content)}</textarea>`;
                break;
        }

        blockEl.innerHTML = innerHTML;
        container.appendChild(blockEl);
    });
}

// ===== RENDERING =====
function renderBlock(block) {
    switch(block.type) {
        case 'text':
            return `<div class="block-text">${escapeHtml(block.content).replace(/\n/g, '<br>')}</div>`;
        case 'heading':
            return `<h2 class="block-heading">${escapeHtml(block.content)}</h2>`;
        case 'image':
            return `<div class="block-image"><img src="${escapeHtml(block.content)}" alt="${escapeHtml(block.caption || '')}" onerror="this.style.display='none'"><div class="caption">${escapeHtml(block.caption || '')}</div></div>`;
        case 'box':
            return `<div class="block-box ${block.style || 'info'}">${escapeHtml(block.content).replace(/\n/g, '<br>')}</div>`;
        case 'quote':
            return `<blockquote class="block-quote">${escapeHtml(block.content).replace(/\n/g, '<br>')}</blockquote>`;
        case 'link':
            return `<a href="${escapeHtml(block.url || '#')}" class="block-link" target="_blank">🔗 ${escapeHtml(block.content || 'Link')}</a>`;
        case 'code':
            return `<pre class="block-code">${escapeHtml(block.content)}</pre>`;
        case 'divider':
            return `<hr class="block-divider">`;
        case 'list':
            const items = block.content.split('\n').filter(i => i.trim());
            return `<ul class="block-list">${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
        default:
            return '';
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function renderPosts(filter = null, searchQuery = '') {
    const container = document.getElementById('postsContainer');
    if (!container) return;

    container.innerHTML = '<div class="loading">Loading posts...</div>';

    let posts = await fetchPosts();
    posts = posts.filter(p => p.status === 'published');

    if (filter) posts = posts.filter(p => p.category === filter);
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        posts = posts.filter(p => 
            p.title.toLowerCase().includes(q) || 
            (p.excerpt || '').toLowerCase().includes(q) ||
            p.category.toLowerCase().includes(q)
        );
    }

    if (!posts.length) {
        container.innerHTML = '<div class="post-card"><p>No posts found.</p></div>';
        return;
    }

    container.innerHTML = posts.map(post => `
        <article class="post-card">
            ${post.featuredImage ? `<img src="${escapeHtml(post.featuredImage)}" alt="${escapeHtml(post.title)}" onerror="this.style.display='none'">` : ''}
            <div class="post-meta">
                <span class="post-category">${escapeHtml(post.category)}</span>
                <span>📅 ${formatDate(post.createdAt)}</span>
            </div>
            <h2 onclick="viewPost('${post.id}')">${escapeHtml(post.title)}</h2>
            <p class="post-excerpt">${escapeHtml(post.excerpt || '')}</p>
            <a href="#" class="read-more" onclick="viewPost('${post.id}'); return false;">Read more →</a>
        </article>
    `).join('');
}

async function viewPost(id) {
    const posts = await fetchPosts();
    const post = getPost(id, posts);
    if (!post) return;

    const container = document.getElementById('postsContainer');
    const blocksHtml = post.blocks.map(renderBlock).join('');

    container.innerHTML = `
        <div class="single-post">
            <a href="#" class="back-btn" onclick="renderPosts(); return false;">← Back to all posts</a>
            <div class="post-header">
                ${post.featuredImage ? `<img src="${escapeHtml(post.featuredImage)}" alt="${escapeHtml(post.title)}" style="width:100%;border-radius:12px;margin-bottom:1.5rem;" onerror="this.style.display='none'">` : ''}
                <div class="post-meta">
                    <span class="post-category">${escapeHtml(post.category)}</span>
                    <span>📅 ${formatDate(post.createdAt)}</span>
                    <span>🕒 ${formatDate(post.updatedAt)}</span>
                </div>
                <h1>${escapeHtml(post.title)}</h1>
            </div>
            <div class="post-content">
                ${blocksHtml}
            </div>
        </div>
    `;
    window.scrollTo(0, 0);
}

async function renderCategories() {
    const list = document.getElementById('categoryList');
    if (!list) return;

    const posts = await fetchPosts();
    const published = posts.filter(p => p.status === 'published');
    const categories = {};
    published.forEach(p => { categories[p.category] = (categories[p.category] || 0) + 1; });

    list.innerHTML = Object.entries(categories).map(([cat, count]) => 
        `<li onclick="renderPosts('${escapeHtml(cat)}')">${escapeHtml(cat)} (${count})</li>`
    ).join('') || '<li>No categories</li>';
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

async function updateStats() {
    const el = document.getElementById('blogStats');
    if (!el) return;
    const posts = await fetchPosts();
    const published = posts.filter(p => p.status === 'published');
    const cats = new Set(published.map(p => p.category));
    el.innerHTML = `${published.length} posts<br>${cats.size} categories`;
}

function searchPosts() {
    const query = document.getElementById('searchInput')?.value || '';
    renderPosts(null, query);
}

// ===== ADMIN FUNCTIONS =====
function showSection(section) {
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.admin-nav').forEach(n => n.classList.remove('active'));

    const target = document.getElementById(section + '-section');
    if (target) target.classList.add('active');

    const nav = document.querySelector(`a[href="#${section}"]`);
    if (nav) nav.classList.add('active');
}

async function renderAdminPosts() {
    const container = document.getElementById('adminPostsList');
    if (!container) return;

    let posts = await fetchPosts();
    const filter = document.getElementById('adminSearch')?.value.toLowerCase() || '';

    if (filter) {
        posts = posts.filter(p => 
            p.title.toLowerCase().includes(filter) ||
            p.category.toLowerCase().includes(filter)
        );
    }

    if (!posts.length) {
        container.innerHTML = '<p>No posts found.</p>';
        return;
    }

    container.innerHTML = posts.map(post => `
        <div class="admin-post-item">
            <div class="admin-post-info">
                <h4>${escapeHtml(post.title)}</h4>
                <div class="admin-post-meta">
                    <span class="status-badge status-${post.status}">${post.status}</span>
                    <span>${escapeHtml(post.category)}</span>
                    <span>📅 ${formatDate(post.createdAt)}</span>
                </div>
            </div>
            <div class="admin-post-actions">
                <button class="btn btn-small btn-secondary" onclick="editPost('${post.id}')">Edit</button>
                <button class="btn btn-small btn-danger" onclick="deletePostFromGitHub('${post.id}')">Delete</button>
            </div>
        </div>
    `).join('');
}

function filterAdminPosts() {
    renderAdminPosts();
}

async function editPost(id) {
    const posts = await fetchPosts();
    const post = getPost(id, posts);
    if (!post) return;

    document.getElementById('editingPostId').value = post.id;
    document.getElementById('postTitle').value = post.title;
    document.getElementById('postCategory').value = post.category;
    document.getElementById('postStatus').value = post.status;
    document.getElementById('postImage').value = post.featuredImage || '';
    document.getElementById('editorTitle').textContent = 'Edit Post';
    document.getElementById('deleteBtn').style.display = 'inline-flex';

    loadBlocksIntoEditor(post.blocks);
    showSection('editor');
}

function resetEditor() {
    document.getElementById('postForm').reset();
    document.getElementById('editingPostId').value = '';
    document.getElementById('editorTitle').textContent = 'New Post';
    document.getElementById('deleteBtn').style.display = 'none';
    document.getElementById('blocksContainer').innerHTML = '<p class="blocks-empty">Click buttons above to add content blocks</p>';
}

async function updateAdminStats() {
    const posts = await fetchPosts();
    const published = posts.filter(p => p.status === 'published').length;
    const drafts = posts.filter(p => p.status === 'draft').length;

    const totalEl = document.getElementById('totalPosts');
    const pubEl = document.getElementById('publishedPosts');
    const draftEl = document.getElementById('draftPosts');

    if (totalEl) totalEl.textContent = posts.length;
    if (pubEl) pubEl.textContent = published;
    if (draftEl) draftEl.textContent = drafts;
}

// ===== SETTINGS =====
async function loadSettings() {
    const settings = await fetchSettings();
    const titleEl = document.getElementById('blogTitle');
    const descEl = document.getElementById('blogDescription');
    const pppEl = document.getElementById('postsPerPage');
    const themeEl = document.getElementById('themeColor');

    if (titleEl) titleEl.value = settings.title || 'My Blog';
    if (descEl) descEl.value = settings.description || 'Thoughts, stories, and ideas.';
    if (pppEl) pppEl.value = settings.postsPerPage || 10;
    if (themeEl) themeEl.value = settings.themeColor || 'blue';

    applyTheme(settings.themeColor || 'blue');

    const heroTitle = document.querySelector('.hero h1');
    const heroDesc = document.querySelector('.hero p');
    if (heroTitle) heroTitle.textContent = settings.title || 'Welcome to My Blog';
    if (heroDesc) heroDesc.textContent = settings.description || 'Thoughts, stories, and ideas.';
}

async function saveSettings(event) {
    event.preventDefault();
    const settings = {
        title: document.getElementById('blogTitle').value,
        description: document.getElementById('blogDescription').value,
        postsPerPage: parseInt(document.getElementById('postsPerPage').value) || 10,
        themeColor: document.getElementById('themeColor').value
    };

    if (CONFIG.isConfigured) {
        try {
            await commitFile('settings.json', JSON.stringify(settings, null, 2), 'Update blog settings');
            alert('✅ Settings saved to GitHub!');
        } catch (err) {
            alert('❌ Error saving to GitHub: ' + err.message);
            return;
        }
    } else {
        Storage.set('blog_settings', settings);
        alert('✅ Settings saved locally!');
    }

    applyTheme(settings.themeColor);
    invalidateCache();
}

function applyTheme(color) {
    const root = document.documentElement;
    const themes = {
        blue: { primary: '#2563eb', primaryDark: '#1d4ed8' },
        green: { primary: '#16a34a', primaryDark: '#15803d' },
        purple: { primary: '#9333ea', primaryDark: '#7e22ce' },
        dark: { primary: '#475569', primaryDark: '#334155' }
    };
    const t = themes[color] || themes.blue;
    root.style.setProperty('--primary', t.primary);
    root.style.setProperty('--primary-dark', t.primaryDark);
}

function clearAllData() {
    if (!confirm('WARNING: This will clear all local data. Continue?')) return;
    localStorage.removeItem('blog_posts');
    localStorage.removeItem('blog_settings');
    localStorage.removeItem('blog_images');
    alert('Local data cleared. Refreshing...');
    location.reload();
}
