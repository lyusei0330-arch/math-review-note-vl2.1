import {
  clearRuntimeConfig,
  getRuntimeConfig,
  isCloudConfigured,
  saveRuntimeConfig,
} from "./config.js";
import {
  clearUserProblems,
  deleteProblem,
  generateSimilarProblem,
  getCurrentUser,
  getLearningSummary,
  getProblemById,
  listProblems,
  processImageFile,
  resolveImageUrl,
  runOverallLearningAnalysis,
  runProblemAiAnalysis,
  saveProblem,
  saveUserVerifiedText,
  seedSampleProblems,
  signInWithEmail,
  signOutUser,
  signUpWithEmail,
  testSimulation,
  updateReviewState,
} from "./storage.js";

const REVIEW_STATE_LABELS = {
  untouched: { label: "未着手", className: "is-untouched" },
  reviewing: { label: "確認中", className: "is-reviewing" },
  done: { label: "復習済み", className: "is-done" },
};

const appState = {
  user: null,
  route: "list", // "auth" | "list" | "form" | "detail" | "analysis" | "data"
  problems: [],
  problemsLoaded: false,
  listLoading: false,
  listError: "",
  filters: {
    query: "",
    material: "",
    unit: "",
    reviewState: "",
  },
  editingProblemId: null,
  formDirty: false,
  detailProblem: null,
  detailLoading: false,
  detailError: "",
  detailMode: "view", // "view" | "retry"
  retryRevealed: false,
  aiProblemRunning: false,
  aiSimilarRunning: false,
  aiProblemError: "",
  verifiedSaveMessage: "",
  learningSummary: null,
  learningLoading: false,
  learningRunning: false,
  learningError: "",
  authTab: "login", // "login" | "signup"
};

const els = {
  accountBar: document.getElementById("account-bar"),
  mainNav: document.getElementById("main-nav"),
  statusBanner: document.getElementById("status-banner"),
  viewRoot: document.getElementById("view-root"),
  imageModal: document.getElementById("image-modal"),
  modalImage: document.getElementById("modal-image"),
  modalTitle: document.getElementById("modal-title"),
  modalCloseBtn: document.getElementById("modal-close-btn"),
};

// ==========================================
// ユーティリティ
// ==========================================

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getImagePresenceLabel(problem) {
  const hasP = (problem.problemImages || []).length > 0;
  const hasA = (problem.answerImages || []).length > 0;
  if (hasP && hasA) return "問題画像・答案";
  if (hasP) return "問題画像のみ";
  if (hasA) return "答案画像のみ";
  return "画像なし";
}

function showBanner(message, type = "info") {
  if (!message) {
    els.statusBanner.hidden = true;
    els.statusBanner.textContent = "";
    return;
  }
  els.statusBanner.className = `status-banner is-${type}`;
  els.statusBanner.innerHTML = `<span>${escapeHtml(message)}</span>
    <button type="button" class="btn btn-secondary btn-sm" id="banner-close-btn">閉じる</button>`;
  els.statusBanner.hidden = false;
  document.getElementById("banner-close-btn")?.addEventListener("click", () => {
    showBanner("");
  });
}

function confirmLeaveIfDirty() {
  if (appState.route === "form" && appState.formDirty) {
    return window.confirm("入力中の内容が保存されていません。このまま画面を移動しますか？");
  }
  return true;
}

window.addEventListener("beforeunload", (e) => {
  if (appState.route === "form" && appState.formDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ==========================================
// モーダル（画像拡大）
// ==========================================

function openImageModal(src, title) {
  els.modalTitle.textContent = title || "画像の拡大表示";
  els.modalImage.src = src;
  els.imageModal.hidden = false;
  els.modalCloseBtn.focus();
}

function closeImageModal() {
  els.imageModal.hidden = true;
  els.modalImage.src = "";
}

els.modalCloseBtn.addEventListener("click", closeImageModal);
els.imageModal.addEventListener("click", (e) => {
  if (e.target === els.imageModal) closeImageModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.imageModal.hidden) {
    closeImageModal();
  }
});

// ==========================================
// ナビゲーション・ヘッダー描画
// ==========================================

function renderHeader() {
  const cloud = isCloudConfigured();
  if (!appState.user) {
    els.mainNav.hidden = true;
    els.accountBar.innerHTML = `
      <span class="sync-mode-tag ${cloud ? "is-cloud" : ""}">
        ${cloud ? "クラウド同期（設定済み）" : "ローカル保存モード"}
      </span>
    `;
    return;
  }

  els.mainNav.hidden = false;
  els.accountBar.innerHTML = `
    <span class="sync-mode-tag ${cloud ? "is-cloud" : ""}">
      ${cloud ? "クラウド同期中" : "ローカル保存"}
    </span>
    <span class="account-email">${escapeHtml(appState.user.email)}</span>
    <button type="button" class="btn btn-secondary btn-sm" id="logout-btn">ログアウト</button>
  `;

  document.getElementById("logout-btn")?.addEventListener("click", async () => {
    if (!confirmLeaveIfDirty()) return;
    await signOutUser();
    appState.user = null;
    appState.problems = [];
    appState.problemsLoaded = false;
    appState.learningSummary = null;
    appState.formDirty = false;
    navigate("auth");
  });

  const buttons = els.mainNav.querySelectorAll(".nav-btn");
  buttons.forEach((btn) => {
    const r = btn.dataset.route;
    const active =
      (r === "list" && (appState.route === "list" || appState.route === "detail")) ||
      (r === "form" && appState.route === "form") ||
      (r === "analysis" && appState.route === "analysis") ||
      (r === "data" && appState.route === "data");
    if (active) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  });
}

els.mainNav.addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-btn");
  if (!btn) return;
  const targetRoute = btn.dataset.route;
  if (!confirmLeaveIfDirty()) return;
  appState.formDirty = false;
  if (targetRoute === "form") {
    appState.editingProblemId = null;
  }
  navigate(targetRoute);
});

async function navigate(route, options = {}) {
  showBanner("");
  appState.route = route;
  renderHeader();

  if (route === "auth") {
    renderAuthView();
    return;
  }

  if (!appState.user) {
    appState.route = "auth";
    renderHeader();
    renderAuthView();
    return;
  }

  if (route === "list") {
    await loadAndRenderList();
  } else if (route === "form") {
    await renderFormView(options.problemId || null);
  } else if (route === "detail") {
    await loadAndRenderDetail(options.problemId);
  } else if (route === "analysis") {
    await loadAndRenderAnalysis();
  } else if (route === "data") {
    renderDataView();
  }
}

// ==========================================
// 認証画面
// ==========================================

function renderAuthView() {
  const cloud = isCloudConfigured();
  const isLogin = appState.authTab === "login";

  els.viewRoot.innerHTML = `
    <div class="auth-panel">
      <h2 class="page-heading">${isLogin ? "ログイン" : "アカウント登録"}</h2>
      <p class="helper-text" style="margin-bottom: 16px;">
        ${
          cloud
            ? "クラウド同期が有効です。同じアカウントでログインすると、PC・スマホ・Chromebookで同じ記録を閲覧できます。"
            : "現在はローカル保存モード（このブラウザ内のみ保存）です。データ・設定画面からクラウド同期を設定すると複数端末で共有できます。"
        }
      </p>

      <div class="auth-tabs" role="tablist">
        <button type="button" class="mode-btn" id="tab-login" aria-pressed="${isLogin}">ログイン</button>
        <button type="button" class="mode-btn" id="tab-signup" aria-pressed="${!isLogin}">新規登録</button>
      </div>

      <form id="auth-form" class="form-section" novalidate>
        <div class="field">
          <label class="field-label" for="auth-email">メールアドレス</label>
          <input class="input" type="email" id="auth-email" required autocomplete="email" placeholder="example@mail.com">
        </div>
        <div class="field">
          <label class="field-label" for="auth-password">パスワード（6文字以上）</label>
          <input class="input" type="password" id="auth-password" required autocomplete="${
            isLogin ? "current-password" : "new-password"
          }" minlength="6">
        </div>
        <div id="auth-error" class="save-status-text is-error" role="alert" hidden></div>
        <div class="form-actions" style="margin-top: 8px;">
          <button type="submit" class="btn btn-primary" id="auth-submit-btn">
            ${isLogin ? "ログインする" : "登録して始める"}
          </button>
          ${
            !cloud
              ? `<button type="button" class="btn btn-secondary" id="demo-login-btn">テスト用アカウントで試す</button>`
              : ""
          }
        </div>
      </form>
    </div>
  `;

  document.getElementById("tab-login").addEventListener("click", () => {
    appState.authTab = "login";
    renderAuthView();
  });
  document.getElementById("tab-signup").addEventListener("click", () => {
    appState.authTab = "signup";
    renderAuthView();
  });

  const authErrorEl = document.getElementById("auth-error");
  const submitBtn = document.getElementById("auth-submit-btn");

  document.getElementById("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    authErrorEl.hidden = true;
    const email = document.getElementById("auth-email").value;
    const password = document.getElementById("auth-password").value;

    submitBtn.disabled = true;
    submitBtn.textContent = isLogin ? "ログイン中..." : "登録中...";
    try {
      if (isLogin) {
        appState.user = await signInWithEmail(email, password);
      } else {
        const res = await signUpWithEmail(email, password);
        if (res.needsEmailConfirm) {
          showBanner("確認メールを送信しました。メール内のリンクから認証を完了してログインしてください。", "info");
          appState.authTab = "login";
          renderAuthView();
          return;
        }
        appState.user = res.user;
      }
      navigate("list");
    } catch (err) {
      authErrorEl.textContent = err.message || "認証に失敗しました。";
      authErrorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isLogin ? "ログインする" : "登録して始める";
    }
  });

  document.getElementById("demo-login-btn")?.addEventListener("click", async () => {
    const demoEmail = "student@example.com";
    const demoPass = "math1234";
    try {
      appState.user = await signInWithEmail(demoEmail, demoPass);
    } catch {
      const res = await signUpWithEmail(demoEmail, demoPass);
      appState.user = res.user;
    }
    navigate("list");
  });
}

// ==========================================
// 1. 問題一覧画面
// ==========================================

async function loadAndRenderList() {
  appState.listLoading = true;
  appState.listError = "";
  renderListView();

  try {
    appState.problems = await listProblems(appState.user.id);
    appState.problemsLoaded = true;
  } catch (err) {
    appState.listError = err.message || "記録の読み込みに失敗しました。";
  } finally {
    appState.listLoading = false;
    if (appState.route === "list") {
      renderListView();
    }
  }
}

function getFilteredProblems() {
  const { query, material, unit, reviewState } = appState.filters;
  const q = query.trim().toLowerCase();
  return appState.problems.filter((p) => {
    if (material && p.material !== material) return false;
    if (unit && p.unit !== unit) return false;
    if (reviewState && p.reviewState !== reviewState) return false;
    if (q) {
      const target = `${p.material} ${p.problemNumber} ${p.unit}`.toLowerCase();
      if (!target.includes(q)) return false;
    }
    return true;
  });
}

function renderListView() {
  const materials = [...new Set(appState.problems.map((p) => p.material).filter(Boolean))].sort();
  const units = [...new Set(appState.problems.map((p) => p.unit).filter(Boolean))].sort();
  const filtered = getFilteredProblems();

  let listContentHtml = "";
  if (appState.listLoading) {
    listContentHtml = `
      <div class="empty-state" role="status">
        <p>記録を読み込んでいます…</p>
      </div>
    `;
  } else if (appState.listError) {
    listContentHtml = `
      <div class="empty-state" role="alert">
        <p style="color: var(--error-text);">${escapeHtml(appState.listError)}</p>
        <button type="button" class="btn btn-secondary" id="retry-list-btn">再試行</button>
      </div>
    `;
  } else if (appState.problems.length === 0) {
    listContentHtml = `
      <div class="empty-state">
        <p>まだ記録がありません。「記録を追加」から問題と答案を登録できます。</p>
        <button type="button" class="btn btn-primary" id="empty-add-btn">+ 記録を追加</button>
      </div>
    `;
  } else if (filtered.length === 0) {
    listContentHtml = `
      <div class="empty-state">
        <p>検索・絞り込み条件に一致する記録はありません。</p>
        <button type="button" class="btn btn-secondary" id="reset-filter-btn">条件をリセット</button>
      </div>
    `;
  } else {
    const rowsHtml = filtered
      .map((p) => {
        const st = REVIEW_STATE_LABELS[p.reviewState] || REVIEW_STATE_LABELS.untouched;
        const imgLabel = getImagePresenceLabel(p);
        return `
          <li class="problem-row">
            <button type="button" class="problem-row-btn" data-id="${escapeHtml(p.id)}">
              <div class="problem-row-main">
                <div class="problem-row-title-group">
                  <span class="state-badge ${st.className}">${escapeHtml(st.label)}</span>
                  <span class="problem-material">${escapeHtml(p.material)}</span>
                  <span class="problem-number">${escapeHtml(p.problemNumber)}</span>
                </div>
                <span class="image-presence">${escapeHtml(imgLabel)}</span>
              </div>
              <div class="problem-row-sub">
                <span>単元: ${p.unit ? escapeHtml(p.unit) : "未設定"}</span>
                <span>更新: ${escapeHtml(formatDate(p.updatedAt))}</span>
              </div>
            </button>
          </li>
        `;
      })
      .join("");

    listContentHtml = `<ul class="problem-list">${rowsHtml}</ul>`;
  }

  els.viewRoot.innerHTML = `
    <div class="list-toolbar">
      <div class="search-row">
        <div class="search-input-wrap">
          <label for="search-query" class="file-input-hidden">キーワード検索</label>
          <input
            type="search"
            id="search-query"
            class="input"
            placeholder="教材名・問題番号・単元で検索"
            value="${escapeHtml(appState.filters.query)}"
          >
        </div>
        <button type="button" class="btn btn-primary" id="list-add-btn">+ 記録を追加</button>
      </div>

      <div class="filter-row">
        <select id="filter-material" class="select filter-select" aria-label="教材で絞り込み">
          <option value="">すべての教材</option>
          ${materials
            .map(
              (m) =>
                `<option value="${escapeHtml(m)}" ${
                  appState.filters.material === m ? "selected" : ""
                }>${escapeHtml(m)}</option>`
            )
            .join("")}
        </select>

        <select id="filter-unit" class="select filter-select" aria-label="単元で絞り込み">
          <option value="">すべての単元</option>
          ${units
            .map(
              (u) =>
                `<option value="${escapeHtml(u)}" ${
                  appState.filters.unit === u ? "selected" : ""
                }>${escapeHtml(u)}</option>`
            )
            .join("")}
        </select>

        <select id="filter-state" class="select filter-select" aria-label="復習状態で絞り込み">
          <option value="">すべての状態</option>
          <option value="untouched" ${appState.filters.reviewState === "untouched" ? "selected" : ""}>未着手</option>
          <option value="reviewing" ${appState.filters.reviewState === "reviewing" ? "selected" : ""}>確認中</option>
          <option value="done" ${appState.filters.reviewState === "done" ? "selected" : ""}>復習済み</option>
        </select>
      </div>
    </div>

    <div class="list-meta-bar">
      <span>${
        appState.listLoading
          ? "読み込み中"
          : `表示中: ${filtered.length} 件（全 ${appState.problems.length} 件）`
      }</span>
    </div>

    ${listContentHtml}
  `;

  document.getElementById("search-query")?.addEventListener("input", (e) => {
    appState.filters.query = e.target.value;
    renderListView();
    const input = document.getElementById("search-query");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  document.getElementById("filter-material")?.addEventListener("change", (e) => {
    appState.filters.material = e.target.value;
    renderListView();
  });
  document.getElementById("filter-unit")?.addEventListener("change", (e) => {
    appState.filters.unit = e.target.value;
    renderListView();
  });
  document.getElementById("filter-state")?.addEventListener("change", (e) => {
    appState.filters.reviewState = e.target.value;
    renderListView();
  });

  document.getElementById("list-add-btn")?.addEventListener("click", () => {
    appState.editingProblemId = null;
    navigate("form");
  });
  document.getElementById("empty-add-btn")?.addEventListener("click", () => {
    appState.editingProblemId = null;
    navigate("form");
  });
  document.getElementById("retry-list-btn")?.addEventListener("click", () => {
    loadAndRenderList();
  });
  document.getElementById("reset-filter-btn")?.addEventListener("click", () => {
    appState.filters = { query: "", material: "", unit: "", reviewState: "" };
    renderListView();
  });

  els.viewRoot.querySelectorAll(".problem-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigate("detail", { problemId: btn.dataset.id });
    });
  });
}

// ==========================================
// 2. 問題の登録・編集画面
// ==========================================

async function renderFormView(problemId) {
  let existing = null;
  if (problemId) {
    try {
      existing = await getProblemById(appState.user.id, problemId);
    } catch (err) {
      showBanner(err.message || "編集対象の問題を読み込めませんでした。", "error");
      navigate("list");
      return;
    }
  }

  appState.editingProblemId = existing ? existing.id : null;
  appState.formDirty = false;

  const formDraft = {
    material: existing ? existing.material : "",
    problemNumber: existing ? existing.problemNumber : "",
    unit: existing ? existing.unit : "",
    reviewState: existing ? existing.reviewState : "untouched",
    problemImages: existing ? [...existing.problemImages] : [],
    answerImages: existing ? [...existing.answerImages] : [],
    memoTried: existing ? existing.memoTried : "",
    memoIdea: existing ? existing.memoIdea : "",
    memoClue: existing ? existing.memoClue : "",
  };

  // 既存画像のプレビューURLを解決
  for (const img of [...formDraft.problemImages, ...formDraft.answerImages]) {
    if (!img.previewUrl) {
      try {
        img.previewUrl = await resolveImageUrl(img);
      } catch {
        img.previewError = true;
      }
    }
  }

  els.viewRoot.innerHTML = `
    <div style="margin-bottom: 16px;">
      <button type="button" class="btn btn-secondary btn-sm" id="form-back-btn">一覧へ戻る</button>
    </div>

    <div class="form-panel">
      <h2 class="page-heading">${existing ? "記録を編集" : "記録を追加"}</h2>

      <form id="problem-form" novalidate>
        <div class="form-section">
          <div class="field">
            <label class="field-label" for="input-material">
              教材名 <span class="badge-required">必須</span>
            </label>
            <input class="input" type="text" id="input-material" required value="${escapeHtml(
              formDraft.material
            )}" placeholder="例：青チャート 数学II+B">
          </div>

          <div class="field">
            <label class="field-label" for="input-number">
              問題番号 <span class="badge-required">必須</span>
            </label>
            <input class="input" type="text" id="input-number" required value="${escapeHtml(
              formDraft.problemNumber
            )}" placeholder="例：基本例題142">
          </div>

          <div class="field">
            <label class="field-label" for="input-unit">
              単元 <span class="badge-optional">任意</span>
            </label>
            <input class="input" type="text" id="input-unit" value="${escapeHtml(
              formDraft.unit
            )}" placeholder="例：微分法・積分法">
          </div>

          <div class="field">
            <label class="field-label" for="input-state">復習状態</label>
            <select class="select" id="input-state">
              <option value="untouched" ${formDraft.reviewState === "untouched" ? "selected" : ""}>未着手</option>
              <option value="reviewing" ${formDraft.reviewState === "reviewing" ? "selected" : ""}>確認中</option>
              <option value="done" ${formDraft.reviewState === "done" ? "selected" : ""}>復習済み</option>
            </select>
          </div>

          <div class="field">
            <span class="field-label">問題画像 <span class="badge-optional">複数枚可</span></span>
            <div class="upload-box">
              <div class="upload-controls">
                <label class="btn btn-secondary btn-sm" for="file-problem-camera">カメラで撮影</label>
                <input id="file-problem-camera" class="file-input-hidden" type="file" accept="image/*" capture="environment">
                <label class="btn btn-secondary btn-sm" for="file-problem-pick">画像を選択</label>
                <input id="file-problem-pick" class="file-input-hidden" type="file" accept="image/*" multiple>
              </div>
              <div id="problem-thumbs" class="thumb-grid"></div>
            </div>
          </div>

          <div class="field">
            <span class="field-label">答案画像 <span class="badge-optional">複数枚可</span></span>
            <div class="upload-box">
              <div class="upload-controls">
                <label class="btn btn-secondary btn-sm" for="file-answer-camera">カメラで撮影</label>
                <input id="file-answer-camera" class="file-input-hidden" type="file" accept="image/*" capture="environment">
                <label class="btn btn-secondary btn-sm" for="file-answer-pick">画像を選択</label>
                <input id="file-answer-pick" class="file-input-hidden" type="file" accept="image/*" multiple>
              </div>
              <div id="answer-thumbs" class="thumb-grid"></div>
            </div>
          </div>
        </div>

        <hr class="form-divider">

        <div class="form-section">
          <h3 class="section-heading">振り返りメモ（任意）</h3>

          <div class="field">
            <label class="field-label" for="input-tried">自分が試したこと・止まったところ</label>
            <textarea class="textarea" id="input-tried" placeholder="どこまで立式できたか、どこで手が止まったか">${escapeHtml(
              formDraft.memoTried
            )}</textarea>
          </div>

          <div class="field">
            <label class="field-label" for="input-idea">解説で初めて分かった発想</label>
            <textarea class="textarea" id="input-idea" placeholder="次に似た問題を見たときに思い出したい方針">${escapeHtml(
              formDraft.memoIdea
            )}</textarea>
          </div>

          <div class="field">
            <label class="field-label" for="input-clue">発想の手掛かりになる条件（問題文のどこか）</label>
            <textarea class="textarea" id="input-clue" placeholder="例：「すべての実数について」「自然数nに対して」など">${escapeHtml(
              formDraft.memoClue
            )}</textarea>
          </div>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary" id="save-problem-btn">保存する</button>
          <button type="button" class="btn btn-secondary" id="cancel-form-btn">キャンセル</button>
          <span id="save-status-msg" class="save-status-text" aria-live="polite"></span>
        </div>
      </form>
    </div>
  `;

  function renderThumbnails(targetId, items, kind) {
    const container = document.getElementById(targetId);
    if (!items.length) {
      container.innerHTML = `<p class="helper-text" style="grid-column: 1 / -1; margin: 0;">画像はまだ添付されていません。</p>`;
      return;
    }
    container.innerHTML = items
      .map(
        (img, idx) => `
      <div class="thumb-item">
        ${
          img.previewError || img.broken
            ? `<div class="helper-text" style="height: 120px; display: flex; align-items: center; justify-content: center; color: var(--error-text);">読込不可</div>`
            : `<img src="${escapeHtml(img.previewUrl || img.dataUrl)}" alt="${escapeHtml(
                img.name || "添付画像"
              )}" class="thumb-img">`
        }
        <button type="button" class="btn btn-secondary btn-sm remove-thumb-btn" data-kind="${kind}" data-index="${idx}">削除</button>
      </div>
    `
      )
      .join("");

    container.querySelectorAll(".remove-thumb-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const index = Number(btn.dataset.index);
        if (kind === "problem") {
          formDraft.problemImages.splice(index, 1);
          renderThumbnails("problem-thumbs", formDraft.problemImages, "problem");
        } else {
          formDraft.answerImages.splice(index, 1);
          renderThumbnails("answer-thumbs", formDraft.answerImages, "answer");
        }
        appState.formDirty = true;
      });
    });
  }

  renderThumbnails("problem-thumbs", formDraft.problemImages, "problem");
  renderThumbnails("answer-thumbs", formDraft.answerImages, "answer");

  async function handleFileSelect(files, kind) {
    if (!files || !files.length) return;
    const statusMsg = document.getElementById("save-status-msg");
    statusMsg.className = "save-status-text is-saving";
    statusMsg.textContent = "画像を処理しています…";
    try {
      for (const file of files) {
        const processed = await processImageFile(file);
        processed.previewUrl = processed.dataUrl;
        if (kind === "problem") {
          formDraft.problemImages.push(processed);
        } else {
          formDraft.answerImages.push(processed);
        }
      }
      appState.formDirty = true;
      renderThumbnails(
        kind === "problem" ? "problem-thumbs" : "answer-thumbs",
        kind === "problem" ? formDraft.problemImages : formDraft.answerImages,
        kind
      );
      statusMsg.textContent = "";
    } catch (err) {
      statusMsg.className = "save-status-text is-error";
      statusMsg.textContent = err.message || "画像の処理に失敗しました。";
    }
  }

  ["file-problem-camera", "file-problem-pick"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      handleFileSelect(e.target.files, "problem");
      e.target.value = "";
    });
  });

  ["file-answer-camera", "file-answer-pick"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      handleFileSelect(e.target.files, "answer");
      e.target.value = "";
    });
  });

  const formEl = document.getElementById("problem-form");
  formEl.addEventListener("input", () => {
    appState.formDirty = true;
  });

  const goBack = () => {
    if (!confirmLeaveIfDirty()) return;
    appState.formDirty = false;
    if (existing) {
      navigate("detail", { problemId: existing.id });
    } else {
      navigate("list");
    }
  };

  document.getElementById("form-back-btn").addEventListener("click", goBack);
  document.getElementById("cancel-form-btn").addEventListener("click", goBack);

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById("save-problem-btn");
    const statusMsg = document.getElementById("save-status-msg");

    const material = document.getElementById("input-material").value.trim();
    const problemNumber = document.getElementById("input-number").value.trim();

    if (!material || !problemNumber) {
      statusMsg.className = "save-status-text is-error";
      statusMsg.textContent = "教材名と問題番号は必須です。";
      if (!material) document.getElementById("input-material").focus();
      else document.getElementById("input-number").focus();
      return;
    }

    saveBtn.disabled = true;
    statusMsg.className = "save-status-text is-saving";
    statusMsg.textContent = "保存中です…";

    try {
      const saved = await saveProblem(appState.user.id, {
        id: existing ? existing.id : null,
        material,
        problemNumber,
        unit: document.getElementById("input-unit").value,
        reviewState: document.getElementById("input-state").value,
        problemImages: formDraft.problemImages,
        answerImages: formDraft.answerImages,
        memoTried: document.getElementById("input-tried").value,
        memoIdea: document.getElementById("input-idea").value,
        memoClue: document.getElementById("input-clue").value,
      });

      appState.formDirty = false;
      statusMsg.className = "save-status-text is-success";
      statusMsg.textContent = "保存しました。";
      setTimeout(() => {
        if (appState.route === "form") {
          navigate("detail", { problemId: saved.id });
        }
      }, 450);
    } catch (err) {
      statusMsg.className = "save-status-text is-error";
      statusMsg.textContent = `保存に失敗しました: ${err.message || "通信エラー"}`;
      saveBtn.disabled = false;
    }
  });
}

// ==========================================
// 3. 問題詳細・復習画面
// ==========================================

async function loadAndRenderDetail(problemId) {
  appState.detailLoading = true;
  appState.detailError = "";
  appState.detailMode = "view";
  appState.retryRevealed = false;
  appState.aiProblemRunning = false;
  appState.aiSimilarRunning = false;
  appState.aiProblemError = "";
  appState.verifiedSaveMessage = "";
  renderDetailView();

  try {
    appState.detailProblem = await getProblemById(appState.user.id, problemId);
  } catch (err) {
    appState.detailError = err.message || "問題の読み込みに失敗しました。";
  } finally {
    appState.detailLoading = false;
    if (appState.route === "detail") {
      renderDetailView();
    }
  }
}

function renderAiProblemSection(p, hideAnswerAndMemo) {
  if (hideAnswerAndMemo) {
    return `
      <section class="ai-section" aria-labelledby="heading-ai-section">
        <h3 id="heading-ai-section" class="section-heading" style="margin: 0;">AIによる読み取り・分析・類題</h3>
        <p class="helper-text" style="margin: 0;">再挑戦モード中は、AIによる読み取り・分析・類題を非表示にしています。「解答・メモを表示する」を押すと確認できます。</p>
      </section>
    `;
  }

  const ocr = p.aiOcrResult;
  const analysis = p.aiAnalysis;
  const similarList = Array.isArray(p.aiSimilarProblems) ? p.aiSimilarProblems : [];
  const uncertainNotes = Array.isArray(ocr?.uncertainNotes) ? ocr.uncertainNotes : [];

  return `
    <section class="ai-section" aria-labelledby="heading-ai-section">
      <div class="ai-section-header">
        <div>
          <h3 id="heading-ai-section" class="section-heading" style="margin: 0;">AIによる読み取り・分析・類題</h3>
          <p class="helper-text">本人の振り返りメモとは別の参考領域です。画像の読み取りに不確かな箇所があれば下で訂正できます。</p>
        </div>
        <button type="button" class="btn btn-primary" id="run-ai-analyze-btn" ${
          appState.aiProblemRunning ? "disabled" : ""
        }>
          ${
            appState.aiProblemRunning
              ? "AIで読み取り・分析中…"
              : ocr || analysis
              ? "AI読み取り・分析を再実行"
              : "AI読み取り・分析を実行"
          }
        </button>
      </div>

      ${
        appState.aiProblemError
          ? `<div class="save-status-text is-error" role="alert">${escapeHtml(appState.aiProblemError)}</div>`
          : ""
      }

      <!-- 1. 画像の読み取り結果 -->
      <div class="ai-subblock">
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px;">
          <span class="origin-badge is-ocr">画像の読み取り結果</span>
          ${
            ocr?.generatedAt
              ? `<span class="helper-text" style="margin: 0;">取得日: ${escapeHtml(formatDate(ocr.generatedAt))}</span>`
              : ""
          }
        </div>
        ${
          ocr
            ? `
          ${
            uncertainNotes.length > 0
              ? `
            <div class="uncertain-box">
              <p class="uncertain-box-title">読み取りが不確かな箇所（確認・訂正をおすすめします）</p>
              <ul class="uncertain-list">
                ${uncertainNotes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}
              </ul>
            </div>
          `
              : ""
          }
          ${
            ocr.problemText
              ? `<div><div class="memo-label">読み取った問題文</div><p class="pre-text-box">${escapeHtml(
                  ocr.problemText
                )}</p></div>`
              : ""
          }
          ${
            ocr.answerText
              ? `<div><div class="memo-label">読み取った答案内容</div><p class="pre-text-box">${escapeHtml(
                  ocr.answerText
                )}</p></div>`
              : ""
          }
        `
            : `<p class="helper-text" style="margin: 0;">まだ読み取りを実行していません。上の「AI読み取り・分析を実行」から画像内の数式や答案を文字起こしできます。</p>`
        }
      </div>

      <!-- 2. 本人の確認済み内容 -->
      <div class="ai-subblock">
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;">
          <span class="origin-badge is-verified">本人の確認済み内容</span>
          ${
            ocr
              ? `<button type="button" class="btn btn-secondary btn-sm" id="copy-ocr-to-verified-btn">読み取り結果を編集欄にコピー</button>`
              : ""
          }
        </div>
        <label class="helper-text" for="verified-text-input" style="margin: 0;">
          AIの読み取り誤りや補足したい式があれば、ここで訂正して保存できます。保存した内容は次回のAI分析や類題作成にも使われます。
        </label>
        <textarea id="verified-text-input" class="textarea" placeholder="確認・訂正した問題文や答案メモを残せます">${escapeHtml(
          p.userVerifiedText || ""
        )}</textarea>
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px;">
          <button type="button" class="btn btn-secondary btn-sm" id="save-verified-btn">確認済みとして保存</button>
          <span id="verified-save-msg" class="save-status-text" aria-live="polite">${escapeHtml(
            appState.verifiedSaveMessage || ""
          )}</span>
        </div>
      </div>

      <!-- 3. AIの分析案 -->
      <div class="ai-subblock">
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px;">
          <span class="origin-badge is-ai">AIの分析案（参考）</span>
          ${
            analysis?.generatedAt
              ? `<span class="helper-text" style="margin: 0;">作成日: ${escapeHtml(
                  formatDate(analysis.generatedAt)
                )}</span>`
              : ""
          }
        </div>
        ${
          analysis
            ? `
          <div class="memo-list">
            <div>
              <div class="memo-label">全体の整理</div>
              <p class="memo-body">${escapeHtml(analysis.summary || "")}</p>
            </div>
            <div>
              <div class="memo-label">できていた点・良い方針</div>
              <p class="memo-body">${escapeHtml(analysis.strengths || "")}</p>
            </div>
            <div>
              <div class="memo-label">つまずき・見直したいポイント</div>
              <p class="memo-body">${escapeHtml(analysis.bottlenecks || "")}</p>
            </div>
            <div>
              <div class="memo-label">次に確認したい観点</div>
              <p class="memo-body">${escapeHtml(analysis.nextAction || "")}</p>
            </div>
          </div>
        `
            : `<p class="helper-text" style="margin: 0;">分析案はまだありません。「AI読み取り・分析を実行」を押すと答案の整理を作成します。</p>`
        }
      </div>

      <!-- 4. 類題作成 -->
      <div class="ai-subblock">
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px;">
          <span class="origin-badge is-ai">この問題の類題</span>
        </div>
        <div class="search-row" style="align-items: center;">
          <div class="search-input-wrap">
            <label for="similar-focus-input" class="file-input-hidden">類題への要望（任意）</label>
            <input
              type="text"
              id="similar-focus-input"
              class="input"
              placeholder="類題の要望（任意・例：数値を変えて基礎を確認、場合分けを入れる）"
            >
          </div>
          <button type="button" class="btn btn-secondary" id="generate-similar-btn" ${
            appState.aiSimilarRunning ? "disabled" : ""
          }>
            ${appState.aiSimilarRunning ? "類題を作成中…" : "類題を1問作成"}
          </button>
        </div>

        ${
          similarList.length > 0
            ? similarList
                .map(
                  (sim, idx) => `
              <div class="similar-item">
                <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px;">
                  <strong>${escapeHtml(sim.title || `類題 ${idx + 1}`)}</strong>
                  <span class="helper-text" style="margin: 0;">${
                    sim.unit ? `単元: ${escapeHtml(sim.unit)}` : ""
                  }</span>
                </div>
                <p class="pre-text-box" style="background-color: var(--bg-surface);">${escapeHtml(
                  sim.problemText || ""
                )}</p>
                ${
                  sim.hint
                    ? `
                  <details class="similar-details">
                    <summary>ヒントを見る</summary>
                    <p class="memo-body">${escapeHtml(sim.hint)}</p>
                  </details>
                `
                    : ""
                }
                <details class="similar-details">
                  <summary>解答・解説を見る</summary>
                  ${
                    sim.answerText
                      ? `<p class="memo-body" style="font-weight: 600; margin-bottom: 8px;">答え: ${escapeHtml(
                          sim.answerText
                        )}</p>`
                      : ""
                  }
                  <p class="memo-body">${escapeHtml(sim.explanation || "")}</p>
                </details>
                <div>
                  <button type="button" class="btn btn-secondary btn-sm save-similar-btn" data-sim-index="${idx}">
                    この類題を問題一覧に保存する
                  </button>
                </div>
              </div>
            `
                )
                .join("")
            : `<p class="helper-text" style="margin: 0;">まだ類題はありません。上のボタンからこの問題の定着確認用の類題を作れます。</p>`
        }
      </div>
    </section>
  `;
}

function renderDetailView() {
  if (appState.detailLoading) {
    els.viewRoot.innerHTML = `
      <div class="empty-state" role="status">
        <p>問題データを読み込んでいます…</p>
      </div>
    `;
    return;
  }

  if (appState.detailError || !appState.detailProblem) {
    els.viewRoot.innerHTML = `
      <div class="empty-state" role="alert">
        <p style="color: var(--error-text);">${escapeHtml(
          appState.detailError || "問題が見つかりませんでした。"
        )}</p>
        <button type="button" class="btn btn-secondary" id="detail-error-back">一覧へ戻る</button>
      </div>
    `;
    document.getElementById("detail-error-back")?.addEventListener("click", () => navigate("list"));
    return;
  }

  const p = appState.detailProblem;
  const st = REVIEW_STATE_LABELS[p.reviewState] || REVIEW_STATE_LABELS.untouched;
  const isRetry = appState.detailMode === "retry";
  const hideAnswerAndMemo = isRetry && !appState.retryRevealed;

  els.viewRoot.innerHTML = `
    <div class="detail-header">
      <div class="detail-top-actions">
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          <button type="button" class="btn btn-secondary btn-sm" id="detail-back-btn">一覧へ戻る</button>
          ${
            p.sourceProblemId
              ? `<button type="button" class="btn btn-secondary btn-sm" id="detail-source-btn">元の問題を開く</button>`
              : ""
          }
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          <button type="button" class="btn btn-secondary btn-sm" id="detail-edit-btn">編集</button>
          <button type="button" class="btn btn-danger btn-sm" id="detail-delete-btn">削除</button>
        </div>
      </div>

      <h2 class="detail-title">${escapeHtml(p.material)} ${escapeHtml(p.problemNumber)}</h2>

      <div class="detail-meta">
        <span class="state-badge ${st.className}">${escapeHtml(st.label)}</span>
        <span>単元: ${p.unit ? escapeHtml(p.unit) : "未設定"}</span>
        <span>更新: ${escapeHtml(formatDate(p.updatedAt))}</span>
        <label style="display: inline-flex; align-items: center; gap: 6px;">
          <span class="helper-text" style="margin: 0;">状態を変更:</span>
          <select id="detail-state-select" class="select" style="width: auto; padding: 4px 8px; font-size: 0.875rem;">
            <option value="untouched" ${p.reviewState === "untouched" ? "selected" : ""}>未着手</option>
            <option value="reviewing" ${p.reviewState === "reviewing" ? "selected" : ""}>確認中</option>
            <option value="done" ${p.reviewState === "done" ? "selected" : ""}>復習済み</option>
          </select>
        </label>
      </div>
    </div>

    <div class="mode-switch-bar ${isRetry ? "is-retry" : ""}">
      <div>
        <strong>現在の表示：${isRetry ? "再挑戦モード（解答・メモを隠しています）" : "通常閲覧モード"}</strong>
      </div>
      <div class="mode-buttons">
        <button type="button" class="mode-btn" id="mode-view-btn" aria-pressed="${!isRetry}">通常閲覧</button>
        <button type="button" class="mode-btn" id="mode-retry-btn" aria-pressed="${isRetry}">再挑戦（解答を隠す）</button>
      </div>
    </div>

    <div class="detail-grid has-two-columns">
      <section class="detail-panel" aria-labelledby="heading-problem-images">
        <h3 id="heading-problem-images" class="section-heading">問題</h3>
        ${
          p.problemText
            ? `<p class="pre-text-box">${escapeHtml(p.problemText)}</p>`
            : ""
        }
        <div id="detail-problem-images"></div>
      </section>

      <section class="detail-panel" aria-labelledby="heading-answer-section">
        <h3 id="heading-answer-section" class="section-heading">自分の答案・振り返りメモ</h3>
        ${
          hideAnswerAndMemo
            ? `
          <div class="hidden-answer-box">
            <p>再挑戦のため、答案画像と振り返りメモを非表示にしています。解き終わったあとに確認できます。</p>
            <button type="button" class="btn btn-primary" id="reveal-answer-btn">解答・メモを表示する</button>
          </div>
        `
            : `
          <div id="detail-answer-images"></div>
          <div class="memo-list">
            <div class="memo-block">
              <h4 class="memo-label">自分が試したこと・止まったところ</h4>
              <p class="memo-body">${
                p.memoTried ? escapeHtml(p.memoTried) : '<span class="helper-text">記録なし</span>'
              }</p>
            </div>
            <div class="memo-block">
              <h4 class="memo-label">解説で初めて分かった発想</h4>
              <p class="memo-body">${
                p.memoIdea ? escapeHtml(p.memoIdea) : '<span class="helper-text">記録なし</span>'
              }</p>
            </div>
            <div class="memo-block">
              <h4 class="memo-label">発想の手掛かりになる条件</h4>
              <p class="memo-body">${
                p.memoClue ? escapeHtml(p.memoClue) : '<span class="helper-text">記録なし</span>'
              }</p>
            </div>
          </div>
        `
        }
      </section>
    </div>

    ${renderAiProblemSection(p, hideAnswerAndMemo)}
  `;

  document.getElementById("detail-back-btn").addEventListener("click", () => navigate("list"));
  document.getElementById("detail-source-btn")?.addEventListener("click", () => {
    navigate("detail", { problemId: p.sourceProblemId });
  });
  document.getElementById("detail-edit-btn").addEventListener("click", () => {
    navigate("form", { problemId: p.id });
  });

  document.getElementById("detail-delete-btn").addEventListener("click", async () => {
    if (!window.confirm("この問題の記録を削除しますか？この操作は取り消せません。")) return;
    try {
      await deleteProblem(appState.user.id, p.id);
      navigate("list");
    } catch (err) {
      showBanner(err.message || "削除に失敗しました。", "error");
    }
  });

  document.getElementById("detail-state-select").addEventListener("change", async (e) => {
    const nextState = e.target.value;
    try {
      appState.detailProblem = await updateReviewState(appState.user.id, p.id, nextState);
      renderDetailView();
    } catch (err) {
      showBanner(err.message || "状態の更新に失敗しました。", "error");
    }
  });

  document.getElementById("mode-view-btn").addEventListener("click", () => {
    appState.detailMode = "view";
    appState.retryRevealed = false;
    renderDetailView();
  });

  document.getElementById("mode-retry-btn").addEventListener("click", () => {
    appState.detailMode = "retry";
    appState.retryRevealed = false;
    renderDetailView();
  });

  document.getElementById("reveal-answer-btn")?.addEventListener("click", () => {
    appState.retryRevealed = true;
    renderDetailView();
  });

  // AI操作イベント
  document.getElementById("run-ai-analyze-btn")?.addEventListener("click", async () => {
    appState.aiProblemRunning = true;
    appState.aiProblemError = "";
    renderDetailView();
    try {
      appState.detailProblem = await runProblemAiAnalysis(appState.user.id, p.id);
    } catch (err) {
      appState.aiProblemError = err.message || "AI読み取り・分析に失敗しました。";
    } finally {
      appState.aiProblemRunning = false;
      if (appState.route === "detail") {
        renderDetailView();
      }
    }
  });

  document.getElementById("copy-ocr-to-verified-btn")?.addEventListener("click", () => {
    const input = document.getElementById("verified-text-input");
    if (!input || !p.aiOcrResult) return;
    const chunks = [];
    if (p.aiOcrResult.problemText) chunks.push(`【問題】\n${p.aiOcrResult.problemText}`);
    if (p.aiOcrResult.answerText) chunks.push(`【答案】\n${p.aiOcrResult.answerText}`);
    input.value = chunks.join("\n\n");
    input.focus();
  });

  document.getElementById("save-verified-btn")?.addEventListener("click", async () => {
    const input = document.getElementById("verified-text-input");
    const msgEl = document.getElementById("verified-save-msg");
    if (!input || !msgEl) return;
    msgEl.className = "save-status-text is-saving";
    msgEl.textContent = "保存中…";
    try {
      appState.detailProblem = await saveUserVerifiedText(appState.user.id, p.id, input.value);
      appState.verifiedSaveMessage = "確認済み内容を保存しました。";
      msgEl.className = "save-status-text is-success";
      msgEl.textContent = appState.verifiedSaveMessage;
    } catch (err) {
      msgEl.className = "save-status-text is-error";
      msgEl.textContent = err.message || "保存に失敗しました。";
    }
  });

  document.getElementById("generate-similar-btn")?.addEventListener("click", async () => {
    const focusInput = document.getElementById("similar-focus-input");
    const focusNote = focusInput ? focusInput.value.trim() : "";
    appState.aiSimilarRunning = true;
    appState.aiProblemError = "";
    renderDetailView();
    try {
      const res = await generateSimilarProblem(appState.user.id, p.id, focusNote);
      appState.detailProblem = res.problem;
    } catch (err) {
      appState.aiProblemError = err.message || "類題の作成に失敗しました。";
    } finally {
      appState.aiSimilarRunning = false;
      if (appState.route === "detail") {
        renderDetailView();
      }
    }
  });

  els.viewRoot.querySelectorAll(".save-similar-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.simIndex);
      const sim = (p.aiSimilarProblems || [])[idx];
      if (!sim) return;
      btn.disabled = true;
      btn.textContent = "保存中…";
      try {
        const saved = await saveProblem(appState.user.id, {
          material: `${p.material}（AI類題）`,
          problemNumber: `${p.problemNumber} 類題: ${sim.title || idx + 1}`,
          unit: sim.unit || p.unit || "",
          reviewState: "untouched",
          problemText: sim.problemText || "",
          problemImages: [],
          answerImages: [],
          memoTried: "",
          memoIdea: [sim.answerText ? `答え: ${sim.answerText}` : "", sim.explanation || ""]
            .filter(Boolean)
            .join("\n\n"),
          memoClue: sim.hint || "",
          sourceProblemId: p.id,
        });
        showBanner("類題を問題一覧に保存しました。", "success");
        navigate("detail", { problemId: saved.id });
      } catch (err) {
        showBanner(err.message || "類題の保存に失敗しました。", "error");
        btn.disabled = false;
        btn.textContent = "この類題を問題一覧に保存する";
      }
    });
  });

  // 画像の非同期描画
  if (!p.problemImages?.length && p.problemText) {
    document.getElementById("detail-problem-images").innerHTML = "";
  } else {
    renderDetailImageList("detail-problem-images", p.problemImages, "問題画像");
  }
  if (!hideAnswerAndMemo) {
    renderDetailImageList("detail-answer-images", p.answerImages, "答案画像");
  }
}

async function renderDetailImageList(containerId, imageRefs, labelPrefix) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!imageRefs || imageRefs.length === 0) {
    container.innerHTML = `<p class="helper-text" style="margin: 0;">画像は登録されていません。</p>`;
    return;
  }

  container.innerHTML = imageRefs
    .map(
      (_, idx) => `
    <figure class="image-figure" id="${containerId}-fig-${idx}" style="margin-bottom: 12px;">
      <div class="helper-text">画像を読み込んでいます…</div>
    </figure>
  `
    )
    .join("");

  imageRefs.forEach((ref, idx) => {
    loadSingleImageIntoFigure(`${containerId}-fig-${idx}`, ref, `${labelPrefix} ${idx + 1}`);
  });
}

async function loadSingleImageIntoFigure(figId, ref, title) {
  const fig = document.getElementById(figId);
  if (!fig) return;

  const renderError = () => {
    fig.innerHTML = `
      <div class="image-error-box" role="alert">
        <span>画像を取得できませんでした（${escapeHtml(title)}）。</span>
        <button type="button" class="btn btn-secondary btn-sm retry-img-btn">再読み込み</button>
      </div>
    `;
    fig.querySelector(".retry-img-btn")?.addEventListener("click", () => {
      fig.innerHTML = `<div class="helper-text">再読み込み中…</div>`;
      loadSingleImageIntoFigure(figId, ref, title);
    });
  };

  try {
    const url = await resolveImageUrl(ref);
    fig.innerHTML = `
      <div class="image-frame">
        <img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" class="detail-img">
      </div>
      <div>
        <button type="button" class="btn btn-secondary btn-sm zoom-img-btn">拡大表示</button>
      </div>
    `;
    const imgEl = fig.querySelector(".detail-img");
    imgEl.addEventListener("error", renderError);
    imgEl.addEventListener("click", () => openImageModal(url, title));
    fig.querySelector(".zoom-img-btn").addEventListener("click", () => openImageModal(url, title));
  } catch {
    renderError();
  }
}

// ==========================================
// 4. 学習の整理（得意・苦手・取り組むべき範囲）
// ==========================================

async function loadAndRenderAnalysis() {
  appState.learningLoading = true;
  appState.learningError = "";
  renderAnalysisView();

  try {
    const [problems, summary] = await Promise.all([
      listProblems(appState.user.id),
      getLearningSummary(appState.user.id),
    ]);
    appState.problems = problems;
    appState.problemsLoaded = true;
    appState.learningSummary = summary;
  } catch (err) {
    appState.learningError = err.message || "学習整理の読み込みに失敗しました。";
  } finally {
    appState.learningLoading = false;
    if (appState.route === "analysis") {
      renderAnalysisView();
    }
  }
}

function renderEvidenceLinks(problemIds, problemMap) {
  const valid = (problemIds || []).map((id) => problemMap.get(id)).filter(Boolean);
  if (!valid.length) return "";
  return `
    <div class="evidence-links">
      <span class="helper-text" style="margin: 0;">根拠となった問題:</span>
      ${valid
        .map((prob) => {
          const st = REVIEW_STATE_LABELS[prob.reviewState] || REVIEW_STATE_LABELS.untouched;
          return `
            <button type="button" class="evidence-link-btn" data-problem-id="${escapeHtml(prob.id)}">
              <span>${escapeHtml(prob.material)} ${escapeHtml(prob.problemNumber)}（${escapeHtml(
            st.label
          )}）</span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderAnalysisSectionBlock(heading, items, problemMap, emptyText, isRecommended = false) {
  const list = Array.isArray(items) ? items : [];
  return `
    <section class="analysis-group">
      <h3 class="section-heading" style="margin: 0;">${escapeHtml(heading)}</h3>
      ${
        list.length === 0
          ? `<p class="helper-text" style="margin: 0;">${escapeHtml(emptyText)}</p>`
          : list
              .map(
                (item) => `
            <div class="analysis-item">
              <h4 class="analysis-item-title">${escapeHtml(item.title || "")}</h4>
              ${
                isRecommended && item.action
                  ? `<p class="analysis-item-body"><strong>取り組み方：</strong>${escapeHtml(
                      item.action
                    )}</p>`
                  : ""
              }
              <p class="analysis-item-body">${escapeHtml(item.reason || "")}</p>
              ${renderEvidenceLinks(item.problemIds, problemMap)}
            </div>
          `
              )
              .join("")
      }
    </section>
  `;
}

function renderAnalysisView() {
  if (appState.learningLoading) {
    els.viewRoot.innerHTML = `
      <div class="empty-state" role="status">
        <p>学習の整理を読み込んでいます…</p>
      </div>
    `;
    return;
  }

  if (appState.learningError && !appState.learningSummary && appState.problems.length === 0) {
    els.viewRoot.innerHTML = `
      <div class="empty-state" role="alert">
        <p style="color: var(--error-text);">${escapeHtml(appState.learningError)}</p>
        <button type="button" class="btn btn-secondary" id="retry-analysis-load-btn">再試行</button>
      </div>
    `;
    document.getElementById("retry-analysis-load-btn")?.addEventListener("click", loadAndRenderAnalysis);
    return;
  }

  const problemMap = new Map(appState.problems.map((p) => [p.id, p]));
  const summary = appState.learningSummary;

  let bodyHtml = "";
  if (appState.problems.length === 0) {
    bodyHtml = `
      <div class="empty-state">
        <p>まだ問題の記録がありません。「+ 記録を追加」から問題を登録すると、得意・苦手や取り組むべき範囲を整理できます。</p>
        <button type="button" class="btn btn-primary" id="analysis-add-btn">+ 記録を追加</button>
      </div>
    `;
  } else if (!summary) {
    bodyHtml = `
      <div class="empty-state">
        <p>現在 ${appState.problems.length} 件の記録があります。「最新の記録で分析を更新」を押すと、AIが現在の記録をもとに得意傾向・重点範囲・取り組むべき順番を整理します。</p>
      </div>
    `;
  } else {
    bodyHtml = `
      <section class="analysis-group">
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;">
          <span class="origin-badge is-ai">AIによる学習の整理（参考）</span>
          ${
            summary.generatedAt
              ? `<span class="helper-text" style="margin: 0;">更新日: ${escapeHtml(
                  formatDate(summary.generatedAt)
                )}</span>`
              : ""
          }
        </div>
        <p class="analysis-item-body">${escapeHtml(summary.overview || "")}</p>
      </section>

      ${renderAnalysisSectionBlock(
        "現在取り組むべき範囲",
        summary.recommendedScope,
        problemMap,
        "提案項目はありません。",
        true
      )}

      ${renderAnalysisSectionBlock(
        "重点的に確認したい分野（つまずき傾向）",
        summary.focusAreas,
        problemMap,
        "重点確認の項目はありません。"
      )}

      ${renderAnalysisSectionBlock(
        "安定して解けている分野（得意傾向）",
        summary.strongAreas,
        problemMap,
        "記録が増えると安定している傾向が表示されます。"
      )}
    `;
  }

  els.viewRoot.innerHTML = `
    <div class="analysis-page-header">
      <div class="analysis-page-header-text">
        <h2 class="page-heading" style="margin-bottom: 4px;">学習の整理</h2>
        <p class="helper-text" style="margin: 0;">記録とメモをもとに、得意・苦手な傾向と次に取り組む範囲を整理します。</p>
      </div>
      <button type="button" class="btn btn-primary" id="run-overall-analysis-btn" ${
        appState.learningRunning || appState.problems.length === 0 ? "disabled" : ""
      }>
        ${appState.learningRunning ? "分析を更新中…" : "最新の記録で分析を更新"}
      </button>
    </div>

    ${
      appState.learningError
        ? `<div class="status-banner is-error" role="alert">${escapeHtml(appState.learningError)}</div>`
        : ""
    }

    ${bodyHtml}
  `;

  document.getElementById("analysis-add-btn")?.addEventListener("click", () => {
    appState.editingProblemId = null;
    navigate("form");
  });

  document.getElementById("run-overall-analysis-btn")?.addEventListener("click", async () => {
    appState.learningRunning = true;
    appState.learningError = "";
    renderAnalysisView();
    try {
      appState.learningSummary = await runOverallLearningAnalysis(appState.user.id);
    } catch (err) {
      appState.learningError = err.message || "学習の整理に失敗しました。";
    } finally {
      appState.learningRunning = false;
      if (appState.route === "analysis") {
        renderAnalysisView();
      }
    }
  });

  els.viewRoot.querySelectorAll(".evidence-link-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.problemId;
      if (targetId) {
        navigate("detail", { problemId: targetId });
      }
    });
  });
}

// ==========================================
// 5. データ・設定画面
// ==========================================

function renderDataView() {
  const cfg = getRuntimeConfig();
  const cloud = isCloudConfigured(cfg);

  els.viewRoot.innerHTML = `
    <h2 class="page-heading">データ管理・同期設定</h2>

    <section class="data-section">
      <h3 class="section-heading">複数端末での同期設定（Supabase）</h3>
      <p class="helper-text" style="margin: 0;">
        どの機種（PC・Chromebook・スマホ）からログインしても同じ問題・答案を閲覧するには、SupabaseプロジェクトのURLとanon keyを設定してください。
      </p>
      <div class="field">
        <label class="field-label" for="cfg-url">Supabase Project URL</label>
        <input class="input" type="url" id="cfg-url" value="${escapeHtml(
          cfg.supabaseUrl
        )}" placeholder="https://xxxxxxxxxxxx.supabase.co">
      </div>
      <div class="field">
        <label class="field-label" for="cfg-key">Supabase anon key</label>
        <input class="input" type="text" id="cfg-key" value="${escapeHtml(
          cfg.supabaseAnonKey
        )}" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...">
      </div>
      <div class="form-actions" style="margin-top: 4px;">
        <button type="button" class="btn btn-primary" id="save-cfg-btn">設定を保存して再読み込み</button>
        ${
          cloud
            ? `<button type="button" class="btn btn-secondary" id="clear-cfg-btn">ローカルモードに戻す</button>`
            : ""
        }
      </div>
    </section>

    <section class="data-section">
      <h3 class="section-heading">バックアップ（JSON書き出し）</h3>
      <p class="helper-text" style="margin: 0;">現在ログイン中の記録メタデータをJSONファイルとして保存します。</p>
      <div>
        <button type="button" class="btn btn-secondary" id="export-json-btn">記録をJSONで書き出す</button>
      </div>
    </section>

    <section class="data-section">
      <details class="data-tools-details">
        <summary>動作確認用ツール（テストデータ・エラー再現）</summary>
        <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 12px;">
          <p class="helper-text" style="margin: 0;">
            表示確認用の数学ダミーデータ（長文・複数行メモ・縦長/横長/複数枚画像・画像取得エラー）の投入や、通信エラー状態のシミュレーションを行えます。
          </p>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button type="button" class="btn btn-secondary" id="seed-sample-btn">サンプルデータ（3件）を追加</button>
            <button type="button" class="btn btn-danger" id="clear-all-btn">記録をすべて削除</button>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="sim-load-err" ${testSimulation.forceLoadError ? "checked" : ""}>
              <span>読み込み時の通信失敗を再現する</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="sim-save-err" ${testSimulation.forceSaveError ? "checked" : ""}>
              <span>保存時の通信失敗を再現する</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="sim-delay" ${testSimulation.extraDelayMs > 0 ? "checked" : ""}>
              <span>読み込み中・保存中の遅延（1.5秒）を再現する</span>
            </label>
          </div>
        </div>
      </details>
    </section>
  `;

  document.getElementById("save-cfg-btn").addEventListener("click", () => {
    const url = document.getElementById("cfg-url").value.trim();
    const key = document.getElementById("cfg-key").value.trim();
    if (!url || !key) {
      showBanner("Supabase URL と anon key の両方を入力してください。", "error");
      return;
    }
    saveRuntimeConfig({ supabaseUrl: url, supabaseAnonKey: key });
    window.location.reload();
  });

  document.getElementById("clear-cfg-btn")?.addEventListener("click", () => {
    clearRuntimeConfig();
    window.location.reload();
  });

  document.getElementById("export-json-btn").addEventListener("click", async () => {
    try {
      const items = await listProblems(appState.user.id);
      const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `math-review-backup-${formatDate(new Date().toISOString())}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showBanner(err.message || "書き出しに失敗しました。", "error");
    }
  });

  document.getElementById("seed-sample-btn").addEventListener("click", async () => {
    try {
      await seedSampleProblems(appState.user.id);
      showBanner("サンプルデータ（3件）を追加しました。一覧画面で確認できます。", "success");
    } catch (err) {
      showBanner(err.message || "追加に失敗しました。", "error");
    }
  });

  document.getElementById("clear-all-btn").addEventListener("click", async () => {
    if (!window.confirm("現在ログイン中の記録をすべて削除しますか？")) return;
    try {
      await clearUserProblems(appState.user.id);
      showBanner("すべての記録を削除しました。", "info");
    } catch (err) {
      showBanner(err.message || "削除に失敗しました。", "error");
    }
  });

  document.getElementById("sim-load-err").addEventListener("change", (e) => {
    testSimulation.forceLoadError = e.target.checked;
  });
  document.getElementById("sim-save-err").addEventListener("change", (e) => {
    testSimulation.forceSaveError = e.target.checked;
  });
  document.getElementById("sim-delay").addEventListener("change", (e) => {
    testSimulation.extraDelayMs = e.target.checked ? 1500 : 0;
  });
}

// ==========================================
// 初期化
// ==========================================

async function init() {
  try {
    appState.user = await getCurrentUser();
  } catch {
    appState.user = null;
  }

  if (appState.user) {
    navigate("list");
  } else {
    navigate("auth");
  }
}

init();
