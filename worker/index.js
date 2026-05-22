/**
 * LLM Council Worker — ESモジュール形式
 *
 * リクエスト:
 *   { password, prompt, mode?, target?, shared_context? }
 *   mode    : "council" (default) | "ask" | "review"
 *   target  : "openai" | "anthropic" | "gemini"  — ask/review で使用
 *
 * レスポンス:
 *   { openai: {ok, text}, anthropic: {ok, text}, gemini: {ok, text} }
 *   review 時は target の結果に is_review: true が付く
 */

/* ═══════════════════════════════════════════════════════════
   定数
════════════════════════════════════════════════════════════ */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const AI_ALL   = ["openai", "anthropic", "gemini"];
const AI_LABEL = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini" };

/* ═══════════════════════════════════════════════════════════
   エントリーポイント
════════════════════════════════════════════════════════════ */

export default {
  async fetch(request, env) {
    // ── CORS プリフライト ──
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return jsonRes({ error: "Method Not Allowed" }, 405);
    }

    // ── ボディ解析 ──
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonRes({ error: "Invalid JSON" }, 400);
    }

    const {
      password,
      prompt,
      mode           = "council",   // 後方互換: 省略時は council
      target         = "anthropic",
      shared_context = "",
    } = body;

    if (!password || !prompt) {
      return jsonRes({ error: "password と prompt が必要です" }, 400);
    }

    // ── 認証（KV） ──
    const correctPassword = await env.COUNCIL_KV.get("password");
    if (password !== correctPassword) {
      return jsonRes({ error: "パスワードが違います" }, 401);
    }

    // ── API キー取得（KV） ──
    const [openaiKey, anthropicKey, geminiKey] = await Promise.all([
      env.COUNCIL_KV.get("openai_key"),
      env.COUNCIL_KV.get("anthropic_key"),
      env.COUNCIL_KV.get("gemini_key"),
    ]);
    const keys = { openai: openaiKey, anthropic: anthropicKey, gemini: geminiKey };

    // ── モード振り分け ──
    const validModes   = ["council", "ask", "review"];
    const validTargets = ["openai", "anthropic", "gemini"];

    if (!validModes.includes(mode)) {
      return jsonRes({ error: `不明なモード: ${mode}` }, 400);
    }
    if ((mode === "ask" || mode === "review") && !validTargets.includes(target)) {
      return jsonRes({ error: `不明なターゲット: ${target}` }, 400);
    }

    let result;
    if (mode === "ask") {
      result = await handleAsk(keys, prompt, target, shared_context);
    } else if (mode === "review") {
      result = await handleReview(keys, prompt, target, shared_context);
    } else {
      result = await handleCouncil(keys, prompt, shared_context);
    }

    return jsonRes(result);
  },
};

/* ═══════════════════════════════════════════════════════════
   プロンプト構築（orchestrator.py の build_prompt を移植）
════════════════════════════════════════════════════════════ */

/**
 * @param {string}  question      - ユーザーの質問
 * @param {string}  sharedContext - 共有コンテキスト（任意）
 * @param {string}  mode          - "ask" | "review"
 * @param {string|null} summary   - review 時の他AI回答まとめ
 */
function buildPrompt(question, sharedContext, mode = "ask", summary = null) {
  const parts = [];

  if (sharedContext) {
    parts.push(`【共有コンテキスト】\n${sharedContext}`);
  }

  if (mode === "review" && summary) {
    parts.push(`他モデルの回答:\n${summary}`);
    parts.push(`質問: ${question}`);
    parts.push("他モデルの回答を参考にしつつ、あなた自身の見解を日本語で述べてください。");
  } else {
    parts.push(`質問: ${question}`);
    parts.push("上記を踏まえて日本語で答えてください。");
  }

  return parts.join("\n\n");
}

/* ═══════════════════════════════════════════════════════════
   モード別ハンドラー
════════════════════════════════════════════════════════════ */

/** COUNCIL: 3AI 同時並列 */
async function handleCouncil(keys, prompt, sharedContext) {
  const p = buildPrompt(prompt, sharedContext);
  const [openai, anthropic, gemini] = await Promise.all([
    callOpenAI(keys.openai, p),
    callAnthropic(keys.anthropic, p),
    callGemini(keys.gemini, p),
  ]);
  return { openai, anthropic, gemini };
}

/** ASK: 指定 1AI のみ、残りは空レスポンス */
async function handleAsk(keys, prompt, target, sharedContext) {
  const p      = buildPrompt(prompt, sharedContext);
  const result = await callAI(keys, target, p);

  // 残り2つは空（GUI 側で非表示にする）
  const base = {
    openai:    { ok: false, text: "" },
    anthropic: { ok: false, text: "" },
    gemini:    { ok: false, text: "" },
  };
  base[target] = result;
  return base;
}

/**
 * REVIEW: orchestrator.py の cmd_review を移植
 *   1. 他2AI に基本プロンプトを並列送信
 *   2. 成功した回答を summary に結合
 *   3. target AI に review プロンプトを送信
 */
async function handleReview(keys, prompt, target, sharedContext) {
  const others = AI_ALL.filter(ai => ai !== target);

  // Step 1: 他2AI に並列質問
  const basePrompt = buildPrompt(prompt, sharedContext);
  const [res0, res1] = await Promise.all([
    callAI(keys, others[0], basePrompt),
    callAI(keys, others[1], basePrompt),
  ]);

  // Step 2: summary 構築（失敗 AI は除外）
  const summaryParts = [];
  const otherResults = {};
  [[others[0], res0], [others[1], res1]].forEach(([ai, res]) => {
    otherResults[ai] = res;
    if (res.ok) {
      summaryParts.push(`【${AI_LABEL[ai]}】\n${res.text}`);
    }
  });
  const summary = summaryParts.length > 0
    ? summaryParts.join("\n\n")
    : "(他 AI の回答を取得できませんでした)";

  // Step 3: target AI に review プロンプトを送信
  const reviewPrompt  = buildPrompt(prompt, sharedContext, "review", summary);
  const reviewResult  = await callAI(keys, target, reviewPrompt);

  // レスポンス組み立て
  const base = {
    openai:    { ok: false, text: "" },
    anthropic: { ok: false, text: "" },
    gemini:    { ok: false, text: "" },
  };
  base[others[0]] = otherResults[others[0]];
  base[others[1]] = otherResults[others[1]];
  base[target]    = { ...reviewResult, is_review: true };  // GUI がゴールドボーダー判定に使う

  return base;
}

/* ═══════════════════════════════════════════════════════════
   API 呼び出し
════════════════════════════════════════════════════════════ */

function callAI(keys, ai, prompt) {
  if (ai === "openai")    return callOpenAI(keys.openai, prompt);
  if (ai === "anthropic") return callAnthropic(keys.anthropic, prompt);
  if (ai === "gemini")    return callGemini(keys.gemini, prompt);
  return Promise.resolve({ ok: false, text: `不明な AI: ${ai}` });
}

/** OpenAI — GPT-4o */
async function callOpenAI(apiKey, prompt) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:      "gpt-4o",
        messages:   [{ role: "user", content: prompt }],
        max_tokens: 1500,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "OpenAI error");
    return { ok: true, text: data.choices[0].message.content };
  } catch (e) {
    return { ok: false, text: `エラー: ${e.message}` };
  }
}

/** Anthropic — Claude Haiku */
async function callAnthropic(apiKey, prompt) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages:   [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "Anthropic error");
    return { ok: true, text: data.content[0].text };
  } catch (e) {
    return { ok: false, text: `エラー: ${e.message}` };
  }
}

/** Google — Gemini 1.5 Pro */
async function callGemini(apiKey, prompt) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1500 },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "Gemini error");
    return { ok: true, text: data.candidates[0].content.parts[0].text };
  } catch (e) {
    return { ok: false, text: `エラー: ${e.message}` };
  }
}

/* ═══════════════════════════════════════════════════════════
   ヘルパー
════════════════════════════════════════════════════════════ */

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
