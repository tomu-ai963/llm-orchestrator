/**
 * LLM Council Worker — エントリポイント
 *
 * ここでは default export（fetch ハンドラ）だけを持つ。
 * [assets] を有効にすると、wrangler はこのモジュールの named export をすべて
 * エントリポイントとして扱い、定数（数値・文字列）を export していると起動に失敗する。
 * そのため処理と定数は worker/council.js に置く。
 */
import { handleRequest } from "./council.js";

export default {
  fetch: handleRequest,
};
