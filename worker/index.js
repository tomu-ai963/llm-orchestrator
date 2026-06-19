/**
 * LLM Council Worker — ESモジュール形式
 * v3: メモリ機能追加（KV永続化）
 * v4: gemini を grok（xAI）へ完全置換
 *
 * エンドポイント:
 *   POST /               — メイン（council / ask / review）
 *   POST /reset-memory   — メモリ削除
 *
 * リクエスト（メイン）:
 *   { password, prompt, mode?, target?, shared_context? }
 *   mode   : "council"(default) | "ask" | "review"
 *   target : "openai" | "anthropic" | "grok"
 *
 * レスポンス（メイン）:
 *   { openai, anthropic, grok, memory: { used, history_count } }
 *   review 時は target に is_review: true が付く
 */

/* ═══════════════════════════════════════════════════════════
   定数
════════════════════════════════════════════════════════════ */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const AI_ALL   = ["openai", "anthropic", "grok"];
export const AI_LABEL = { openai: "OpenAI", anthropic: "Anthropic", grok: "Grok" };

// 入力上限（KV/トークン浪費・悪用防止）。プロバイダー実装には影響しない入口ガード。
export const MAX_PROMPT_LEN  = 8000;
export const MAX_CONTEXT_LEN = 16000;

/* ═══════════════════════════════════════════════════════════
   エントリーポイント
════════════════════════════════════════════════════════════ */

export default {
  fetch: handleRequest,
};

export async function handleRequest(request, env, ctx) {
  // ── CORS プリフライト ──
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return jsonRes({ error: "Method Not Allowed" }, 405);
  }

  // ── URL ルーティング ──
  const pathname = new URL(request.url).pathname;
  if (pathname === "/reset-memory") {
    return handleResetMemory(request, env);
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

  // ── 入力長ガード（過大入力の拒否）──
  if (String(prompt).length > MAX_PROMPT_LEN) {
    return jsonRes({ error: `prompt が長すぎます（最大 ${MAX_PROMPT_LEN} 文字）` }, 400);
  }
  if (String(shared_context).length > MAX_CONTEXT_LEN) {
    return jsonRes({ error: `shared_context が長すぎます（最大 ${MAX_CONTEXT_LEN} 文字）` }, 400);
  }

  // ── 認証（KV） ──
  const correctPassword = await env.COUNCIL_KV.get("password");
  if (password !== correctPassword) {
    return jsonRes({ error: "パスワードが違います" }, 401);
  }

  // ── API キー取得（KV） ──
  const [openaiKey, anthropicKey] = await Promise.all([
    env.COUNCIL_KV.get("openai_key"),
    env.COUNCIL_KV.get("anthropic_key"),
  ]);
  const keys = { openai: openaiKey, anthropic: anthropicKey, grok: env.XAI_API_KEY };

  // ── 入力バリデーション ──
  const validModes   = ["council", "ask", "review"];
  const validTargets = ["openai", "anthropic", "grok"];

  if (!validModes.includes(mode)) {
    return jsonRes({ error: `不明なモード: ${mode}` }, 400);
  }
  if ((mode === "ask" || mode === "review") && !validTargets.includes(target)) {
    return jsonRes({ error: `不明なターゲット: ${target}` }, 400);
  }

  // ── ① メモリ読み込み ──
  const { history } = await loadMemory(env);
  const memoryContext = buildMemoryContext(history);

  // ── ② AI 呼び出し ──
  let result;
  if (mode === "ask") {
    result = await handleAsk(keys, prompt, target, shared_context, memoryContext);
  } else if (mode === "review") {
    result = await handleReview(keys, prompt, target, shared_context, memoryContext);
  } else {
    result = await handleCouncil(keys, prompt, shared_context, memoryContext);
  }

  // ── ③ 保存用エントリー構築 ──
  const entry = {
    id:        String(Date.now()),
    timestamp: new Date().toISOString(),
    mode,
    prompt,
    responses: result,   // { openai, anthropic, grok }（memory フィールドは含まない）
  };

  // ── ④ レスポンス返却（memory フィールド付き）──
  // history_count は保存前のカウント。GUI 側が +1 して表示する
  const response = jsonRes({
    ...result,
    memory: {
      used:          history.length > 0,
      history_count: history.length,
    },
  });

  // ── ⑤ ノンブロッキング保存（レスポンス返却後に実行）──
  ctx.waitUntil(saveMemory(env, entry));

  return response;
}

/* ═══════════════════════════════════════════════════════════
   メモリ: 読み込み
════════════════════════════════════════════════════════════ */

/**
 * KV から履歴を読み込む。
 * エラーは無視して空メモリで続行（可用性優先）。
 */
export async function loadMemory(env) {
  try {
    const historyRaw = await env.COUNCIL_KV.get("memory:history");
    return {
      history: historyRaw ? JSON.parse(historyRaw) : [],
    };
  } catch {
    return { history: [] };
  }
}

/* ═══════════════════════════════════════════════════════════
   メモリ: 保存
════════════════════════════════════════════════════════════ */

/**
 * 会話エントリーを KV の先頭に追加する。
 * 最大 50 件を超えた場合は末尾を削除する。
 */
export async function saveMemory(env, entry) {
  try {
    const historyRaw = await env.COUNCIL_KV.get("memory:history");
    const history    = historyRaw ? JSON.parse(historyRaw) : [];
    history.unshift(entry);                    // 先頭（最新）に追加
    if (history.length > 50) history.pop();    // 上限 50 件
    await env.COUNCIL_KV.put("memory:history", JSON.stringify(history));
  } catch (e) {
    console.error("saveMemory error:", e);
  }
}

/* ═══════════════════════════════════════════════════════════
   メモリ: プロンプト用サマリー生成
════════════════════════════════════════════════════════════ */

/**
 * 履歴の直近 5 件を1行ずつサマリー化してプロンプトに差し込む。
 * トークン節約のため質問文は 80 文字に切り詰める。
 */
export function buildMemoryContext(history) {
  if (!history.length) return "";
  const recent = history.slice(0, 5);
  const lines  = recent.map(h => {
    const date = new Date(h.timestamp).toLocaleDateString("ja-JP");
    return `[${date}] ${h.mode.toUpperCase()}: ${h.prompt.slice(0, 80)}`;
  });
  return "【過去の会話履歴】\n" + lines.join("\n");
}

/* ═══════════════════════════════════════════════════════════
   メモリリセット
════════════════════════════════════════════════════════════ */

export async function handleResetMemory(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonRes({ error: "Invalid JSON" }, 400);
  }

  const correctPassword = await env.COUNCIL_KV.get("password");
  if (body.password !== correctPassword) {
    return jsonRes({ error: "パスワードが違います" }, 401);
  }

  await Promise.all([
    env.COUNCIL_KV.delete("memory:history"),
    env.COUNCIL_KV.delete("memory:context"),
  ]);

  return jsonRes({ ok: true });
}

/* ═══════════════════════════════════════════════════════════
   プロンプト構築（orchestrator.py の build_prompt を移植・拡張）
════════════════════════════════════════════════════════════ */

/**
 * @param {string}      question      - ユーザーの質問
 * @param {string}      sharedContext - 共有コンテキスト（GUI 入力）
 * @param {string}      memoryContext - 過去の会話要約（KV から）
 * @param {string}      mode          - "ask" | "review"
 * @param {string|null} summary       - review 時の他AI回答まとめ
 *
 * プロンプト構造（上から順に差し込み）:
 *   1. 過去の会話履歴（memoryContext）
 *   2. 共有コンテキスト（sharedContext）
 *   3. 他モデルの回答（review のみ）
 *   4. 質問 + 指示
 */
export function buildPrompt(question, sharedContext, memoryContext, mode = "ask", summary = null) {
  const parts = [];

  if (memoryContext) parts.push(memoryContext);
  if (sharedContext) parts.push(`【共有コンテキスト】\n${sharedContext}`);

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
export async function handleCouncil(keys, prompt, sharedContext, memoryContext) {
  const p = buildPrompt(prompt, sharedContext, memoryContext);
  const [openai, anthropic, grok] = await Promise.all([
    callOpenAI(keys.openai, p),
    callAnthropic(keys.anthropic, p),
    callGrok(keys.grok, p),
  ]);
  return { openai, anthropic, grok };
}

/** 全 AI 空レスポンスのひな型（GUI 非表示用） */
function emptyResponses() {
  return {
    openai:    { ok: false, text: "" },
    anthropic: { ok: false, text: "" },
    grok:      { ok: false, text: "" },
  };
}

/** ASK: 指定 1AI のみ、残りは空レスポンス（GUI 非表示用） */
export async function handleAsk(keys, prompt, target, sharedContext, memoryContext) {
  const p      = buildPrompt(prompt, sharedContext, memoryContext);
  const result = await callAI(keys, target, p);
  const base   = emptyResponses();
  base[target] = result;
  return base;
}

/**
 * REVIEW: orchestrator.py の cmd_review を移植
 *   1. 他 2AI に基本プロンプトを並列送信
 *   2. 成功回答を summary 結合（失敗 AI は除外）
 *   3. target AI に review プロンプトを送信
 */
export async function handleReview(keys, prompt, target, sharedContext, memoryContext) {
  const others = AI_ALL.filter(ai => ai !== target);

  // Step 1: 他 2AI 並列質問
  const basePrompt = buildPrompt(prompt, sharedContext, memoryContext);
  const [res0, res1] = await Promise.all([
    callAI(keys, others[0], basePrompt),
    callAI(keys, others[1], basePrompt),
  ]);

  // Step 2: summary 構築
  const summaryParts = [];
  const otherResults = {};
  [[others[0], res0], [others[1], res1]].forEach(([ai, res]) => {
    otherResults[ai] = res;
    if (res.ok) summaryParts.push(`【${AI_LABEL[ai]}】\n${res.text}`);
  });
  const summary = summaryParts.length > 0
    ? summaryParts.join("\n\n")
    : "(他 AI の回答を取得できませんでした)";

  // Step 3: target AI に review プロンプト
  const reviewPrompt = buildPrompt(prompt, sharedContext, memoryContext, "review", summary);
  const reviewResult = await callAI(keys, target, reviewPrompt);

  const base = emptyResponses();
  base[others[0]] = otherResults[others[0]];
  base[others[1]] = otherResults[others[1]];
  base[target]    = { ...reviewResult, is_review: true };

  return base;
}

/* ═══════════════════════════════════════════════════════════
   API 呼び出し
════════════════════════════════════════════════════════════ */

export function callAI(keys, ai, prompt) {
  if (ai === "openai")    return callOpenAI(keys.openai, prompt);
  if (ai === "anthropic") return callAnthropic(keys.anthropic, prompt);
  if (ai === "grok")      return callGrok(keys.grok, prompt);
  return Promise.resolve({ ok: false, text: `不明な AI: ${ai}` });
}

/** OpenAI — GPT-4o */
export async function callOpenAI(apiKey, prompt) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${apiKey}`,
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

/** Anthropic — Claude Opus 4.8 */
export async function callAnthropic(apiKey, prompt) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-opus-4-8",
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

/** xAI — Grok（OpenAI 互換フォーマット） */
export async function callGrok(apiKey, prompt) {
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:      "grok-4.3",
        messages:   [{ role: "user", content: prompt }],
        max_tokens: 1000,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "xAI error");
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("xAI: 応答形式が不正です");
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: `エラー: ${e.message}` };
  }
}

/* ═══════════════════════════════════════════════════════════
   ヘルパー
════════════════════════════════════════════════════════════ */

export function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
