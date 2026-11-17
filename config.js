// クラウド同期（Supabase）の設定
// どの端末からログインしても同じ問題・答案を閲覧するには、
// Supabase プロジェクトの URL と anon key をここに設定するか、
// アプリ内の「データ・設定」画面から入力してください。

export const DEFAULT_CONFIG = {
  supabaseUrl: "https://xpmgqhzmqyyzxjhepytn.supabase.co",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwbWdxaHptcXl5enhqaGVweXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5MTQ5ODksImV4cCI6MjExMDQ5MDk4OX0.6S8yEGm4RBcSfcfRmAFkQn51LSh-pLmBQeBVm3JbjPw",
  storageBucket: "math-review-images",
};

const CONFIG_OVERRIDE_KEY = "math_review_supabase_config_v1";

function normalizeSupabaseUrl(url) {
  const trimmed = (url || "").trim().replace(/\/+$/, "");
  return trimmed.replace(/\/rest\/v1$/i, "");
}

export function getRuntimeConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_OVERRIDE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        supabaseUrl: normalizeSupabaseUrl(parsed.supabaseUrl || DEFAULT_CONFIG.supabaseUrl),
        supabaseAnonKey: (parsed.supabaseAnonKey || DEFAULT_CONFIG.supabaseAnonKey || "").trim(),
        storageBucket: (parsed.storageBucket || DEFAULT_CONFIG.storageBucket || "math-review-images").trim(),
      };
    }
  } catch {
    // 無視してデフォルトを返す
  }
  return {
    ...DEFAULT_CONFIG,
    supabaseUrl: normalizeSupabaseUrl(DEFAULT_CONFIG.supabaseUrl),
  };
}

export function saveRuntimeConfig({ supabaseUrl, supabaseAnonKey }) {
  const payload = {
    supabaseUrl: normalizeSupabaseUrl(supabaseUrl),
    supabaseAnonKey: (supabaseAnonKey || "").trim(),
    storageBucket: DEFAULT_CONFIG.storageBucket,
  };
  localStorage.setItem(CONFIG_OVERRIDE_KEY, JSON.stringify(payload));
}

export function clearRuntimeConfig() {
  localStorage.removeItem(CONFIG_OVERRIDE_KEY);
}

export function isDemoMode() {
  try {
    return new URLSearchParams(window.location.search).get("demo") === "1";
  } catch {
    return false;
  }
}

export function isCloudConfigured(cfg = getRuntimeConfig()) {
  if (isDemoMode()) return false;
  return Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
}
