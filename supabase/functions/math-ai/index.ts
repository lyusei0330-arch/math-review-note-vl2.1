import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STORAGE_BUCKET = "math-review-images";
const GEMINI_MODEL = "gemini-2.5-flash";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

async function fetchStorageImagesAsParts(
  supabase: ReturnType<typeof createClient>,
  imageRefs: Array<{ storagePath?: string; name?: string }>,
  labelPrefix: string
) {
  const parts: Array<Record<string, unknown>> = [];
  let loadedCount = 0;

  for (let i = 0; i < (imageRefs || []).length; i++) {
    const ref = imageRefs[i];
    if (!ref?.storagePath) continue;
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(ref.storagePath);
    if (error || !data) continue;

    const buffer = new Uint8Array(await data.arrayBuffer());
    const mimeType = data.type || (ref.storagePath.endsWith(".png") ? "image/png" : "image/jpeg");
    parts.push({ text: `【${labelPrefix} ${i + 1}枚目】` });
    parts.push({
      inlineData: {
        mimeType,
        data: uint8ToBase64(buffer),
      },
    });
    loadedCount++;
  }
  return { parts, loadedCount };
}

async function callGeminiJson(apiKey: string, parts: Array<Record<string, unknown>>) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.3,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API エラー (${res.status}): ${errText.slice(0, 300)}`);
  }

  const payload = await res.json();
  const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error("AIからの応答が空でした。");
  }

  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  return JSON.parse(cleaned);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY") ?? "";

    if (!supabaseUrl || !supabaseAnonKey) {
      return jsonResponse({ error: "Supabase の環境変数が不足しています。" }, 500);
    }
    if (!geminiApiKey) {
      return jsonResponse(
        { error: "GEMINI_API_KEY が Supabase Secrets に設定されていません。" },
        500
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "ログイン情報が見つかりません。" }, 401);
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return jsonResponse({ error: "認証に失敗しました。再ログインしてください。" }, 401);
    }

    const body = await req.json();
    const action = body?.action;

    // ---------------------------------------------------------
    // 1. 個別問題の画像読み取り & 答案分析
    // ---------------------------------------------------------
    if (action === "analyze_problem") {
      const problemId = body?.problemId;
      if (!problemId) {
        return jsonResponse({ error: "problemId が必要です。" }, 400);
      }

      const { data: problem, error: fetchErr } = await userClient
        .from("problems")
        .select("*")
        .eq("id", problemId)
        .eq("user_id", user.id)
        .single();

      if (fetchErr || !problem) {
        return jsonResponse({ error: "対象の問題が見つかりません。" }, 404);
      }

      const probImgs = await fetchStorageImagesAsParts(
        userClient,
        problem.problem_images || [],
        "問題画像"
      );
      const ansImgs = await fetchStorageImagesAsParts(
        userClient,
        problem.answer_images || [],
        "答案画像"
      );

      const promptText = `
あなたは高校・大学受験レベルの数学学習を支援する落ち着いた家庭教師です。
以下の数学の問題情報・画像・本人の振り返りメモをもとに、
1) 画像の読み取り結果（問題文・手書き答案の文字起こし）
2) 答案とつまずきに関する分析案
を日本語で出力してください。

【ルール】
- 生徒を責めたり煽ったりする表現は使わず、穏やかで客観的な日本語にする。
- 数式はスマホやテキスト編集欄でも確認・訂正しやすいよう、過度なLaTeXコマンドを避け、読みやすい表記（例: x^2, f'(x), 1/2, √2, ≤, ≠）にする。
- 画像が不鮮明・判読が難しい箇所は推測で断定せず、uncertainNotes に具体的に列挙する。
- 画像が添付されていない場合や読み取れる情報が少ない場合は、その旨を正直に記し、入力されたメモ情報から分析する。

【問題メタ情報】
教材名: ${problem.material}
問題番号: ${problem.problem_number}
単元: ${problem.unit || "未設定"}
復習状態: ${problem.review_state}
登録された問題文テキスト: ${problem.problem_text || "なし"}
本人が試したこと・止まったところ: ${problem.memo_tried || "なし"}
解説で初めて分かった発想: ${problem.memo_idea || "なし"}
発想の手掛かりになる条件: ${problem.memo_clue || "なし"}
本人が確認・訂正済みのテキスト: ${problem.user_verified_text || "なし"}

【出力JSON形式】
{
  "ocr": {
    "problemText": "問題画像から読み取った問題文（画像がない場合は空文字またはその旨）",
    "answerText": "答案画像から読み取った解答内容（画像がない場合は空文字またはその旨）",
    "uncertainNotes": ["読み取りが不確かで本人に確認してほしい箇所（なければ空配列）"]
  },
  "analysis": {
    "summary": "全体的な状況の整理（2〜3文）",
    "strengths": "答案や試行錯誤でできていた点・良い方針",
    "bottlenecks": "つまずきやすい箇所や見直したいポイント",
    "nextAction": "次に確認・練習するとよい具体的な観点"
  }
}
`;

      const parts: Array<Record<string, unknown>> = [
        { text: promptText },
        ...probImgs.parts,
        ...ansImgs.parts,
      ];

      const aiJson = await callGeminiJson(geminiApiKey, parts);
      const now = new Date().toISOString();

      const ocrResult = {
        problemText: String(aiJson?.ocr?.problemText ?? ""),
        answerText: String(aiJson?.ocr?.answerText ?? ""),
        uncertainNotes: Array.isArray(aiJson?.ocr?.uncertainNotes)
          ? aiJson.ocr.uncertainNotes.map(String)
          : [],
        generatedAt: now,
      };

      const analysisResult = {
        summary: String(aiJson?.analysis?.summary ?? ""),
        strengths: String(aiJson?.analysis?.strengths ?? ""),
        bottlenecks: String(aiJson?.analysis?.bottlenecks ?? ""),
        nextAction: String(aiJson?.analysis?.nextAction ?? ""),
        generatedAt: now,
      };

      const { data: updated, error: updateErr } = await userClient
        .from("problems")
        .update({
          ai_ocr_result: ocrResult,
          ai_analysis: analysisResult,
        })
        .eq("id", problemId)
        .eq("user_id", user.id)
        .select()
        .single();

      if (updateErr) {
        return jsonResponse({ error: "分析結果の保存に失敗しました: " + updateErr.message }, 500);
      }

      return jsonResponse({ problem: updated });
    }

    // ---------------------------------------------------------
    // 2. 類題作成
    // ---------------------------------------------------------
    if (action === "generate_similar") {
      const problemId = body?.problemId;
      const focusNote = String(body?.focusNote || "").trim();
      if (!problemId) {
        return jsonResponse({ error: "problemId が必要です。" }, 400);
      }

      const { data: problem, error: fetchErr } = await userClient
        .from("problems")
        .select("*")
        .eq("id", problemId)
        .eq("user_id", user.id)
        .single();

      if (fetchErr || !problem) {
        return jsonResponse({ error: "対象の問題が見つかりません。" }, 404);
      }

      const probImgs = await fetchStorageImagesAsParts(
        userClient,
        problem.problem_images || [],
        "元の問題画像"
      );

      const promptText = `
あなたは数学の教材作成を担当する落ち着いた講師です。
以下の元の問題と学習記録を踏まえ、同じ解法・発想の定着を確かめるための「類題」を1問作成してください。

【ルール】
- 元の問題と完全に同じ数値にせず、条件・係数・設定を適度に変えて再挑戦に値する問題にする。
- 問題の成立条件（解が存在するか、整数解になるか等）が数学的に矛盾しないよう必ず検算すること。
- もし画像や確認済みテキストから問題文が特定できない場合は、単元名とメモの内容に合った標準的な類題を1問作成する。
- 数式はテキストでそのまま読みやすい表記（例: x^2, f'(x), 1/2, √3, ≤, ≠）にする。

【元の問題情報】
教材名: ${problem.material}
問題番号: ${problem.problem_number}
単元: ${problem.unit || "未設定"}
登録された問題文テキスト: ${problem.problem_text || "なし"}
本人の確認済みテキスト: ${problem.user_verified_text || "なし"}
AI読み取り問題文: ${problem.ai_ocr_result?.problemText || "なし"}
本人が試したこと・止まったところ: ${problem.memo_tried || "なし"}
解説で分かった発想: ${problem.memo_idea || "なし"}
発想の手掛かり: ${problem.memo_clue || "なし"}
利用者からの要望: ${focusNote || "特になし（元の問題と同程度の標準的な類題）"}

【出力JSON形式】
{
  "title": "類題の短い見出し（例：3次関数の極値条件の類題）",
  "unit": "単元名",
  "problemText": "類題の問題文（小問があれば改行して整理）",
  "hint": "解く前に詰まったときに見る短いヒント",
  "answerText": "最終的な答え",
  "explanation": "発想のポイントを含めた丁寧な解答・解説"
}
`;

      const parts: Array<Record<string, unknown>> = [{ text: promptText }, ...probImgs.parts];
      const aiJson = await callGeminiJson(geminiApiKey, parts);
      const now = new Date().toISOString();

      const newSimilar = {
        id: crypto.randomUUID(),
        title: String(aiJson?.title ?? "類題"),
        unit: String(aiJson?.unit ?? problem.unit ?? ""),
        problemText: String(aiJson?.problemText ?? ""),
        hint: String(aiJson?.hint ?? ""),
        answerText: String(aiJson?.answerText ?? ""),
        explanation: String(aiJson?.explanation ?? ""),
        createdAt: now,
      };

      const currentList = Array.isArray(problem.ai_similar_problems)
        ? problem.ai_similar_problems
        : [];
      const nextList = [newSimilar, ...currentList];

      const { data: updated, error: updateErr } = await userClient
        .from("problems")
        .update({ ai_similar_problems: nextList })
        .eq("id", problemId)
        .eq("user_id", user.id)
        .select()
        .single();

      if (updateErr) {
        return jsonResponse({ error: "類題の保存に失敗しました: " + updateErr.message }, 500);
      }

      return jsonResponse({ problem: updated, generatedSimilar: newSimilar });
    }

    // ---------------------------------------------------------
    // 3. 全体の得意・苦手分析と現在取り組むべき範囲
    // ---------------------------------------------------------
    if (action === "analyze_overall") {
      const { data: problems, error: listErr } = await userClient
        .from("problems")
        .select(
          "id, material, problem_number, unit, review_state, memo_tried, memo_idea, memo_clue, user_verified_text, ai_analysis, updated_at"
        )
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(60);

      if (listErr) {
        return jsonResponse({ error: "問題記録の取得に失敗しました: " + listErr.message }, 500);
      }

      if (!problems || problems.length === 0) {
        return jsonResponse(
          { error: "分析対象の問題記録がまだありません。1件以上登録してからお試しください。" },
          400
        );
      }

      const validIds = new Set(problems.map((p) => p.id));
      const compactList = problems.map((p) => ({
        id: p.id,
        material: p.material,
        problemNumber: p.problem_number,
        unit: p.unit || "未設定",
        reviewState: p.review_state,
        memoTried: (p.memo_tried || "").slice(0, 200),
        memoIdea: (p.memo_idea || "").slice(0, 200),
        aiBottleneck: (p.ai_analysis?.bottlenecks || "").slice(0, 200),
      }));

      const promptText = `
あなたは数学の学習計画をサポートする落ち着いたアドバイザーです。
以下の生徒の学習記録一覧（最大60件）をもとに、
1) 全体の落ち着いた整理
2) 安定して取り組めている・得意傾向の分野
3) つまずきが見られる・重点確認したい分野
4) 現在取り組むべき範囲と具体的な進め方
をまとめてください。

【絶対ルール】
- 未復習や遅れを責める表現（「サボっている」「遅れている」「危険」など）は一切使わない。
- 根拠のない推測はせず、必ず渡された記録（id）に基づいて整理する。
- strongAreas, focusAreas, recommendedScope の各項目には、必ずその根拠となった問題ID配列 "problemIds"（渡された id の中から該当するものを1件以上）を含めること。

【学習記録データ】
${JSON.stringify(compactList)}

【出力JSON形式】
{
  "overview": "現在の記録全体の落ち着いたまとめ（2〜3文）",
  "strongAreas": [
    {
      "title": "安定している単元や発想",
      "reason": "記録から読み取れる理由",
      "problemIds": ["該当する問題id"]
    }
  ],
  "focusAreas": [
    {
      "title": "重点的に確認したい単元やパターン",
      "reason": "つまずき傾向や見直しポイント",
      "problemIds": ["該当する問題id"]
    }
  ],
  "recommendedScope": [
    {
      "title": "現在取り組むべき範囲のタイトル",
      "action": "具体的にどう復習するとよいか（例：再挑戦モードで解き直す）",
      "reason": "なぜこの範囲から取り組むとよいか",
      "problemIds": ["該当する問題id"]
    }
  ]
}
`;

      const aiJson = await callGeminiJson(geminiApiKey, [{ text: promptText }]);
      const now = new Date().toISOString();

      const sanitizeItems = (arr: unknown, includeAction = false) => {
        if (!Array.isArray(arr)) return [];
        return arr.map((item) => {
          const obj = (item || {}) as Record<string, unknown>;
          const ids = Array.isArray(obj.problemIds)
            ? obj.problemIds.map(String).filter((id) => validIds.has(id))
            : [];
          const base: Record<string, unknown> = {
            title: String(obj.title ?? ""),
            reason: String(obj.reason ?? ""),
            problemIds: ids,
          };
          if (includeAction) {
            base.action = String(obj.action ?? "");
          }
          return base;
        });
      };

      const summaryPayload = {
        overview: String(aiJson?.overview ?? ""),
        strongAreas: sanitizeItems(aiJson?.strongAreas),
        focusAreas: sanitizeItems(aiJson?.focusAreas),
        recommendedScope: sanitizeItems(aiJson?.recommendedScope, true),
        generatedAt: now,
      };

      const { error: upsertErr } = await userClient.from("learning_summaries").upsert({
        user_id: user.id,
        analysis: summaryPayload,
        updated_at: now,
      });

      if (upsertErr) {
        return jsonResponse(
          { error: "分析結果の保存に失敗しました: " + upsertErr.message },
          500
        );
      }

      return jsonResponse({ summary: summaryPayload });
    }

    return jsonResponse({ error: `未対応のアクションです: ${action}` }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : "サーバー処理中にエラーが発生しました。";
    return jsonResponse({ error: message }, 500);
  }
});
