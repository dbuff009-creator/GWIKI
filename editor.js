(() => {
  "use strict";
  const TOKEN_KEY = "gwiki_token_v2";
  const token = localStorage.getItem(TOKEN_KEY) || "";

  if (!token) { window.location.href = "index.html"; throw new Error("not authenticated"); }

  const params     = new URLSearchParams(location.search);
  const mode       = params.get("mode");        // "new" | "edit"
  const categoryId = Number(params.get("category_id")) || null;
  const articleId  = Number(params.get("article_id"))  || null;

  // ── DOM ──────────────────────────────────────────────────────────────────────
  const gwAuthBar      = document.getElementById("gwAuthBar");
  const gwEditorTitle  = document.getElementById("gwEditorTitle");
  const gwEditorSub    = document.getElementById("gwEditorSub");
  const gwEditorLoading = document.getElementById("gwEditorLoading");
  const gwEditorForm   = document.getElementById("gwEditorForm");
  const gwCatFieldWrap = document.getElementById("gwCatFieldWrap");
  const gwCatSelect    = document.getElementById("gwCatSelect");
  const gwCatError     = document.getElementById("gwCatError");
  const gwTitleInput   = document.getElementById("gwTitleInput");
  const gwTitleError   = document.getElementById("gwTitleError");
  const gwBodyEditor   = document.getElementById("gwBodyEditor");
  const gwBodyError    = document.getElementById("gwBodyError");
  const gwImgUrl       = document.getElementById("gwImgUrl");
  const gwImgUrlInput  = document.getElementById("gwImgUrlInput");
  const gwImgPreview   = document.getElementById("gwImgPreview");
  const gwUploadStatus = document.getElementById("gwUploadStatus");
  const gwAttachFile   = document.getElementById("gwAttachFile");
  const gwSaveBtn      = document.getElementById("gwSaveBtn");
  const gwCancelBtn    = document.getElementById("gwCancelBtn");
  const gwWordCount    = document.getElementById("gwWordCount");
  const gwNotice       = document.getElementById("gwNotice");
  const gwLinkBtn      = document.getElementById("gwLinkBtn");
  const gwLinkModal    = document.getElementById("gwLinkModal");
  const gwLinkUrl      = document.getElementById("gwLinkUrl");
  const gwLinkConfirm  = document.getElementById("gwLinkConfirm");
  const gwLinkCancel   = document.getElementById("gwLinkCancel");

  let me = null;
  let savedSelection = null;

  // ── API ───────────────────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function esc(v) {
    return String(v || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // ── Auth bar ──────────────────────────────────────────────────────────────────
  function renderAuthBar() {
    if (!gwAuthBar || !me) return;
    gwAuthBar.innerHTML = `
      <span style="font-size:.875rem;color:var(--text)">${esc(me.nickname)}</span>
      <a href="index.html" class="gw-btn gw-btn--ghost gw-btn--sm">← Главная</a>
    `;
  }

  // ── Счётчик слов ──────────────────────────────────────────────────────────────
  function updateWordCount() {
    const text = gwBodyEditor.innerText.trim();
    const words = text ? text.split(/\s+/).length : 0;
    const chars = text.length;
    gwWordCount.textContent = words + " сл. · " + chars + " симв.";
  }

  // ── Тулбар ────────────────────────────────────────────────────────────────────
  function bindToolbar() {
    document.querySelectorAll("#gwEditorMain .ed-toolbar__btn[data-cmd]").forEach(btn => {
      btn.addEventListener("mousedown", e => {
        e.preventDefault();
        const cmd = btn.dataset.cmd;
        gwBodyEditor.focus();
        switch (cmd) {
          case "h2": case "h3": case "h4":
            document.execCommand("formatBlock", false, cmd);
            break;
          case "blockquote":
            document.execCommand("formatBlock", false, "blockquote");
            break;
          case "pre":
            document.execCommand("formatBlock", false, "pre");
            break;
          case "code": {
            const sel = window.getSelection();
            if (sel && sel.toString()) {
              document.execCommand("insertHTML", false,
                `<code>${esc(sel.toString())}</code>`);
            } else {
              document.execCommand("insertHTML", false, "<code>код</code>");
            }
            break;
          }
          case "hr":
            document.execCommand("insertHTML", false, "<hr>");
            break;
          default:
            document.execCommand(cmd, false, null);
        }
        updateWordCount();
      });
    });

    // Ctrl+K — ссылка
    gwBodyEditor.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        openLinkModal();
      }
    });

    // Placeholder и счётчик
    gwBodyEditor.addEventListener("input", () => {
      gwBodyEditor.dataset.empty = gwBodyEditor.innerText.trim() === "" ? "1" : "";
      updateWordCount();
      if (gwBodyEditor.innerText.trim()) {
        gwBodyError.style.display = "none";
        gwBodyEditor.classList.remove("is-error");
      }
    });
    gwBodyEditor.dataset.empty = gwBodyEditor.innerText.trim() === "" ? "1" : "";
  }

  // ── Модал ссылки ──────────────────────────────────────────────────────────────
  function openLinkModal() {
    // Сохраняем выделение
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      savedSelection = sel.getRangeAt(0).cloneRange();
    }
    gwLinkUrl.value = "";
    gwLinkModal.classList.add("is-open");
    gwLinkUrl.focus();
  }

  function closeLinkModal() {
    gwLinkModal.classList.remove("is-open");
    savedSelection = null;
  }

  gwLinkBtn?.addEventListener("click", e => { e.preventDefault(); openLinkModal(); });
  gwLinkCancel?.addEventListener("click", closeLinkModal);
  gwLinkModal?.addEventListener("click", e => { if (e.target === gwLinkModal) closeLinkModal(); });
  gwLinkConfirm?.addEventListener("click", () => {
    const url = gwLinkUrl.value.trim();
    if (!url) { closeLinkModal(); return; }
    gwBodyEditor.focus();
    if (savedSelection) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedSelection);
      const text = savedSelection.toString() || url;
      document.execCommand("insertHTML", false, `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`);
    } else {
      document.execCommand("insertHTML", false, `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`);
    }
    closeLinkModal();
    updateWordCount();
  });
  gwLinkUrl?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); gwLinkConfirm.click(); }
    if (e.key === "Escape") closeLinkModal();
  });

  // ── Загрузка файла ────────────────────────────────────────────────────────────
  gwAttachFile?.addEventListener("change", async () => {
    const file = gwAttachFile.files[0];
    if (!file) return;
    gwUploadStatus.textContent = "Загрузка…";
    gwUploadStatus.style.color = "var(--muted)";
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/wiki/upload", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Ошибка " + res.status);
      gwBodyEditor.focus();
      document.execCommand("insertHTML", false,
        `<img src="${data.url}" alt="" style="max-width:100%;border-radius:8px;border:1px solid var(--line);margin:.5rem 0">`);
      // Обложка если ещё нет
      if (!gwImgUrl.value) setPreviewImage(data.url);
      gwUploadStatus.textContent = "✓ " + file.name;
      gwUploadStatus.style.color = "#5cb87a";
    } catch (err) {
      gwUploadStatus.textContent = "Ошибка: " + err.message;
      gwUploadStatus.style.color = "#c96060";
    }
    gwAttachFile.value = "";
  });

  // ── Обложка ───────────────────────────────────────────────────────────────────
  function setPreviewImage(url) {
    gwImgUrl.value = url;
    gwImgUrlInput.value = url;
    if (url) {
      gwImgPreview.style.display = "";
      gwImgPreview.innerHTML = `
        <img src="${esc(url)}" alt="">
        <button type="button" class="ed-img-preview__remove" id="gwRemoveImg">×</button>
      `;
      document.getElementById("gwRemoveImg")?.addEventListener("click", () => {
        gwImgUrl.value = "";
        gwImgUrlInput.value = "";
        gwImgPreview.style.display = "none";
        gwImgPreview.innerHTML = "";
      });
    } else {
      gwImgPreview.style.display = "none";
      gwImgPreview.innerHTML = "";
    }
  }

  gwImgUrlInput?.addEventListener("input", () => setPreviewImage(gwImgUrlInput.value.trim()));

  // ── Валидация ─────────────────────────────────────────────────────────────────
  function validate() {
    let ok = true;
    if (mode === "new" && !gwCatSelect.value) {
      gwCatSelect.classList.add("is-error");
      gwCatError.classList.add("is-visible");
      ok = false;
    } else {
      gwCatSelect?.classList.remove("is-error");
      gwCatError?.classList.remove("is-visible");
    }
    if (!gwTitleInput.value.trim()) {
      gwTitleInput.classList.add("is-error");
      gwTitleError.style.display = "";
      ok = false;
    } else {
      gwTitleInput.classList.remove("is-error");
      gwTitleError.style.display = "none";
    }
    if (!gwBodyEditor.innerText.trim()) {
      gwBodyEditor.classList.add("is-error");
      gwBodyError.style.display = "";
      ok = false;
    } else {
      gwBodyEditor.classList.remove("is-error");
      gwBodyError.style.display = "none";
    }
    return ok;
  }

  // ── Уведомление ───────────────────────────────────────────────────────────────
  function showNotice(text, type) {
    gwNotice.innerHTML = `<div class="gw-notice gw-notice--${type}" style="margin-top:.5rem">${esc(text)}</div>`;
  }

  // ── Сохранение ────────────────────────────────────────────────────────────────
  async function save() {
    if (!validate()) return;
    gwSaveBtn.disabled = true;
    gwSaveBtn.textContent = "Сохранение…";
    const title = gwTitleInput.value.trim();
    const body  = gwBodyEditor.innerHTML.trim();
    const image_url = gwImgUrl.value.trim();
    try {
      if (mode === "new") {
        const opt = gwCatSelect.options[gwCatSelect.selectedIndex];
        const catSlug = opt?.dataset?.slug || "";
        const d = await api("/api/wiki/articles", {
          method: "POST",
          body: JSON.stringify({ category_id: Number(gwCatSelect.value), title, body, image_url }),
        });
        if (d.status === "pending") {
          showNotice("Статья отправлена на модерацию. Она появится после одобрения администратором.", "info");
          gwSaveBtn.textContent = "Отправлено ✓";
          setTimeout(() => { window.location.href = "index.html#category/" + catSlug; }, 2500);
        } else {
          window.location.href = "index.html#category/" + catSlug;
        }
      } else {
        await api("/api/wiki/articles/" + articleId, {
          method: "PATCH",
          body: JSON.stringify({ title, body, image_url }),
        });
        window.location.href = "index.html#article/" + articleId;
      }
    } catch (err) {
      gwSaveBtn.disabled = false;
      gwSaveBtn.textContent = mode === "new" ? "Опубликовать" : "Сохранить";
      showNotice(err.message, "warn");
    }
  }

  // ── Загрузка данных ───────────────────────────────────────────────────────────
  async function loadCategories() {
    const d = await api("/api/wiki/categories");
    const cats = d.categories || [];
    gwCatSelect.innerHTML = '<option value="">— выберите категорию —</option>' +
      cats.map(c => `<option value="${c.id}" data-slug="${esc(c.slug)}" ${c.id === categoryId ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    gwCatFieldWrap.style.display = "";
  }

  async function loadArticle() {
    const d = await api("/api/wiki/articles/" + articleId);
    const art = d.article;
    gwTitleInput.value = art.title || "";
    const body = art.body || "";
    gwBodyEditor.innerHTML = body.includes("<") ? body : body.replace(/\n/g, "<br>");
    gwBodyEditor.dataset.empty = gwBodyEditor.innerText.trim() === "" ? "1" : "";
    updateWordCount();
    if (art.image_url) setPreviewImage(art.image_url);
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  async function init() {
    try {
      const d = await api("/api/me");
      me = d.user;
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = "index.html";
      return;
    }

    renderAuthBar();
    bindToolbar();

    gwTitleInput.addEventListener("input", () => {
      if (gwTitleInput.value.trim()) {
        gwTitleInput.classList.remove("is-error");
        gwTitleError.style.display = "none";
      }
    });
    gwCatSelect?.addEventListener("change", () => {
      if (gwCatSelect.value) {
        gwCatSelect.classList.remove("is-error");
        gwCatError?.classList.remove("is-visible");
      }
    });

    if (mode === "new") {
      gwEditorTitle.textContent = "Новая статья";
      // Только owner/admin публикуют сразу, postmaker тоже проходит модерацию
      const publishesDirectly = me.canManageUsers;
      gwEditorSub.textContent = publishesDirectly ? "Статья будет опубликована сразу." : "Статья уйдёт на модерацию и появится после одобрения.";
      gwSaveBtn.textContent = publishesDirectly ? "Опубликовать" : "Отправить на модерацию";
      try { await loadCategories(); }
      catch (err) { gwEditorLoading.textContent = "Ошибка: " + err.message; return; }
    } else if (mode === "edit" && articleId) {
      gwEditorTitle.textContent = "Редактировать статью";
      gwSaveBtn.textContent = "Сохранить изменения";
      try { await loadArticle(); }
      catch (err) { gwEditorLoading.textContent = "Ошибка загрузки: " + err.message; return; }
    } else {
      gwEditorLoading.textContent = "Неверные параметры. Укажите ?mode=new или ?mode=edit&article_id=N";
      return;
    }

    gwEditorLoading.style.display = "none";
    gwEditorForm.style.display = "";
    gwEditorForm.addEventListener("submit", e => { e.preventDefault(); save(); });
    gwCancelBtn.addEventListener("click", () => {
      if (mode === "edit" && articleId) window.location.href = "index.html#article/" + articleId;
      else window.location.href = "index.html";
    });
  }

  init();
})();
