import { getRuntimeConfig, isCloudConfigured } from "./config.js";

const LOCAL_USERS_KEY = "math_review_local_users_v1";
const LOCAL_SESSION_KEY = "math_review_local_session_v1";
const LOCAL_PROBLEMS_KEY = "math_review_local_problems_v1";
const IDB_NAME = "math_review_images_db";
const IDB_STORE = "images";

// テスト・動作確認用シミュレーション状態（データ管理画面から切り替え可能）
export const testSimulation = {
  forceLoadError: false,
  forceSaveError: false,
  extraDelayMs: 0,
};

let supabaseClient = null;
let supabaseLoadedKey = "";

async function getSupabase() {
  const cfg = getRuntimeConfig();
  if (!isCloudConfigured(cfg)) {
    throw new Error("クラウド同期が設定されていません。");
  }
  const cacheKey = `${cfg.supabaseUrl}::${cfg.supabaseAnonKey}`;
  if (supabaseClient && supabaseLoadedKey === cacheKey) {
    return { client: supabaseClient, bucket: cfg.storageBucket };
  }
  const mod = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  supabaseClient = mod.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  supabaseLoadedKey = cacheKey;
  return { client: supabaseClient, bucket: cfg.storageBucket };
}

function wait(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export function generateId() {
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

// IndexedDB（ローカルモード用画像保存）
function openImageDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 画像圧縮（スマホ撮影画像の軽量化・読みやすさ維持）
export async function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("画像形式を読み取れませんでした。"));
      img.onload = () => {
        const maxSide = 1600;
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          if (width >= height) {
            height = Math.round((height * maxSide) / width);
            width = maxSide;
          } else {
            width = Math.round((width * maxSide) / height);
            height = maxSide;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("画像の変換に失敗しました。"));
              return;
            }
            resolve({
              id: generateId(),
              name: file.name || "image.jpg",
              dataUrl,
              blob,
              width,
              height,
            });
          },
          "image/jpeg",
          0.85
        );
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ==========================================
// 認証API
// ==========================================

export async function getCurrentUser() {
  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    const { data, error } = await client.auth.getUser();
    if (error) return null;
    return data.user ? { id: data.user.id, email: data.user.email, mode: "cloud" } : null;
  }
  const raw = localStorage.getItem(LOCAL_SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    return session && session.id ? { ...session, mode: "local" } : null;
  } catch {
    return null;
  }
}

function translateAuthError(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("invalid login credentials")) {
    return "メールアドレスまたはパスワードが正しくありません。";
  }
  if (m.includes("email not confirmed")) {
    return "メールアドレスの確認が完了していません。受信メール内のリンクを開くか、Supabase の Confirm email 設定をご確認ください。";
  }
  if (m.includes("user already registered")) {
    return "このメールアドレスはすでに登録されています。ログインをお試しください。";
  }
  if (m.includes("password should be at least")) {
    return "パスワードは6文字以上で入力してください。";
  }
  if (m.includes("rate limit") || m.includes("too many requests")) {
    return "試行回数が多すぎます。少し時間をおいてから再度お試しください。";
  }
  return msg || "認証処理に失敗しました。";
}

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(",");
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const binary = atob(parts[1]);
  const len = binary.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    arr[i] = binary.charCodeAt(i);
  }
  return new Blob([arr], { type: mime });
}

export async function signUpWithEmail(email, password) {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password || password.length < 6) {
    throw new Error("メールアドレスと6文字以上のパスワードを入力してください。");
  }
  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    const { data, error } = await client.auth.signUp({ email: cleanEmail, password });
    if (error) throw new Error(translateAuthError(error.message));
    if (!data.user) throw new Error("登録に失敗しました。");
    return {
      user: { id: data.user.id, email: data.user.email, mode: "cloud" },
      needsEmailConfirm: !data.session,
    };
  }

  const users = JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || "[]");
  if (users.some((u) => u.email === cleanEmail)) {
    throw new Error("このメールアドレスはすでに登録されています。");
  }
  const newUser = { id: generateId(), email: cleanEmail, password };
  users.push(newUser);
  localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
  const session = { id: newUser.id, email: newUser.email };
  localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(session));
  return { user: { ...session, mode: "local" }, needsEmailConfirm: false };
}

export async function signInWithEmail(email, password) {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password) {
    throw new Error("メールアドレスとパスワードを入力してください。");
  }
  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    const { data, error } = await client.auth.signInWithPassword({ email: cleanEmail, password });
    if (error) throw new Error(translateAuthError(error.message));
    return { id: data.user.id, email: data.user.email, mode: "cloud" };
  }

  const users = JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || "[]");
  const found = users.find((u) => u.email === cleanEmail && u.password === password);
  if (!found) {
    throw new Error("メールアドレスまたはパスワードが正しくありません。");
  }
  const session = { id: found.id, email: found.email };
  localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(session));
  return { ...session, mode: "local" };
}

export async function signOutUser() {
  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    await client.auth.signOut();
  }
  localStorage.removeItem(LOCAL_SESSION_KEY);
}

// ==========================================
// 問題データAPI
// ==========================================

function readLocalProblemsMap() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_PROBLEMS_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeLocalProblemsMap(map) {
  localStorage.setItem(LOCAL_PROBLEMS_KEY, JSON.stringify(map));
}

export async function listProblems(userId) {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceLoadError) {
    throw new Error("サーバーとの通信に失敗しました（テスト用エラー）。");
  }

  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    const { data, error } = await client
      .from("problems")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error("問題一覧の取得に失敗しました: " + error.message);
    return (data || []).map(normalizeRecord);
  }

  const map = readLocalProblemsMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  return list
    .map(normalizeRecord)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function getProblemById(userId, problemId) {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceLoadError) {
    throw new Error("問題データの取得に失敗しました（テスト用エラー）。");
  }

  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    const { data, error } = await client
      .from("problems")
      .select("*")
      .eq("user_id", userId)
      .eq("id", problemId)
      .single();
    if (error) throw new Error("問題の取得に失敗しました。");
    return normalizeRecord(data);
  }

  const map = readLocalProblemsMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  const found = list.find((p) => p.id === problemId);
  if (!found) throw new Error("指定された問題が見つかりません。");
  return normalizeRecord(found);
}

export async function resolveImageUrl(imageRef) {
  if (!imageRef) return null;
  // 破損テスト用URL
  if (imageRef.broken) {
    return "invalid://broken-image-for-test";
  }
  // すでにDataURLや一時URLがある場合
  if (imageRef.dataUrl) return imageRef.dataUrl;

  if (isCloudConfigured() && imageRef.storagePath) {
    const { client, bucket } = await getSupabase();
    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUrl(imageRef.storagePath, 3600);
    if (error || !data?.signedUrl) {
      throw new Error("画像URLの取得に失敗しました。");
    }
    return data.signedUrl;
  }

  if (imageRef.id) {
    const stored = await idbGet(imageRef.id);
    if (stored) return stored;
  }
  throw new Error("画像データが見つかりませんでした。");
}

export async function saveProblem(userId, problemInput) {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceSaveError) {
    throw new Error("ネットワークエラーにより保存できませんでした（テスト用エラー）。");
  }

  const problemId = problemInput.id || generateId();
  const now = new Date().toISOString();

  if (isCloudConfigured()) {
    const { client, bucket } = await getSupabase();
    const uploadImages = async (items, kind) => {
      const results = [];
      for (const item of items) {
        if (item.broken) {
          results.push({ id: item.id, name: item.name, broken: true });
          continue;
        }
        if (item.storagePath) {
          results.push({ id: item.id, name: item.name, storagePath: item.storagePath });
          continue;
        }
        const blob = item.blob || (item.dataUrl ? dataUrlToBlob(item.dataUrl) : null);
        if (blob) {
          const ext = blob.type === "image/png" ? "png" : "jpg";
          const path = `${userId}/${problemId}/${kind}_${item.id}.${ext}`;
          const { error: upErr } = await client.storage
            .from(bucket)
            .upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: true });
          if (upErr) throw new Error("画像のアップロードに失敗しました: " + upErr.message);
          results.push({ id: item.id, name: item.name, storagePath: path });
        }
      }
      return results;
    };

    const problemImages = await uploadImages(problemInput.problemImages || [], "problem");
    const answerImages = await uploadImages(problemInput.answerImages || [], "answer");

    const row = {
      id: problemId,
      user_id: userId,
      material: problemInput.material.trim(),
      problem_number: problemInput.problemNumber.trim(),
      unit: (problemInput.unit || "").trim(),
      review_state: problemInput.reviewState || "untouched",
      problem_images: problemImages,
      answer_images: answerImages,
      memo_tried: problemInput.memoTried || "",
      memo_idea: problemInput.memoIdea || "",
      memo_clue: problemInput.memoClue || "",
      updated_at: now,
    };
    if (problemInput.problemText !== undefined) {
      row.problem_text = problemInput.problemText;
    }
    if (!problemInput.id) {
      row.created_at = now;
      if (problemInput.sourceProblemId) {
        row.source_problem_id = problemInput.sourceProblemId;
      }
      if (problemInput.userVerifiedText) {
        row.user_verified_text = problemInput.userVerifiedText;
      }
    }

    const { data, error } = await client
      .from("problems")
      .upsert(row)
      .select()
      .single();
    if (error) throw new Error("保存に失敗しました: " + error.message);
    return normalizeRecord(data);
  }

  // ローカルモード保存（画像はIndexedDBへ）
  const persistLocalImages = async (items) => {
    const results = [];
    for (const item of items) {
      if (item.broken) {
        results.push({ id: item.id, name: item.name, broken: true });
        continue;
      }
      if (item.dataUrl) {
        await idbSet(item.id, item.dataUrl);
      }
      results.push({ id: item.id, name: item.name });
    }
    return results;
  };

  const problemImages = await persistLocalImages(problemInput.problemImages || []);
  const answerImages = await persistLocalImages(problemInput.answerImages || []);

  const map = readLocalProblemsMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  const existingIndex = list.findIndex((p) => p.id === problemId);
  const prev = existingIndex >= 0 ? list[existingIndex] : null;

  const record = {
    id: problemId,
    material: problemInput.material.trim(),
    problemNumber: problemInput.problemNumber.trim(),
    unit: (problemInput.unit || "").trim(),
    reviewState: problemInput.reviewState || "untouched",
    problemText:
      problemInput.problemText !== undefined ? problemInput.problemText : prev?.problemText ?? "",
    problemImages,
    answerImages,
    memoTried: problemInput.memoTried || "",
    memoIdea: problemInput.memoIdea || "",
    memoClue: problemInput.memoClue || "",
    aiOcrResult: prev ? prev.aiOcrResult ?? null : null,
    userVerifiedText:
      problemInput.userVerifiedText !== undefined
        ? problemInput.userVerifiedText
        : prev?.userVerifiedText ?? "",
    aiAnalysis: prev ? prev.aiAnalysis ?? null : null,
    aiSimilarProblems: prev ? prev.aiSimilarProblems ?? [] : [],
    sourceProblemId: problemInput.sourceProblemId ?? prev?.sourceProblemId ?? null,
    createdAt: prev ? prev.createdAt : now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    list[existingIndex] = record;
  } else {
    list.unshift(record);
  }
  map[userId] = list;
  writeLocalProblemsMap(map);
  return normalizeRecord(record);
}

export async function updateReviewState(userId, problemId, reviewState) {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceSaveError) {
    throw new Error("状態の更新に失敗しました（テスト用エラー）。");
  }
  const now = new Date().toISOString();

  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    const { data, error } = await client
      .from("problems")
      .update({ review_state: reviewState, updated_at: now })
      .eq("user_id", userId)
      .eq("id", problemId)
      .select()
      .single();
    if (error) throw new Error("状態の更新に失敗しました。");
    return normalizeRecord(data);
  }

  const map = readLocalProblemsMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  const idx = list.findIndex((p) => p.id === problemId);
  if (idx < 0) throw new Error("問題が見つかりません。");
  list[idx] = { ...list[idx], reviewState, updatedAt: now };
  map[userId] = list;
  writeLocalProblemsMap(map);
  return normalizeRecord(list[idx]);
}

export async function deleteProblem(userId, problemId) {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceSaveError) {
    throw new Error("削除に失敗しました（テスト用エラー）。");
  }

  if (isCloudConfigured()) {
    const { client, bucket } = await getSupabase();
    try {
      const target = await getProblemById(userId, problemId);
      const paths = [...target.problemImages, ...target.answerImages]
        .map((img) => img.storagePath)
        .filter(Boolean);
      if (paths.length > 0) {
        await client.storage.from(bucket).remove(paths);
      }
    } catch {
      // 画像削除に失敗してもレコード削除は続行
    }
    const { error } = await client
      .from("problems")
      .delete()
      .eq("user_id", userId)
      .eq("id", problemId);
    if (error) throw new Error("削除に失敗しました。");
    return;
  }

  const map = readLocalProblemsMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  const target = list.find((p) => p.id === problemId);
  if (target) {
    const imgs = [...(target.problemImages || []), ...(target.answerImages || [])];
    for (const img of imgs) {
      if (img.id) await idbDelete(img.id);
    }
  }
  map[userId] = list.filter((p) => p.id !== problemId);
  writeLocalProblemsMap(map);
}

function normalizeRecord(raw) {
  return {
    id: raw.id,
    material: raw.material || "",
    problemNumber: raw.problemNumber ?? raw.problem_number ?? "",
    unit: raw.unit || "",
    reviewState: raw.reviewState ?? raw.review_state ?? "untouched",
    problemText: raw.problemText ?? raw.problem_text ?? "",
    problemImages: raw.problemImages ?? raw.problem_images ?? [],
    answerImages: raw.answerImages ?? raw.answer_images ?? [],
    memoTried: raw.memoTried ?? raw.memo_tried ?? "",
    memoIdea: raw.memoIdea ?? raw.memo_idea ?? "",
    memoClue: raw.memoClue ?? raw.memo_clue ?? "",
    aiOcrResult: raw.aiOcrResult ?? raw.ai_ocr_result ?? null,
    userVerifiedText: raw.userVerifiedText ?? raw.user_verified_text ?? "",
    aiAnalysis: raw.aiAnalysis ?? raw.ai_analysis ?? null,
    aiSimilarProblems: Array.isArray(raw.aiSimilarProblems ?? raw.ai_similar_problems)
      ? raw.aiSimilarProblems ?? raw.ai_similar_problems
      : [],
    sourceProblemId: raw.sourceProblemId ?? raw.source_problem_id ?? null,
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    updatedAt: raw.updatedAt ?? raw.updated_at ?? new Date().toISOString(),
  };
}

// ==========================================
// テスト用サンプルデータ生成（SVG→PNG/DataURL）
// ==========================================
function makeDiagramDataUrl(width, height, title, lines) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#9CA3AF";
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);

  ctx.fillStyle = "#2B547E";
  ctx.font = "bold 24px sans-serif";
  ctx.fillText(title, 28, 48);

  ctx.fillStyle = "#1F2937";
  ctx.font = "18px sans-serif";
  lines.forEach((line, i) => {
    ctx.fillText(line, 28, 92 + i * 32);
  });

  // 簡単な図形（放物線や三角形など）
  ctx.strokeStyle = "#2B547E";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(40, height - 60);
  ctx.lineTo(width - 40, height - 60);
  ctx.moveTo(width / 2, 180);
  ctx.lineTo(width / 2, height - 40);
  ctx.stroke();

  return canvas.toDataURL("image/png");
}

export async function seedSampleProblems(userId) {
  const sampleItems = [
    {
      material: "青チャート 数学II+B（新課程版）",
      problemNumber: "基本例題142",
      unit: "微分法・積分法",
      reviewState: "reviewing",
      problemImages: [
        {
          id: generateId(),
          name: "problem_142_horizontal.png",
          dataUrl: makeDiagramDataUrl(760, 380, "問題：3次関数の極値と接線（横長画像）", [
            "f(x) = x^3 - 3ax^2 + 2a^2x が x = 1 で極大値をとるとき、",
            "定数 a の値と極小値を求めよ。",
          ]),
        },
      ],
      answerImages: [
        {
          id: generateId(),
          name: "answer_142_1_vertical.png",
          dataUrl: makeDiagramDataUrl(420, 760, "答案 1枚目（縦長手書きメモ風）", [
            "f'(x) = 3x^2 - 6ax + 2a^2",
            "x = 1 で極値をとるので f'(1) = 0",
            "3 - 6a + 2a^2 = 0 を解く",
            "増減表をかいて極大・極小を確認",
          ]),
        },
        {
          id: generateId(),
          name: "answer_142_2.png",
          dataUrl: makeDiagramDataUrl(600, 420, "答案 2枚目（複数枚テスト）", [
            "a の値ごとに極大となるか検証：",
            "f''(1) < 0 の条件で絞り込む",
          ]),
        },
      ],
      memoTried:
        "f'(1)=0 を立てるところまではできた。\nその後、2次方程式の2つの解のどちらが極大になるかを確認せず両方答えてしまった。",
      memoIdea:
        "「極値をとる」だけでなく「極大値をとる」条件なので、増減表または f''(1) < 0 の符号チェックが必須。\n必要条件で求めたあとに十分条件の確認を忘れない。",
      memoClue: "問題文の「x = 1 で極大値」という表現（極値ではなく極大と指定されている）。",
    },
    {
      material: "令和8年度 大学入学共通テスト対策 実戦問題集 数学I・A・II・B・C（駿台・河合・Z会 共通模試対策編集版）",
      problemNumber: "第3回 大問4(2) 小問イ〜オ【長文問題番号テスト】",
      unit: "数列・漸化式",
      reviewState: "untouched",
      problemImages: [
        {
          id: generateId(),
          name: "broken_test.png",
          broken: true,
        },
      ],
      answerImages: [],
      memoTried: "特性方程式がうまく立てられず、階差数列の形に変形しようとして計算が複雑になった。",
      memoIdea: "両辺を 2^(n+1) で割ると、b_n = a_n / 2^n の形の単純な等差数列に帰着できる。",
      memoClue: "漸化式の右辺に 2^n が掛かっていること。",
    },
    {
      material: "1対1対応の演習 数学III",
      problemNumber: "複素数平面 演習題8",
      unit: "複素数平面",
      reviewState: "done",
      problemImages: [],
      answerImages: [],
      memoTried: "z = x + yi と置いて成分計算してしまい、途中で式が膨らんだ。",
      memoIdea: "共役複素数と絶対値の性質 |z|^2 = z * z̄ をそのまま使うと幾何的にすぐ解ける。",
      memoClue: "条件式が z と z̄ について対称になっている点。",
    },
  ];

  for (const item of sampleItems) {
    await saveProblem(userId, item);
  }
}

export async function clearUserProblems(userId) {
  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    const { error } = await client.from("problems").delete().eq("user_id", userId);
    if (error) throw new Error("削除に失敗しました。");
    return;
  }
  const map = readLocalProblemsMap();
  map[userId] = [];
  writeLocalProblemsMap(map);
}

// ==========================================
// AI機能API（Supabase Edge Function 経由 / ローカルデモ）
// ==========================================

const LOCAL_SUMMARIES_KEY = "math_review_local_summaries_v1";

async function invokeMathAi(payload) {
  const { client } = await getSupabase();
  const { data, error } = await client.functions.invoke("math-ai", {
    body: payload,
  });

  if (error) {
    let detail = "";
    try {
      if (error.context && typeof error.context.json === "function") {
        const errBody = await error.context.json();
        detail = errBody?.error || "";
      }
    } catch {
      // ignore
    }
    if (detail) throw new Error(detail);
    const msg = String(error.message || "");
    if (msg.includes("Failed to fetch") || msg.includes("404") || msg.includes("Relay")) {
      throw new Error(
        "AI機能用のサーバー関数（math-ai）に接続できませんでした。Supabase Edge Functions の設定をご確認ください。"
      );
    }
    throw new Error(msg || "AI処理に失敗しました。");
  }
  if (data?.error) {
    throw new Error(data.error);
  }
  return data;
}

export async function saveUserVerifiedText(userId, problemId, verifiedText) {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceSaveError) {
    throw new Error("確認済みテキストの保存に失敗しました（テスト用エラー）。");
  }
  const now = new Date().toISOString();

  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    const { data, error } = await client
      .from("problems")
      .update({ user_verified_text: verifiedText, updated_at: now })
      .eq("user_id", userId)
      .eq("id", problemId)
      .select()
      .single();
    if (error) throw new Error("確認済みテキストの保存に失敗しました: " + error.message);
    return normalizeRecord(data);
  }

  const map = readLocalProblemsMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  const idx = list.findIndex((p) => p.id === problemId);
  if (idx < 0) throw new Error("問題が見つかりません。");
  list[idx] = { ...list[idx], userVerifiedText: verifiedText, updatedAt: now };
  map[userId] = list;
  writeLocalProblemsMap(map);
  return normalizeRecord(list[idx]);
}

export async function runProblemAiAnalysis(userId, problemId) {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceSaveError) {
    throw new Error("AI分析の通信に失敗しました（テスト用エラー）。");
  }

  if (isCloudConfigured()) {
    const res = await invokeMathAi({ action: "analyze_problem", problemId });
    return normalizeRecord(res.problem);
  }

  // ローカル保存モード用デモ結果
  const map = readLocalProblemsMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  const idx = list.findIndex((p) => p.id === problemId);
  if (idx < 0) throw new Error("問題が見つかりません。");
  const target = list[idx];
  const now = new Date().toISOString();

  const ocrResult = {
    problemText:
      target.problemImages?.length > 0
        ? `【読み取り例】${target.material} ${target.problemNumber} の問題文\n（関数 f(x) = x^3 - 3ax^2 + 2a^2x が x = 1 で極大値をとるときの定数 a と極小値を求めよ。）`
        : "問題画像が添付されていないため、メモ内容をもとに整理しました。",
    answerText:
      target.answerImages?.length > 0
        ? "【読み取り例】f'(x) = 3x^2 - 6ax + 2a^2\nx = 1 より 3 - 6a + 2a^2 = 0"
        : "答案画像は添付されていません。",
    uncertainNotes:
      target.problemImages?.length > 0 || target.answerImages?.length > 0
        ? [
            "手書き答案の2行目：指数「a^2」が「a2」に見える箇所があります。意図通りかご確認ください。",
            "※ 現在はローカルモードのためサンプル読み取りを表示しています。",
          ]
        : [],
    generatedAt: now,
  };

  const analysisResult = {
    summary: `「${target.unit || "この問題"}」では、必要条件を式に起こす部分まで順調に進められています。最後に条件を満たすかどうかの十分性の確認を手順として固定すると安定します。`,
    strengths:
      target.memoTried || "最初の立式（微分して = 0 とおく方針）は的確に捉えられています。",
    bottlenecks:
      target.memoIdea ||
      "2次方程式の解が複数出たあと、どちらが極大でどちらが極小になるかの符号判定が抜けやすい点です。",
    nextAction:
      "解が求まったら必ず「増減表」または「f''(1) の符号」を1行書いてから答えを確定する練習をしてみましょう。",
    generatedAt: now,
  };

  list[idx] = {
    ...target,
    aiOcrResult: ocrResult,
    aiAnalysis: analysisResult,
    updatedAt: now,
  };
  map[userId] = list;
  writeLocalProblemsMap(map);
  return normalizeRecord(list[idx]);
}

export async function generateSimilarProblem(userId, problemId, focusNote = "") {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceSaveError) {
    throw new Error("類題作成の通信に失敗しました（テスト用エラー）。");
  }

  if (isCloudConfigured()) {
    const res = await invokeMathAi({ action: "generate_similar", problemId, focusNote });
    return {
      problem: normalizeRecord(res.problem),
      generatedSimilar: res.generatedSimilar,
    };
  }

  // ローカル保存モード用デモ類題
  const map = readLocalProblemsMap();
  const list = Array.isArray(map[userId]) ? map[userId] : [];
  const idx = list.findIndex((p) => p.id === problemId);
  if (idx < 0) throw new Error("問題が見つかりません。");
  const target = list[idx];
  const now = new Date().toISOString();

  const newSimilar = {
    id: generateId(),
    title: `${target.unit || "数学"}の類題（条件確認の練習）`,
    unit: target.unit || "",
    problemText: `関数 g(x) = x^3 - 3kx^2 + 3(k^2 - 1)x が x = 2 で極小値をとるとき、定数 k の値と極大値を求めよ。${
      focusNote ? `\n（指定観点: ${focusNote}）` : ""
    }`,
    hint: "まず g'(2) = 0 から k の候補を2つ求め、それぞれで g''(2) > 0（または x = 2 の前後で g'(x) が負から正へ変わること）を確認しましょう。",
    answerText: "k = 2 ± √3 のうち極小条件を満たす側（増減表で確認）",
    explanation:
      "g'(x) = 3x^2 - 6kx + 3(k^2 - 1) = 3{(x - k)^2 - 1} より、x = k ± 1 で極値をとります。\n極小をとる側は x = k + 1 なので、k + 1 = 2 より k = 1 が確定します。このとき極大をとるのは x = 0 で、極大値は g(0) = 0 です。",
    createdAt: now,
  };

  const currentSimilar = Array.isArray(target.aiSimilarProblems) ? target.aiSimilarProblems : [];
  list[idx] = {
    ...target,
    aiSimilarProblems: [newSimilar, ...currentSimilar],
    updatedAt: now,
  };
  map[userId] = list;
  writeLocalProblemsMap(map);
  return {
    problem: normalizeRecord(list[idx]),
    generatedSimilar: newSimilar,
  };
}

export async function getLearningSummary(userId) {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceLoadError) {
    throw new Error("学習整理の読み込みに失敗しました（テスト用エラー）。");
  }

  if (isCloudConfigured()) {
    const { client } = await getSupabase();
    const { data, error } = await client
      .from("learning_summaries")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error("学習整理の取得に失敗しました: " + error.message);
    return data?.analysis && Object.keys(data.analysis).length > 0 ? data.analysis : null;
  }

  try {
    const map = JSON.parse(localStorage.getItem(LOCAL_SUMMARIES_KEY) || "{}");
    return map[userId] || null;
  } catch {
    return null;
  }
}

export async function runOverallLearningAnalysis(userId) {
  await wait(testSimulation.extraDelayMs);
  if (testSimulation.forceSaveError) {
    throw new Error("学習分析の実行に失敗しました（テスト用エラー）。");
  }

  if (isCloudConfigured()) {
    const res = await invokeMathAi({ action: "analyze_overall" });
    return res.summary;
  }

  // ローカル保存モード用デモ分析
  const problems = await listProblems(userId);
  if (problems.length === 0) {
    throw new Error("分析対象の問題記録がまだありません。1件以上登録してからお試しください。");
  }

  const doneItems = problems.filter((p) => p.reviewState === "done");
  const focusItems = problems.filter((p) => p.reviewState !== "done");
  const firstIds = problems.slice(0, 2).map((p) => p.id);

  const summary = {
    overview: `現在 ${problems.length} 件の記録があります。立式の出発点は押さえられている問題が多く、条件の最終確認や見直しの観点が言語化できています。`,
    strongAreas:
      doneItems.length > 0
        ? [
            {
              title: `${doneItems[0].unit || "復習済みの単元"} のアプローチ`,
              reason: "振り返りメモで方針の要点を簡潔に言語化できており、復習済みになっています。",
              problemIds: doneItems.slice(0, 3).map((p) => p.id),
            },
          ]
        : [
            {
              title: "途中までの立式と方針立て",
              reason: "記録されたメモから、問題文の条件を数式に置き換える段階が安定しています。",
              problemIds: firstIds,
            },
          ],
    focusAreas:
      focusItems.length > 0
        ? [
            {
              title: `${focusItems[0].unit || "確認中・未着手の問題"} の条件確認`,
              reason: "必要条件を出したあとの絞り込みや、式変形のきっかけを見直す余地があります。",
              problemIds: focusItems.slice(0, 3).map((p) => p.id),
            },
          ]
        : [],
    recommendedScope: [
      {
        title: "まずは手元にある確認中・未着手の問題を「再挑戦」で解き直す",
        action: "詳細画面の「再挑戦（解答を隠す）」を使い、1行目の立式と条件確認までを自力で書いてみてください。",
        reason: "解法の流れがメモに整理されているため、解答を隠して再現できるか確かめると定着しやすくなります。",
        problemIds: (focusItems.length > 0 ? focusItems : problems).slice(0, 3).map((p) => p.id),
      },
    ],
    generatedAt: new Date().toISOString(),
  };

  const map = JSON.parse(localStorage.getItem(LOCAL_SUMMARIES_KEY) || "{}");
  map[userId] = summary;
  localStorage.setItem(LOCAL_SUMMARIES_KEY, JSON.stringify(map));
  return summary;
}
