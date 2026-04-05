(() => {
"use strict";
const TOKEN_KEY = "gwiki_token_v2";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  me: null,
  view: "home",       // home | category | article
  categories: [],
  currentCat: null,   // { id, slug, name, description, articles: [] }
  currentArticle: null,
  comments: [],
  pendingArticles: [],
  modal: null,        // null | "auth" | "newcat" | "newarticle" | "pending" | "profile" | "roles"
  authTab: "login",
  likes: {},          // key: "article:id" | "category:id" → { count, liked }
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const gwContent  = document.getElementById("gwContent");
const gwSidebar  = document.getElementById("gwSidebar");
const gwCatList  = document.getElementById("gwCatList");
const gwAdminSidebar = document.getElementById("gwAdminSidebar");
const gwAuthBar  = document.getElementById("gwAuthBar");
const gwModal    = document.getElementById("gwModal");
const gwModalBg  = document.getElementById("gwModalBackdrop");
const gwModalContent = document.getElementById("gwModalContent");
const gwModalClose   = document.getElementById("gwModalClose");

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  if (location.protocol === "file:") {
    gwContent.innerHTML = `
      <div style="padding:2rem;background:rgba(201,96,96,0.1);border:1px solid rgba(201,96,96,0.3);border-radius:12px;margin-top:1rem">
        <p style="margin:0 0 .5rem;font-weight:600;color:#e88;font-size:1rem">Gwiki открыта как файл</p>
        <p style="margin:0;color:var(--muted);font-size:.9rem">
          Открой через сервер:<br>
          <a href="http://localhost:3000/wiki-app/index.html" style="color:#7ab8e8">http://localhost:3000/wiki-app/index.html</a>
        </p>
      </div>
    `;
    return;
  }
  await Promise.all([loadMe(), loadCategories()]);
  renderAuthBar();
  renderSidebarCats();
  renderAdminSidebar();
  handleHash();
  bindGlobal();
  bindSearch();
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = "Bearer " + state.token;

  // Если открыто как file://, показываем понятную ошибку
  if (location.protocol === "file:") {
    throw new Error("Gwiki нужно открывать через сервер: http://localhost:3000/wiki-app/index.html");
  }

  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function loadMe() {
  if (!state.token) return;
  try {
    const d = await api("/api/me");
    state.me = d.user;
  } catch (e) {
    state.token = "";
    state.me = null;
    localStorage.removeItem(TOKEN_KEY);
    // не выбрасываем — просто сбрасываем сессию
  }
}

async function loadCategories() {
  try {
    const d = await api("/api/wiki/categories");
    state.categories = d.categories || [];
  } catch { state.categories = []; }
}

// ── Hash Routing ──────────────────────────────────────────────────────────────
function parseHash() {
  const h = location.hash.slice(1);
  const [type, value] = h.split("/");
  return { type: type || "", value: value || "" };
}

function handleHash() {
  const { type, value } = parseHash();
  if (type === "category" && value) navCategory(value);
  else if (type === "article" && value) navArticleById(Number(value));
  else renderHome();
}

window.addEventListener("hashchange", handleHash);

async function navArticleById(id) {
  gwContent.innerHTML = `<p class="gw-muted">Загрузка…</p>`;
  try {
    const d = await api("/api/wiki/articles/" + id);
    const art = d.article;
    // Загружаем категорию если нужно
    if (!state.currentCat || state.currentCat.slug !== art.category_slug) {
      await loadCategoryArticles(art.category_slug);
    }
    state.currentArticle = art;
    state.view = "article";
    await loadArticleComments(id);
    await loadLikes("article", id);
    renderArticle();
  } catch {
    gwContent.innerHTML = `<p class="gw-muted">Статья не найдена.</p>`;
  }
}

async function loadCategoryArticles(slug) {
  const d = await api("/api/wiki/categories/" + slug + "/articles");
  state.currentCat = { ...d.category, articles: d.articles || [] };
}

async function loadArticleComments(id) {
  const d = await api("/api/wiki/articles/" + id + "/comments");
  state.comments = d.comments || [];
}

async function loadPending() {
  try {
    const d = await api("/api/wiki/articles/pending");
    state.pendingArticles = d.articles || [];
  } catch { state.pendingArticles = []; }
}

async function loadLikes(targetType, targetId) {
  const key = targetType + ":" + targetId;
  try {
    const d = await api("/api/wiki/likes?target_type=" + targetType + "&target_id=" + targetId);
    state.likes[key] = { count: d.count || 0, liked: !!d.liked };
  } catch {
    state.likes[key] = { count: 0, liked: false };
  }
}

async function toggleLike(targetType, targetId) {
  if (!state.me) { openModal("auth", "login"); return; }
  const key = targetType + ":" + targetId;
  const prev = state.likes[key] || { count: 0, liked: false };
  // Optimistic UI
  const optimistic = prev.liked
    ? { count: Math.max(0, prev.count - 1), liked: false }
    : { count: prev.count + 1, liked: true };
  state.likes[key] = optimistic;
  updateLikeBtn(targetType, targetId);
  try {
    const d = await api("/api/wiki/likes", {
      method: "POST",
      body: JSON.stringify({ target_type: targetType, target_id: targetId }),
    });
    state.likes[key] = { count: d.count || 0, liked: !!d.liked };
    updateLikeBtn(targetType, targetId);
  } catch {
    // Rollback
    state.likes[key] = prev;
    updateLikeBtn(targetType, targetId);
  }
}

function updateLikeBtn(targetType, targetId) {
  const key = targetType + ":" + targetId;
  const info = state.likes[key] || { count: 0, liked: false };
  const btn = document.querySelector(`.gw-like-btn[data-type="${targetType}"][data-id="${targetId}"]`);
  if (!btn) return;
  btn.classList.toggle("is-liked", info.liked);
  const counter = btn.querySelector(".gw-like-btn__count");
  if (counter) counter.textContent = info.count;
}

function likeButtonHtml(targetType, targetId) {
  const key = targetType + ":" + targetId;
  const info = state.likes[key] || { count: 0, liked: false };
  const title = state.me ? "Лайк" : "Войдите, чтобы поставить лайк";
  return `<button class="gw-like-btn${info.liked ? " is-liked" : ""}" data-type="${targetType}" data-id="${targetId}" title="${title}">
    ♥ <span class="gw-like-btn__count">${info.count}</span>
  </button>`;
}

// ── Escape ────────────────────────────────────────────────────────────────────
function esc(v) {
  return String(v || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Рендерит HTML из редактора, убирая опасные теги
function sanitizeBody(html) {
  if (!html) return "";
  // Если plain text (нет тегов) — конвертируем переносы
  if (!html.includes("<")) return html.replace(/\n/g, "<br>");
  // Убираем script/iframe/on-события
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/javascript:/gi, "");
}

// ── Render: Auth Bar ──────────────────────────────────────────────────────────
function renderAuthBar() {
  if (!gwAuthBar) return;
  if (state.me) {
    gwAuthBar.innerHTML = `
      <div class="gw-user-menu" id="gwUserMenu">
        <button class="gw-user-menu__trigger" id="gwUserMenuTrigger" aria-haspopup="true" aria-expanded="false">
          <span class="gw-user-menu__nick">${esc(state.me.nickname)}</span>
          <span class="gw-user-menu__arrow">▾</span>
        </button>
        <div class="gw-user-menu__dropdown" id="gwUserMenuDropdown" hidden>
          <a class="gw-user-menu__item" href="user.html?id=${state.me.id}" target="_blank" rel="noopener">
            <span class="gw-user-menu__item-icon">👤</span> Профиль
          </a>
          <button class="gw-user-menu__item" id="gwOpenProfile">
            <span class="gw-user-menu__item-icon">⚙️</span> Настройки
          </button>
          <button class="gw-user-menu__item" id="gwSwitchAccount">
            <span class="gw-user-menu__item-icon">🔄</span> Сменить аккаунт
          </button>
          <div class="gw-user-menu__divider"></div>
          <button class="gw-user-menu__item gw-user-menu__item--danger" id="gwLogout">
            <span class="gw-user-menu__item-icon">⏻</span> Выйти
          </button>
        </div>
      </div>
    `;
    // Открытие/закрытие дропдауна
    const trigger = document.getElementById("gwUserMenuTrigger");
    const dropdown = document.getElementById("gwUserMenuDropdown");
    trigger.addEventListener("click", e => {
      e.stopPropagation();
      const open = !dropdown.hidden;
      dropdown.hidden = open;
      trigger.setAttribute("aria-expanded", String(!open));
    });
    document.addEventListener("click", function closeMenu(e) {
      if (!document.getElementById("gwUserMenu")?.contains(e.target)) {
        dropdown.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        document.removeEventListener("click", closeMenu);
      }
    });
  } else {
    gwAuthBar.innerHTML = `
      <button class="gw-btn gw-btn--ghost gw-btn--sm" id="gwOpenLogin">Войти</button>
      <button class="gw-btn gw-btn--primary gw-btn--sm" id="gwOpenRegister">Регистрация</button>
    `;
  }
  document.getElementById("gwOpenLogin")?.addEventListener("click", () => openModal("auth", "login"));
  document.getElementById("gwOpenRegister")?.addEventListener("click", () => openModal("auth", "register"));
  document.getElementById("gwOpenProfile")?.addEventListener("click", () => { document.getElementById("gwUserMenuDropdown").hidden = true; openModal("profile"); });
  document.getElementById("gwSwitchAccount")?.addEventListener("click", () => { document.getElementById("gwUserMenuDropdown").hidden = true; openModal("switchaccount"); });
  document.getElementById("gwLogout")?.addEventListener("click", async () => {
    try { await api("/api/logout", { method: "POST" }); } catch {}
    // Убираем текущий аккаунт из saved accounts
    removeSavedAccount(state.token);
    state.token = ""; state.me = null;
    localStorage.removeItem(TOKEN_KEY);
    renderAuthBar();
    renderAdminSidebar();
  });
}

// ── Render: Sidebar cats ──────────────────────────────────────────────────────
function renderSidebarCats() {
  if (!gwCatList) return;
  if (!state.categories.length) {
    gwCatList.innerHTML = '<li class="gw-muted">Нет категорий</li>';
    return;
  }
  gwCatList.innerHTML = state.categories.map(c => `
    <li><a href="#" class="gw-cat-link ${state.currentCat?.id === c.id ? 'is-active' : ''}" data-slug="${esc(c.slug)}">${esc(c.name)}</a></li>
  `).join("");
  gwCatList.querySelectorAll(".gw-cat-link").forEach(a => {
    a.addEventListener("click", e => { e.preventDefault(); navCategory(a.dataset.slug); });
  });
}

function renderAdminSidebar() {
  if (!gwAdminSidebar) return;
  const isAdmin = state.me?.canManageUsers;
  gwAdminSidebar.style.display = isAdmin ? "" : "none";
  if (!isAdmin) return;
  // Загружаем pending чтобы показать актуальный счётчик
  loadPending().then(() => {
    const cnt = document.getElementById("gwPendingCount");
    if (cnt) cnt.textContent = state.pendingArticles.length || "";
  });
  document.getElementById("gwOpenPending")?.addEventListener("click", e => { e.preventDefault(); openModal("pending"); });
  document.getElementById("gwOpenNewCat")?.addEventListener("click", e => { e.preventDefault(); openModal("newcat"); });
  // Управление ролями — только для owner, ведёт на отдельную страницу
  const rolesLink = document.getElementById("gwOpenRoles");
  if (rolesLink) {
    rolesLink.style.display = state.me?.role === "owner" ? "" : "none";
  }
}

// ── Views ─────────────────────────────────────────────────────────────────────
async function renderHome() {
  state.view = "home";
  state.currentCat = null;
  state.currentArticle = null;
  renderSidebarCats();
  const cats = state.categories;
  // Загружаем лайки для всех категорий ПЕРЕД рендером
  await Promise.all(cats.map(c => loadLikes("category", c.id)));
  gwContent.innerHTML = `
    <div class="gw-home-hero">
      <h1><span style="color:var(--accent)">G</span>wiki</h1>
      <p>Независимая вики. Читайте статьи, предлагайте свои — всё проходит модерацию владельцев.</p>
    </div>
    <h2 class="gw-section-title" id="categories">Категории</h2>
    ${cats.length ? `
      <div class="gw-cat-grid">
        ${cats.map(c => `
          <a href="#" class="gw-cat-card gw-cat-link" data-slug="${esc(c.slug)}">
            <div class="gw-cat-card__name">${esc(c.name)}</div>
            <div class="gw-cat-card__desc">${esc(c.description) || '<span style="opacity:.5">Без описания</span>'}</div>
            <div class="gw-cat-card__footer">
              <div class="gw-cat-card__count">${c.article_count} ${plural(c.article_count, "статья","статьи","статей")}</div>
              ${likeButtonHtml("category", c.id)}
            </div>
          </a>
        `).join("")}
      </div>
    ` : `<p class="gw-muted">Категорий пока нет. Администратор может создать первую.</p>`}
  `;
  gwContent.querySelectorAll(".gw-cat-link").forEach(a => {
    a.addEventListener("click", e => { e.preventDefault(); navCategory(a.dataset.slug); });
  });
  gwContent.querySelectorAll(".gw-like-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      toggleLike(btn.dataset.type, Number(btn.dataset.id));
    });
  });
}

async function navCategory(slug) {
  history.replaceState(null, "", "#category/" + slug);
  gwContent.innerHTML = `<p class="gw-muted">Загрузка…</p>`;
  try {
    await loadCategoryArticles(slug);
  } catch {
    gwContent.innerHTML = `<p class="gw-muted">Не удалось загрузить категорию.</p>`;
    return;
  }
  state.view = "category";
  renderSidebarCats();
  const cat = state.currentCat;
  // Только postmaker+ могут создавать статьи (не просто user)
  const canSubmit = state.me && state.me.canCreateThreads;
  const canDeleteCat = state.me?.canManageUsers || state.me?.id === cat.created_by;
  gwContent.innerHTML = `
    <div style="margin-bottom:1rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
      <a href="#" id="gwBackHome" class="gw-btn gw-btn--ghost gw-btn--sm">← Все категории</a>
      ${canDeleteCat ? `<button class="gw-btn gw-btn--danger gw-btn--sm" id="gwDeleteCat">Удалить категорию</button>` : ""}
    </div>
    <div class="gw-article-view" style="margin-bottom:1rem">
      <h1 class="gw-article-view__title">${esc(cat.name)}</h1>
      ${cat.description ? `<p style="color:var(--muted);margin:0 0 0.5rem">${esc(cat.description)}</p>` : ""}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem">
      <h2 class="gw-section-title" style="margin:0;border:none">Статьи</h2>
      ${canSubmit ? `<button class="gw-btn gw-btn--primary gw-btn--sm" id="gwNewArticleBtn">+ Написать статью</button>` : ""}
    </div>
    <div class="gw-article-list" id="gwArticleList">
      ${cat.articles.length ? cat.articles.map(a => `
        <div class="gw-article-item" data-id="${a.id}">
          <div class="gw-article-item__title">${esc(a.title)}</div>
          <div class="gw-article-item__meta">${esc(a.author_nickname)} · ${fmtDate(a.updated_at)}</div>
          <div class="gw-article-item__preview">${esc(a.body)}</div>
        </div>
      `).join("") : `<p class="gw-empty">В этой категории пока нет статей.</p>`}
    </div>
  `;
  document.getElementById("gwBackHome")?.addEventListener("click", e => { e.preventDefault(); renderHome(); });
  document.getElementById("gwNewArticleBtn")?.addEventListener("click", () => {
    window.location.href = '/wiki-app/editor.html?mode=new&category_id=' + cat.id;
  });
  document.getElementById("gwDeleteCat")?.addEventListener("click", async () => {
    if (!confirm(`Удалить категорию «${cat.name}» и все её статьи?`)) return;
    try {
      await api("/api/wiki/categories/" + cat.id, { method: "DELETE" });
      await loadCategories();
      renderSidebarCats();
      renderHome();
    } catch (err) { alert(err.message); }
  });
  gwContent.querySelectorAll(".gw-article-item").forEach(el => {
    el.addEventListener("click", () => navArticle(Number(el.dataset.id)));
  });
}

async function navArticle(id) {
  history.replaceState(null, "", "#article/" + id);
  const art = state.currentCat?.articles.find(a => a.id === id);
  if (!art) return;
  state.currentArticle = art;
  state.view = "article";
  await loadArticleComments(id);
  await loadLikes("article", id);
  renderArticle();
}

function renderArticle() {
  const art = state.currentArticle;
  const cat = state.currentCat;
  const isAdmin = state.me?.canManageUsers;
  const isAuthor = state.me?.id === art.author_id;
  const canEdit = isAdmin || isAuthor;
  const canComment = state.me?.canComment;
  const canDeleteComment = (c) => state.me && (state.me.id === c.author_id || state.me.canManageUsers || state.me.canDeleteComments);
  gwContent.innerHTML = `
    <div class="gw-article-view">
      <div class="gw-article-view__breadcrumb">
        <a href="#" id="gwBackHome2">Главная</a> /
        <a href="#" id="gwBackCat">${esc(cat?.name || "")}</a> /
        ${esc(art.title)}
      </div>
      <h1 class="gw-article-view__title">${esc(art.title)}</h1>
      <div class="gw-article-view__meta">
        Автор: <a href="user.html?id=${art.author_id}">${esc(art.author_nickname)}</a> ·
        ${fmtDate(art.updated_at)}
      </div>
      ${art.image_url ? `<img class="gw-article-view__image" src="${esc(art.image_url)}" alt="" loading="lazy">` : ""}
      <div class="gw-article-view__body">${sanitizeBody(art.body)}</div>
      <div class="gw-article-view__like-row">
        ${likeButtonHtml("article", art.id)}
      </div>
      ${canEdit ? `
        <div class="gw-article-view__actions">
          <button class="gw-btn gw-btn--sm" id="gwEditArticle">Редактировать</button>
          <button class="gw-btn gw-btn--danger gw-btn--sm" id="gwDeleteArticle">Удалить</button>
        </div>
      ` : ""}

      <div class="gw-comments">
        <h3 class="gw-comments__title">Обсуждение</h3>
        <div id="gwCommentsList">
          ${state.comments.length ? state.comments.map(c => `
            <div class="gw-comment" data-comment-id="${c.id}">
              <div class="gw-comment__meta">
                <a href="user.html?id=${c.author_id}">${esc(c.author_nickname)}</a> · ${fmtDate(c.created_at)}
                ${canDeleteComment(c) ? `<button class="gw-btn gw-btn--danger gw-btn--sm gw-comment__delete" data-id="${c.id}" style="margin-left:.5rem;padding:.1rem .4rem;font-size:.72rem">Удалить</button>` : ""}
              </div>
              <div class="gw-comment__body">${esc(c.body)}</div>
            </div>
          `).join("") : `<p class="gw-muted">Комментариев пока нет.</p>`}
        </div>
        ${canComment ? `
          <form class="gw-form" id="gwCommentForm" style="margin-top:1rem">
            <textarea name="body" rows="3" placeholder="Ваш комментарий…" required></textarea>
            <div><button type="submit" class="gw-btn gw-btn--primary gw-btn--sm">Отправить</button></div>
          </form>
        ` : state.me ? `<p class="gw-muted" style="margin-top:.75rem">Ваша роль не позволяет комментировать.</p>`
                     : `<div style="margin-top:.75rem;padding:.65rem .9rem;background:rgba(91,155,213,0.07);border:1px solid rgba(91,155,213,0.2);border-radius:8px;font-size:.875rem">
                          Чтобы комментировать — <button class="gw-btn gw-btn--primary gw-btn--sm" id="gwCommentLogin">Войти</button> или <button class="gw-btn gw-btn--ghost gw-btn--sm" id="gwCommentRegister">Зарегистрироваться</button>
                        </div>`}
      </div>
    </div>
  `;
  document.getElementById("gwBackHome2")?.addEventListener("click", e => { e.preventDefault(); renderHome(); });
  document.getElementById("gwBackCat")?.addEventListener("click", e => { e.preventDefault(); navCategory(cat.slug); });
  document.getElementById("gwCommentLogin")?.addEventListener("click", () => openModal("auth", "login"));
  document.getElementById("gwCommentRegister")?.addEventListener("click", () => openModal("auth", "register"));
  document.getElementById("gwEditArticle")?.addEventListener("click", () => {
    window.location.href = '/wiki-app/editor.html?mode=edit&article_id=' + art.id;
  });
  document.getElementById("gwDeleteArticle")?.addEventListener("click", async () => {
    if (!confirm("Удалить статью?")) return;
    try {
      await api("/api/wiki/articles/" + art.id, { method: "DELETE" });
      await loadCategoryArticles(cat.slug);
      navCategory(cat.slug);
    } catch (err) { alert(err.message); }
  });
  // Лайк статьи
  gwContent.querySelectorAll(".gw-like-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleLike(btn.dataset.type, Number(btn.dataset.id)));
  });
  // Удаление комментариев
  gwContent.querySelectorAll(".gw-comment__delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Удалить комментарий?")) return;
      try {
        await api("/api/wiki/articles/" + art.id + "/comments/" + btn.dataset.id, { method: "DELETE" });
        state.comments = state.comments.filter(c => c.id !== Number(btn.dataset.id));
        renderArticle();
      } catch (err) { alert(err.message); }
    });
  });
  document.getElementById("gwCommentForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const d = await api("/api/wiki/articles/" + art.id + "/comments", {
        method: "POST",
        body: JSON.stringify({ body: String(fd.get("body") || "").trim() }),
      });
      state.comments = d.comments;
      renderArticle();
    } catch (err) { alert(err.message); }
  });
}

// ── Modals ────────────────────────────────────────────────────────────────────
function openModal(type, tab) {
  state.modal = type;
  if (tab) state.authTab = tab;
  gwModal.classList.add("is-open");
  gwModalBg.classList.add("is-open");
  renderModal();
}

function closeModal() {
  state.modal = null;
  gwModal.classList.remove("is-open");
  gwModalBg.classList.remove("is-open");
  gwModalContent.innerHTML = "";
}

function renderModal() {
  switch (state.modal) {
    case "auth":          renderAuthModal(); break;
    case "profile":       renderProfileModal(); break;
    case "newcat":        renderNewCatModal(); break;
    case "newarticle":    renderNewArticleModal(); break;
    case "editarticle":   renderEditArticleModal(); break;
    case "pending":       renderPendingModal(); break;
    case "roles":         renderRolesModal(); break;
    case "switchaccount": renderSwitchAccountModal(); break;
  }
}

function renderAuthModal() {
  const isLogin = state.authTab === "login";
  gwModalContent.innerHTML = `
    <h2 class="gw-modal__title">${isLogin ? "Вход" : "Регистрация"}</h2>
    <div class="gw-tabs">
      <button class="gw-tab ${isLogin ? "is-active" : ""}" id="gwTabLogin">Вход</button>
      <button class="gw-tab ${!isLogin ? "is-active" : ""}" id="gwTabReg">Регистрация</button>
    </div>
    ${isLogin ? `
      <form class="gw-form" id="gwLoginForm">
        <label>Email</label>
        <input name="email" type="email" required autocomplete="email" placeholder="you@example.com">
        <label>Пароль</label>
        <input name="password" type="password" required autocomplete="current-password" placeholder="••••••">
        <div><button type="submit" class="gw-btn gw-btn--primary">Войти</button></div>
      </form>
    ` : `
      <form class="gw-form" id="gwRegForm">
        <label>Email</label>
        <input name="email" type="email" required autocomplete="email" placeholder="you@example.com">
        <label>Никнейм</label>
        <input name="nickname" type="text" required autocomplete="username" placeholder="Ваш ник">
        <label>Пароль (мин. 6 символов)</label>
        <input name="password" type="password" required autocomplete="new-password" placeholder="••••••">
        <!-- Honeypot: скрыто от людей, боты заполняют -->
        <input name="website" type="text" tabindex="-1" autocomplete="off" style="display:none" aria-hidden="true">
        <label class="gw-form__checkbox">
          <input type="checkbox" name="consent" id="gwConsentCheck">
          Я принимаю <a href="privacy.html" target="_blank" rel="noopener">политику конфиденциальности</a>
        </label>
        <div class="gw-form__error" id="gwConsentError" style="display:none;color:var(--red);font-size:.8rem">Необходимо принять политику</div>
        <div><button type="submit" class="gw-btn gw-btn--primary">Создать аккаунт</button></div>
      </form>
    `}
  `;
  document.getElementById("gwTabLogin")?.addEventListener("click", () => { state.authTab = "login"; renderModal(); });
  document.getElementById("gwTabReg")?.addEventListener("click", () => { state.authTab = "register"; renderModal(); });
  document.getElementById("gwLoginForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const d = await api("/api/login", { method: "POST", body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }) });
      state.token = d.token; state.me = d.user;
      localStorage.setItem(TOKEN_KEY, d.token);
      saveCurrentAccount();
      closeModal(); renderAuthBar(); renderAdminSidebar();
      if (state.me?.canManageUsers) await loadPending();
      renderAdminSidebar();
    } catch (err) { alert(err.message); }
  });
  document.getElementById("gwRegForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const consentCheck = document.getElementById("gwConsentCheck");
    const consentError = document.getElementById("gwConsentError");
    if (!consentCheck?.checked) {
      if (consentError) consentError.style.display = "";
      return;
    }
    if (consentError) consentError.style.display = "none";
    try {
      const d = await api("/api/register", { method: "POST", body: JSON.stringify({ email: fd.get("email"), nickname: fd.get("nickname"), password: fd.get("password"), consent: true, website: fd.get("website") || "" }) });
      state.token = d.token; state.me = d.user;
      localStorage.setItem(TOKEN_KEY, d.token);
      saveCurrentAccount();
      closeModal(); renderAuthBar(); renderAdminSidebar();
    } catch (err) { alert(err.message); }
  });
}

function renderProfileModal() {
  const u = state.me;
  if (!u) return;

  // Вкладки: Профиль | Безопасность
  const tabs = [
    { id: "profile", label: "Профиль" },
    { id: "security", label: "Безопасность" },
  ];
  let activeTab = "profile";

  function renderTabs() {
    gwModalContent.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem">
        <div style="display:flex;gap:.25rem">
          ${tabs.map(t => `
            <button class="gw-tab ${activeTab === t.id ? "is-active" : ""}" data-tab="${t.id}">${t.label}</button>
          `).join("")}
        </div>
        <a href="user.html?id=${u.id}" class="gw-btn gw-btn--ghost gw-btn--sm" target="_blank" rel="noopener">Мой профиль ↗</a>
      </div>

      ${activeTab === "profile" ? `
        <!-- Аватар + ник -->
        <div style="display:flex;align-items:center;gap:.85rem;padding:.85rem;background:var(--surface2);border:1px solid var(--line);border-radius:10px;margin-bottom:1rem">
          ${u.avatarUrl
            ? `<img src="${esc(u.avatarUrl)}" style="width:52px;height:52px;border-radius:10px;object-fit:cover;border:1px solid var(--line)" crossorigin="anonymous">`
            : `<div style="width:52px;height:52px;border-radius:10px;background:rgba(91,155,213,0.15);display:flex;align-items:center;justify-content:center;font-size:1.4rem;font-weight:700;color:var(--accent)">${esc(u.nickname).slice(0,1).toUpperCase()}</div>`
          }
          <div>
            <div style="font-weight:700;color:var(--heading);font-size:1rem">${esc(u.nickname)}</div>
            <div style="font-size:.78rem;color:var(--muted)">${esc(u.roleLabel)} · ${esc(u.email)}</div>
          </div>
        </div>
        <form class="gw-form" id="gwProfileForm">
          <label>Никнейм</label>
          <input name="nickname" type="text" value="${esc(u.nickname)}" autocomplete="nickname" placeholder="Ваш ник">
          <label>О себе</label>
          <textarea name="bio" rows="3" placeholder="Коротко о себе">${esc(u.bio || "")}</textarea>
          <label>URL аватара</label>
          <input name="avatar_url" type="url" value="${esc(u.avatarUrl || "")}" placeholder="https://i.imgur.com/…">
          <div><button type="submit" class="gw-btn gw-btn--primary">Сохранить изменения</button></div>
        </form>
      ` : `
        <!-- Безопасность -->
        <form class="gw-form" id="gwPasswordForm">
          <label>Новый пароль</label>
          <input name="password" type="password" autocomplete="new-password" placeholder="Мин. 6 символов">
          <label>Повторите пароль</label>
          <input name="password2" type="password" autocomplete="new-password" placeholder="Повторите пароль">
          <div><button type="submit" class="gw-btn gw-btn--primary">Сменить пароль</button></div>
        </form>
        <div style="margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--line)">
          <button class="gw-btn gw-btn--logout" id="gwProfileLogout" style="width:100%">⏻ Выйти из аккаунта</button>
        </div>
        <div style="margin-top:.75rem">
          <details>
            <summary style="font-size:.8rem;color:var(--red);cursor:pointer;user-select:none">⚠ Удалить аккаунт</summary>
            <div style="margin-top:.65rem;padding:.75rem;background:rgba(201,96,96,0.07);border:1px solid rgba(201,96,96,0.2);border-radius:8px">
              <p style="margin:0 0 .5rem;font-size:.82rem;color:var(--text)">Удаление необратимо. Email будет заблокирован на 14 дней.</p>
              <button class="gw-btn gw-btn--danger gw-btn--sm" id="gwDeleteAccount">Удалить мой аккаунт</button>
            </div>
          </details>
        </div>
      `}
    `;

    // Переключение вкладок
    gwModalContent.querySelectorAll(".gw-tab[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => { activeTab = btn.dataset.tab; renderTabs(); });
    });

    // Сохранение профиля
    document.getElementById("gwProfileForm")?.addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = { bio: fd.get("bio"), avatar_url: fd.get("avatar_url") };
      if (fd.get("nickname")?.trim()) payload.nickname = fd.get("nickname").trim();
      try {
        const d = await api("/api/profile", { method: "PATCH", body: JSON.stringify(payload) });
        state.me = d.user;
        renderAuthBar();
        // Показываем успех
        const btn = e.target.querySelector("button[type=submit]");
        btn.textContent = "Сохранено ✓"; btn.disabled = true;
        setTimeout(() => { btn.textContent = "Сохранить изменения"; btn.disabled = false; }, 2000);
      } catch (err) { alert(err.message); }
    });

    // Смена пароля
    document.getElementById("gwPasswordForm")?.addEventListener("submit", async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const pw = fd.get("password");
      const pw2 = fd.get("password2");
      if (!pw || pw.length < 6) { alert("Пароль минимум 6 символов"); return; }
      if (pw !== pw2) { alert("Пароли не совпадают"); return; }
      try {
        await api("/api/profile", { method: "PATCH", body: JSON.stringify({ password: pw }) });
        const btn = e.target.querySelector("button[type=submit]");
        btn.textContent = "Изменён ✓"; btn.disabled = true;
        e.target.reset();
        setTimeout(() => { btn.textContent = "Сменить пароль"; btn.disabled = false; }, 2000);
      } catch (err) { alert(err.message); }
    });

    // Выход
    document.getElementById("gwProfileLogout")?.addEventListener("click", async () => {
      try { await api("/api/logout", { method: "POST" }); } catch {}
      state.token = ""; state.me = null;
      localStorage.removeItem(TOKEN_KEY);
      closeModal(); renderAuthBar(); renderAdminSidebar();
    });

    // Удаление аккаунта
    document.getElementById("gwDeleteAccount")?.addEventListener("click", async () => {
      if (!confirm("Удалить аккаунт навсегда? Это действие необратимо.")) return;
      if (!confirm("Последнее предупреждение. Восстановление невозможно.")) return;
      try {
        await api("/api/account", { method: "DELETE" });
        state.token = ""; state.me = null;
        localStorage.removeItem(TOKEN_KEY);
        closeModal(); renderAuthBar(); renderAdminSidebar();
      } catch (err) { alert(err.message); }
    });
  }

  renderTabs();
}

function renderNewCatModal() {
  gwModalContent.innerHTML = `
    <h2 class="gw-modal__title">Новая категория</h2>
    <form class="gw-form" id="gwNewCatForm">
      <label>Название</label>
      <input name="name" type="text" required placeholder="Например: Аддоны">
      <label>Slug (латиница, цифры, дефис)</label>
      <input name="slug" type="text" required placeholder="addony">
      <label>Описание (необязательно)</label>
      <textarea name="description" rows="2" placeholder="Краткое описание категории"></textarea>
      <div><button type="submit" class="gw-btn gw-btn--primary">Создать</button></div>
    </form>
  `;
  document.getElementById("gwNewCatForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/api/wiki/categories", { method: "POST", body: JSON.stringify({ name: fd.get("name"), slug: fd.get("slug"), description: fd.get("description") }) });
      await loadCategories();
      renderSidebarCats();
      closeModal();
      renderHome();
    } catch (err) { alert(err.message); }
  });
}

function renderNewArticleModal() {
  const cat = state.currentCat;
  gwModalContent.innerHTML = `
    <h2 class="gw-modal__title">Новая статья</h2>
    <div class="gw-notice gw-notice--info">Статья уйдёт на модерацию и появится после одобрения.</div>
    <form class="gw-form" id="gwNewArticleForm">
      <label>Заголовок</label>
      <input name="title" type="text" required placeholder="Название статьи">
      <label>Текст статьи</label>
      <div class="gw-editor" id="gwEditorNew">
        <div class="gw-editor__toolbar">
          <button type="button" data-cmd="bold"><b>B</b></button>
          <button type="button" data-cmd="italic"><i>I</i></button>
          <button type="button" data-cmd="underline"><u>U</u></button>
          <span class="gw-editor__sep"></span>
          <button type="button" data-cmd="insertUnorderedList">≡</button>
          <button type="button" data-cmd="insertOrderedList">1.</button>
          <span class="gw-editor__sep"></span>
          <button type="button" data-cmd="h2">H2</button>
          <button type="button" data-cmd="h3">H3</button>
          <span class="gw-editor__sep"></span>
          <label class="gw-editor__attach" title="Прикрепить изображение">
            📎<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" id="gwAttachNew" style="display:none">
          </label>
        </div>
        <div class="gw-editor__body" id="gwBodyNew" contenteditable="true" data-placeholder="Содержимое статьи…"></div>
      </div>
      <div class="gw-editor__img-preview" id="gwImgPreviewNew" style="display:none"></div>
      <input type="hidden" id="gwImgUrlNew" value="">
      <p class="gw-form__hint" id="gwUploadStatusNew" style="min-height:1.2em"></p>
      <div><button type="submit" class="gw-btn gw-btn--primary">Отправить на модерацию</button></div>
    </form>
  `;
  bindEditor("gwEditorNew", "gwBodyNew", "gwAttachNew", "gwImgUrlNew", "gwImgPreviewNew", "gwUploadStatusNew");
  document.getElementById("gwNewArticleForm").addEventListener("submit", async e => {
    e.preventDefault();
    const body = editorGetText("gwBodyNew");
    const title = e.target.querySelector('[name="title"]').value.trim();
    if (!title || !body.trim()) { alert("Заполните заголовок и текст"); return; }
    try {
      const d = await api("/api/wiki/articles", { method: "POST", body: JSON.stringify({
        category_id: cat.id, title, body,
        image_url: document.getElementById("gwImgUrlNew").value.trim(),
      })});
      closeModal();
      if (d.status === "approved") { await loadCategoryArticles(cat.slug); navCategory(cat.slug); }
      else alert("Статья отправлена на модерацию. Она появится после одобрения.");
    } catch (err) { alert(err.message); }
  });
}

function renderEditArticleModal() {
  const art = state.currentArticle;
  gwModalContent.innerHTML = `
    <h2 class="gw-modal__title">Редактировать статью</h2>
    <form class="gw-form" id="gwEditForm">
      <label>Заголовок</label>
      <input name="title" type="text" value="${esc(art.title)}" required>

      <label>Текст статьи</label>
      <div class="gw-editor" id="gwEditorEdit">
        <div class="gw-editor__toolbar">
          <button type="button" data-cmd="bold" title="Жирный"><b>B</b></button>
          <button type="button" data-cmd="italic" title="Курсив"><i>I</i></button>
          <button type="button" data-cmd="underline" title="Подчёркнутый"><u>U</u></button>
          <span class="gw-editor__sep"></span>
          <button type="button" data-cmd="insertUnorderedList" title="Список">≡</button>
          <button type="button" data-cmd="insertOrderedList" title="Нумерованный">1.</button>
          <span class="gw-editor__sep"></span>
          <button type="button" data-cmd="h2" title="Заголовок H2">H2</button>
          <button type="button" data-cmd="h3" title="Заголовок H3">H3</button>
          <span class="gw-editor__sep"></span>
          <label class="gw-editor__attach" title="Прикрепить изображение">
            📎
            <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" id="gwAttachEdit" style="display:none">
          </label>
        </div>
        <div class="gw-editor__body" id="gwBodyEdit" contenteditable="true">${art.body ? art.body.replace(/\n/g, "<br>") : ""}</div>
      </div>

      ${art.image_url ? `
        <div class="gw-editor__img-preview" id="gwImgPreviewEdit">
          <img src="${esc(art.image_url)}" alt="">
          <button type="button" class="gw-editor__img-remove" id="gwRemoveImgEdit">×</button>
        </div>
      ` : `<div class="gw-editor__img-preview" id="gwImgPreviewEdit" style="display:none"></div>`}
      <input type="hidden" name="image_url" id="gwImgUrlEdit" value="${esc(art.image_url || "")}">
      <p class="gw-form__hint" id="gwUploadStatusEdit" style="min-height:1.2em"></p>

      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button type="submit" class="gw-btn gw-btn--primary">Сохранить</button>
        <button type="button" class="gw-btn gw-btn--ghost" id="gwCancelEdit">Отмена</button>
      </div>
    </form>
  `;

  bindEditor("gwEditorEdit", "gwBodyEdit", "gwAttachEdit", "gwImgUrlEdit", "gwImgPreviewEdit", "gwUploadStatusEdit");
  document.getElementById("gwCancelEdit")?.addEventListener("click", closeModal);
  document.getElementById("gwRemoveImgEdit")?.addEventListener("click", () => {
    document.getElementById("gwImgUrlEdit").value = "";
    const p = document.getElementById("gwImgPreviewEdit");
    p.style.display = "none"; p.innerHTML = "";
  });

  document.getElementById("gwEditForm").addEventListener("submit", async e => {
    e.preventDefault();
    const body = document.getElementById("gwBodyEdit").innerHTML
      .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
    const payload = {
      title: e.target.querySelector('[name="title"]').value.trim(),
      body,
      image_url: document.getElementById("gwImgUrlEdit").value.trim(),
    };
    try {
      const d = await api("/api/wiki/articles/" + art.id, { method: "PATCH", body: JSON.stringify(payload) });
      state.currentArticle = { ...art, ...d.article };
      if (state.currentCat) {
        state.currentCat.articles = state.currentCat.articles.map(a =>
          a.id === art.id ? { ...a, ...d.article } : a
        );
      }
      closeModal(); renderArticle();
    } catch (err) { alert(err.message); }
  });
}

function renderRolesModal() {
  gwModalContent.innerHTML = `
    <h2 class="gw-modal__title">Управление ролями</h2>
    <form class="gw-form" id="gwRolesForm">
      <label>Email пользователя</label>
      <input name="email" type="email" required placeholder="user@example.com">
      <label>Роль</label>
      <select name="role">
        <option value="admin">admin</option>
        <option value="moderator">moderator</option>
        <option value="postmaker">postmaker</option>
        <option value="user" selected>user</option>
      </select>
      <div><button type="submit" class="gw-btn gw-btn--primary">Назначить роль</button></div>
    </form>
    <div id="gwRolesMsg" style="margin-top:.75rem;font-size:.875rem"></div>
  `;
  document.getElementById("gwRolesForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const msg = document.getElementById("gwRolesMsg");
    try {
      await api("/api/wiki/members/role", {
        method: "POST",
        body: JSON.stringify({ email: fd.get("email"), role: fd.get("role") }),
      });
      if (msg) { msg.style.color = "var(--green)"; msg.textContent = `Роль «${fd.get("role")}» назначена для ${fd.get("email")}.`; }
      e.target.reset();
    } catch (err) {
      if (msg) { msg.style.color = "var(--red)"; msg.textContent = err.message; }
    }
  });
}

async function renderPendingModal() {
  await loadPending();
  const items = state.pendingArticles;
  gwModalContent.innerHTML = `
    <h2 class="gw-modal__title">На модерации <span class="gw-badge gw-badge--yellow">${items.length}</span></h2>
    ${!items.length ? `<p class="gw-muted">Нет статей на модерации.</p>` : items.map(a => `
      <div class="gw-pending-item" data-id="${a.id}">
        <div class="gw-pending-item__title">${esc(a.title)}</div>
        <div class="gw-pending-item__meta">
          ${esc(a.author_nickname)} · ${esc(a.category_name)} · ${fmtDate(a.created_at)}
        </div>
        ${a.image_url ? `<img src="${esc(a.image_url)}" style="max-width:100%;border-radius:6px;margin-bottom:.5rem;border:1px solid var(--line)" loading="lazy">` : ""}
        <div class="gw-pending-item__body" style="white-space:pre-wrap;font-size:.875rem;color:var(--text);margin-bottom:.65rem;max-height:200px;overflow:auto">${sanitizeBody(a.body)}</div>
        <div class="gw-pending-item__actions">
          <button class="gw-btn gw-btn--green gw-btn--sm gw-approve" data-id="${a.id}" data-slug="${esc(a.category_slug)}">✓ Одобрить</button>
          <button class="gw-btn gw-btn--danger gw-btn--sm gw-reject" data-id="${a.id}">✕ Отклонить</button>
        </div>
      </div>
    `).join("")}
  `;
  gwModalContent.querySelectorAll(".gw-approve").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "…";
      try {
        await api("/api/wiki/articles/" + btn.dataset.id + "/status", { method: "PATCH", body: JSON.stringify({ status: "approved" }) });
        await loadCategories();
        renderSidebarCats();
        if (state.currentCat?.slug === btn.dataset.slug) await loadCategoryArticles(btn.dataset.slug);
        await renderPendingModal(); // обновляем счётчик
        renderAdminSidebar();       // обновляем бейдж в сайдбаре
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "✓ Одобрить"; }
    });
  });
  gwModalContent.querySelectorAll(".gw-reject").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "…";
      try {
        await api("/api/wiki/articles/" + btn.dataset.id + "/status", { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
        await renderPendingModal();
        renderAdminSidebar();
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "✕ Отклонить"; }
    });
  });
}

// ── Editor helpers ────────────────────────────────────────────────────────────
function bindEditor(editorId, bodyId, attachId, imgUrlId, previewId, statusId) {
  const toolbar = document.querySelector(`#${editorId} .gw-editor__toolbar`);
  const body    = document.getElementById(bodyId);
  const attach  = document.getElementById(attachId);
  const imgUrl  = document.getElementById(imgUrlId);
  const preview = document.getElementById(previewId);
  const status  = document.getElementById(statusId);

  // Toolbar buttons
  toolbar.querySelectorAll("button[data-cmd]").forEach(btn => {
    btn.addEventListener("mousedown", e => {
      e.preventDefault();
      const cmd = btn.dataset.cmd;
      if (cmd === "h2" || cmd === "h3") {
        document.execCommand("formatBlock", false, cmd);
      } else {
        document.execCommand(cmd, false, null);
      }
      body.focus();
    });
  });

  // Placeholder
  body.addEventListener("input", () => {
    body.dataset.empty = body.innerText.trim() === "" ? "1" : "";
  });
  body.dataset.empty = body.innerText.trim() === "" ? "1" : "";

  // File attach (скрепка)
  attach.addEventListener("change", async () => {
    const file = attach.files[0];
    if (!file) return;
    if (status) { status.textContent = "Загрузка…"; status.style.color = "var(--muted)"; }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const headers = {};
      if (state.token) headers.Authorization = "Bearer " + state.token;
      const res = await fetch("/api/wiki/upload", { method: "POST", headers, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Ошибка сервера " + res.status);
      // Вставляем картинку прямо в редактор
      document.execCommand("insertHTML", false, `<img src="${data.url}" style="max-width:100%;border-radius:6px;margin:.25rem 0" alt="">`);
      // Также сохраняем как основное изображение статьи если ещё нет
      if (imgUrl && !imgUrl.value) {
        imgUrl.value = data.url;
        if (preview) {
          preview.style.display = "";
          preview.innerHTML = `<img src="${data.url}" alt=""><button type="button" class="gw-editor__img-remove" id="gwRemoveImg_${previewId}">×</button>`;
          document.getElementById("gwRemoveImg_" + previewId)?.addEventListener("click", () => {
            imgUrl.value = ""; preview.style.display = "none"; preview.innerHTML = "";
          });
        }
      }
      if (status) { status.textContent = "✓ " + file.name; status.style.color = "#5cb87a"; }
    } catch (err) {
      if (status) { status.textContent = "Ошибка: " + err.message; status.style.color = "#c96060"; }
    }
    attach.value = "";
  });
}

function editorGetText(bodyId) {
  const el = document.getElementById(bodyId);
  if (!el) return "";
  // Сохраняем HTML как есть (с тегами форматирования)
  return el.innerHTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

// ── Saved Accounts ────────────────────────────────────────────────────────────
const SAVED_KEY = "gwiki_saved_accounts";

function getSavedAccounts() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"); } catch { return []; }
}

function saveCurrentAccount() {
  if (!state.token || !state.me) return;
  const accounts = getSavedAccounts().filter(a => a.token !== state.token);
  accounts.unshift({ token: state.token, nickname: state.me.nickname, email: state.me.email, id: state.me.id });
  localStorage.setItem(SAVED_KEY, JSON.stringify(accounts.slice(0, 5)));
}

function removeSavedAccount(token) {
  const accounts = getSavedAccounts().filter(a => a.token !== token);
  localStorage.setItem(SAVED_KEY, JSON.stringify(accounts));
}

function renderSwitchAccountModal() {
  const accounts = getSavedAccounts().filter(a => a.token !== state.token);
  gwModalContent.innerHTML = `
    <h2 class="gw-modal__title">Сменить аккаунт</h2>
    ${accounts.length ? `
      <p style="font-size:.875rem;color:var(--muted);margin:0 0 .75rem">Сохранённые аккаунты:</p>
      <div class="gw-account-list" id="gwAccountList">
        ${accounts.map(a => `
          <div class="gw-account-item" data-token="${esc(a.token)}">
            <div class="gw-account-item__avatar">${esc(a.nickname).slice(0,1).toUpperCase()}</div>
            <div class="gw-account-item__info">
              <div class="gw-account-item__nick">${esc(a.nickname)}</div>
            </div>
            <button class="gw-btn gw-btn--primary gw-btn--sm gw-switch-btn" data-token="${esc(a.token)}">Войти</button>
            <button class="gw-btn gw-btn--ghost gw-btn--sm gw-remove-account" data-token="${esc(a.token)}" title="Убрать">×</button>
          </div>
        `).join("")}
      </div>
      <div class="gw-divider"></div>
    ` : `<p style="font-size:.875rem;color:var(--muted);margin:0 0 1rem">Нет сохранённых аккаунтов.</p>`}
    <button class="gw-btn gw-btn--ghost gw-btn--sm" id="gwAddAccount">+ Войти в другой аккаунт</button>
  `;

  // Переключение на сохранённый аккаунт
  gwModalContent.querySelectorAll(".gw-switch-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const token = btn.dataset.token;
      // Сохраняем текущий перед переключением
      saveCurrentAccount();
      state.token = token;
      localStorage.setItem(TOKEN_KEY, token);
      state.me = null;
      await loadMe();
      if (!state.me) {
        removeSavedAccount(token);
        alert("Сессия истекла, войдите заново.");
        closeModal(); renderAuthBar(); return;
      }
      saveCurrentAccount();
      closeModal();
      renderAuthBar();
      renderAdminSidebar();
      if (state.me?.canManageUsers) await loadPending();
      renderAdminSidebar();
    });
  });

  // Убрать аккаунт из списка
  gwModalContent.querySelectorAll(".gw-remove-account").forEach(btn => {
    btn.addEventListener("click", () => {
      removeSavedAccount(btn.dataset.token);
      renderSwitchAccountModal();
    });
  });

  // Войти в новый аккаунт
  document.getElementById("gwAddAccount")?.addEventListener("click", () => {
    saveCurrentAccount();
    state.authTab = "login";
    openModal("auth", "login");
  });
}

// ── Global bindings ───────────────────────────────────────────────────────────
function bindGlobal() {
  gwModalClose.addEventListener("click", closeModal);
  gwModalBg.addEventListener("click", closeModal);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return n + " " + one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return n + " " + few;
  return n + " " + many;
}

// ── Search ────────────────────────────────────────────────────────────────────
function bindSearch() {
  const input = document.getElementById("gwSearch");
  const panel = document.getElementById("gwSearchResults");
  if (!input || !panel) return;

  let debounceTimer = null;

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) { panel.hidden = true; panel.innerHTML = ""; return; }
    // @ник — минимум @x (2 символа), обычный поиск — минимум 2 символа
    if (q.startsWith("@") ? q.length < 2 : q.length < 2) { panel.hidden = true; return; }
    debounceTimer = setTimeout(() => doSearch(q), 300);
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { panel.hidden = true; input.value = ""; }
  });

  document.addEventListener("click", e => {
    if (!input.contains(e.target) && !panel.contains(e.target)) {
      panel.hidden = true;
    }
  });
}

async function doSearch(q) {
  const panel = document.getElementById("gwSearchResults");
  if (!panel) return;
  try {
    // Поиск пользователя по @ник
    if (q.startsWith("@")) {
      const nick = q.slice(1).toLowerCase();
      if (!nick) { panel.hidden = true; return; }
      const d = await api("/api/wiki/directory");
      const users = (d.users || []).filter(u => u.nickname.toLowerCase().includes(nick));
      panel.hidden = false;
      if (!users.length) {
        panel.innerHTML = `<div class="gw-search-msg">Пользователь не найден</div>`;
        return;
      }
      panel.innerHTML = `
        <div class="gw-search-group">Пользователи</div>
        ${users.slice(0, 10).map(u => `
          <div class="gw-search-item" data-user-id="${u.id}">
            <div class="gw-search-item__title">@${esc(u.nickname)}</div>
          </div>
        `).join("")}
      `;
      panel.querySelectorAll(".gw-search-item[data-user-id]").forEach(el => {
        el.addEventListener("click", () => {
          panel.hidden = true;
          document.getElementById("gwSearch").value = "";
          window.open("user.html?id=" + el.dataset.userId, "_blank");
        });
      });
      return;
    }
    const d = await api("/api/wiki/search?q=" + encodeURIComponent(q));
    renderSearchResults(d.articles || [], d.categories || []);
  } catch {
    panel.hidden = false;
    panel.innerHTML = `<div class="gw-search-msg">Ошибка поиска, попробуйте снова</div>`;
  }
}

function renderSearchResults(articles, categories) {
  const panel = document.getElementById("gwSearchResults");
  const input = document.getElementById("gwSearch");
  if (!panel) return;

  if (!articles.length && !categories.length) {
    panel.hidden = false;
    panel.innerHTML = `<div class="gw-search-msg">Ничего не найдено</div>`;
    return;
  }

  let html = "";
  if (articles.length) {
    html += `<div class="gw-search-group">Статьи</div>`;
    html += articles.map(a => `
      <div class="gw-search-item" data-type="article" data-id="${a.id}">
        <div class="gw-search-item__title">${esc(a.title)}</div>
        ${a.excerpt ? `<div class="gw-search-item__excerpt">${esc(a.excerpt)}</div>` : ""}
      </div>
    `).join("");
  }
  if (categories.length) {
    html += `<div class="gw-search-group">Категории</div>`;
    html += categories.map(c => `
      <div class="gw-search-item" data-type="category" data-slug="${esc(c.slug)}">
        <div class="gw-search-item__title">${esc(c.name)}</div>
        ${c.excerpt ? `<div class="gw-search-item__excerpt">${esc(c.excerpt)}</div>` : ""}
      </div>
    `).join("");
  }

  panel.hidden = false;
  panel.innerHTML = html;

  panel.querySelectorAll(".gw-search-item").forEach(el => {
    el.addEventListener("click", () => {
      panel.hidden = true;
      if (input) input.value = "";
      if (el.dataset.type === "article") {
        location.hash = "#article/" + el.dataset.id;
      } else {
        location.hash = "#category/" + el.dataset.slug;
      }
    });
  });
}

init();
})();
