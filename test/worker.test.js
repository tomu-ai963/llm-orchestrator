/**
 * Worker テスト — fetch / KV を完全モックし本番 API へは一切アクセスしない。
 * 実行: npm test  （= node --test）
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import worker, {
  handleRequest,
  loadMemory,
  saveMemory,
  buildMemoryContext,
  buildPrompt,
  handleCouncil,
  handleAsk,
  handleReview,
  callAI,
  callGrok,
  AI_ALL,
  AI_LABEL,
  MAX_PROMPT_LEN,
  MAX_CONTEXT_LEN,
} from "../worker/index.js";

/* ── テストダブル ───────────────────────────────────────── */

/** Map ベースの Cloudflare KV 互換スタブ。 */
class FakeKV {
  constructor(initial = {}) {
    this.store = new Map(Object.entries(initial));
  }
  async get(key)        { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, val)   { this.store.set(key, val); }
  async delete(key)     { this.store.delete(key); }
}

function makeEnv(kvInit = {}) {
  return {
    COUNCIL_KV: new FakeKV({
      password:       "secret",
      openai_key:     "sk-openai",
      anthropic_key:  "sk-anthropic",
      ...kvInit,
    }),
    XAI_API_KEY: "xai-key",
  };
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(p),
    settled:   () => Promise.all(pending),
  };
}

function makeRequest({ method = "POST", url = "https://worker.dev/", body } = {}) {
  return {
    method,
    url,
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

/** URL でプロバイダーを判別して整形済みレスポンスを返す fetch モック。 */
function installFetchMock(opts = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const payload = JSON.parse(init.body);
    let data;
    if (url.includes("api.openai.com")) {
      data = { choices: [{ message: { content: `OPENAI:${payload.messages[0].content}` } }] };
    } else if (url.includes("api.anthropic.com")) {
      data = { content: [{ text: `ANTHROPIC:${payload.messages[0].content}` }] };
    } else if (url.includes("api.x.ai")) {
      if (opts.grokMalformed) data = {};   // 応答形式不正パターン
      else data = { choices: [{ message: { content: `GROK:${payload.messages[0].content}` } }] };
    } else {
      throw new Error(`unexpected url: ${url}`);
    }
    return {
      ok:   true,
      json: async () => data,
    };
  };
  globalThis.fetch.calls = calls;
  return calls;
}

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(()  => { globalThis.fetch = originalFetch; });

/* ── 定数の置換確認 ─────────────────────────────────────── */

test("AI 構成が openai / anthropic / grok（gemini 廃止）", () => {
  assert.deepEqual(AI_ALL, ["openai", "anthropic", "grok"]);
  assert.equal(AI_LABEL.grok, "Grok");
  assert.equal(AI_LABEL.gemini, undefined);
});

/* ── ルーティング / 認証 / バリデーション ───────────────── */

test("OPTIONS は CORS ヘッダ付き 200", async () => {
  const res = await handleRequest(makeRequest({ method: "OPTIONS" }), makeEnv(), makeCtx());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("非 POST は 405", async () => {
  const res = await handleRequest(makeRequest({ method: "GET" }), makeEnv(), makeCtx());
  assert.equal(res.status, 405);
});

test("password / prompt 欠落は 400", async () => {
  const res = await handleRequest(
    makeRequest({ body: { prompt: "hi" } }), makeEnv(), makeCtx());
  assert.equal(res.status, 400);
});

test("パスワード不一致は 401", async () => {
  const res = await handleRequest(
    makeRequest({ body: { password: "wrong", prompt: "hi" } }), makeEnv(), makeCtx());
  assert.equal(res.status, 401);
});

test("不明なモードは 400", async () => {
  installFetchMock();
  const res = await handleRequest(
    makeRequest({ body: { password: "secret", prompt: "hi", mode: "bogus" } }),
    makeEnv(), makeCtx());
  assert.equal(res.status, 400);
});

test("ask で不明なターゲットは 400", async () => {
  const res = await handleRequest(
    makeRequest({ body: { password: "secret", prompt: "hi", mode: "ask", target: "gemini" } }),
    makeEnv(), makeCtx());
  assert.equal(res.status, 400);
});

test("Invalid JSON は 400", async () => {
  const res = await handleRequest(makeRequest({ body: undefined }), makeEnv(), makeCtx());
  assert.equal(res.status, 400);
});

test("過大な prompt は 400（入力長ガード）", async () => {
  const res = await handleRequest(
    makeRequest({ body: { password: "secret", prompt: "x".repeat(MAX_PROMPT_LEN + 1) } }),
    makeEnv(), makeCtx());
  assert.equal(res.status, 400);
});

test("過大な shared_context は 400（入力長ガード）", async () => {
  const res = await handleRequest(
    makeRequest({ body: {
      password: "secret", prompt: "hi", shared_context: "x".repeat(MAX_CONTEXT_LEN + 1),
    } }),
    makeEnv(), makeCtx());
  assert.equal(res.status, 400);
});

test("上限ちょうどの prompt は通る", async () => {
  installFetchMock();
  const ctx = makeCtx();
  const res = await handleRequest(
    makeRequest({ body: { password: "secret", prompt: "x".repeat(MAX_PROMPT_LEN), mode: "council" } }),
    makeEnv(), ctx);
  assert.equal(res.status, 200);
  await ctx.settled();
});

/* ── モード: council ────────────────────────────────────── */

test("council は 3AI 並列で grok キーを含む", async () => {
  installFetchMock();
  const ctx = makeCtx();
  const res = await handleRequest(
    makeRequest({ body: { password: "secret", prompt: "Q", mode: "council" } }),
    makeEnv(), ctx);
  const data = JSON.parse(await res.text());
  assert.equal(res.status, 200);
  assert.equal(data.openai.ok, true);
  assert.equal(data.anthropic.ok, true);
  assert.equal(data.grok.ok, true);
  assert.match(data.grok.text, /^GROK:/);
  assert.equal(data.gemini, undefined);
  assert.ok(data.memory);
  await ctx.settled();
});

/* ── モード: ask ────────────────────────────────────────── */

test("ask(grok) は grok のみ回答・他は空", async () => {
  installFetchMock();
  const ctx = makeCtx();
  const res = await handleRequest(
    makeRequest({ body: { password: "secret", prompt: "Q", mode: "ask", target: "grok" } }),
    makeEnv(), ctx);
  const data = JSON.parse(await res.text());
  assert.equal(data.grok.ok, true);
  assert.equal(data.openai.ok, false);
  assert.equal(data.openai.text, "");
  assert.equal(data.anthropic.ok, false);
  await ctx.settled();
});

/* ── モード: review ─────────────────────────────────────── */

test("review(grok) は他2AI回答 + grok に is_review", async () => {
  installFetchMock();
  const ctx = makeCtx();
  const res = await handleRequest(
    makeRequest({ body: { password: "secret", prompt: "Q", mode: "review", target: "grok" } }),
    makeEnv(), ctx);
  const data = JSON.parse(await res.text());
  assert.equal(data.openai.ok, true);
  assert.equal(data.anthropic.ok, true);
  assert.equal(data.grok.ok, true);
  assert.equal(data.grok.is_review, true);
  await ctx.settled();
});

/* ── プロンプト構築 ─────────────────────────────────────── */

test("buildPrompt(ask) は質問と指示を含む", () => {
  const p = buildPrompt("質問A", "", "");
  assert.match(p, /質問: 質問A/);
  assert.match(p, /日本語で答えて/);
});

test("buildPrompt(review) は他モデル回答と memory/context を差し込む", () => {
  const p = buildPrompt("質問B", "CTX", "MEM", "review", "OTHERS");
  assert.match(p, /MEM/);
  assert.match(p, /【共有コンテキスト】\nCTX/);
  assert.match(p, /他モデルの回答:\nOTHERS/);
});

/* ── メモリ ─────────────────────────────────────────────── */

test("buildMemoryContext は直近5件を整形（空履歴は空文字）", () => {
  assert.equal(buildMemoryContext([]), "");
  const hist = Array.from({ length: 7 }, (_, i) => ({
    timestamp: "2026-01-0" + ((i % 9) + 1) + "T00:00:00Z",
    mode: "ask",
    prompt: "p" + i,
  }));
  const ctx = buildMemoryContext(hist);
  assert.match(ctx, /過去の会話履歴/);
  assert.equal(ctx.split("\n").length, 1 + 5);   // ヘッダ + 5 行
});

test("saveMemory は先頭追加かつ 50 件上限", async () => {
  const env = makeEnv();
  for (let i = 0; i < 55; i++) {
    await saveMemory(env, { id: String(i), timestamp: "t", mode: "ask", prompt: "p" + i });
  }
  const { history } = await loadMemory(env);
  assert.equal(history.length, 50);
  assert.equal(history[0].id, "54");   // 最新が先頭
});

test("loadMemory は KV 不在時に空履歴を返す", async () => {
  const env = makeEnv();
  const { history } = await loadMemory(env);
  assert.deepEqual(history, []);
});

/* ── 防御的パース（grok） ───────────────────────────────── */

test("callGrok は応答形式不正で ok:false を返す", async () => {
  installFetchMock({ grokMalformed: true });
  const r = await callGrok("xai-key", "Q");
  assert.equal(r.ok, false);
  assert.match(r.text, /エラー/);
});

test("callAI は未知 AI で ok:false", async () => {
  const r = await callAI({}, "unknown", "Q");
  assert.equal(r.ok, false);
});

/* ── default export ─────────────────────────────────────── */

test("default export は fetch ハンドラを公開", () => {
  assert.equal(typeof worker.fetch, "function");
});
