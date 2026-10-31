# LLM Council

OpenAI・Anthropic（Claude）・xAI（Grok）の3つのAIに同じ質問を投げ、回答を並べて見比べるためのツール。

同じ文脈（共有コンテキスト）を3つのAIに渡すことで、記憶の共有ではなく文脈の共有によるマルチAI運用を実現します。

使い方は2通りあります。

| | Web 版 | CLI 版 |
|---|---|---|
| 使う場所 | ブラウザ（スマホ可） | Termux などのターミナル |
| 構成 | Cloudflare Worker（画面と API を同じオリジンで配信）→ 各社 API | `orchestrator.py` → 各社 API |
| APIキーの置き場所 | Worker 側（KV / secret） | `config.json` |
| 共有コンテキスト | 画面の入力欄 | `data/` 配下のファイル |
| 会話の記憶 | 直近50件を KV に保存し、直近5件の要約をプロンプトに添える | なし（`logs/` に記録のみ） |

## 使うモデル

Web 版と CLI 版で揃えています。

| | モデル |
|---|---|
| OpenAI | `gpt-6-luna` |
| Anthropic | `claude-sonnet-5-5`（effort `low`） |
| Grok | `grok-4.7` |

- Web 版: `worker/council.js` の `MODELS`
- CLI 版: `config.json`（ひな形は `config.example.json`）

## モード

どちらの版も同じ3つのモードがあります。

- **council** — 3つのAIに同時に質問し、回答を並べる
- **ask** — 指定した1つのAIだけに質問する
- **review** — 指定したAI以外の2つに先に質問し、その回答を踏まえて指定したAIが自分の見解を述べる

---

## Web 版

### 画面

https://llm-council-worker.inverted-triangle-leef.workers.dev/

画面（`public/index.html`）は Worker が配信します（`npx wrangler deploy` で反映）。
API と同じオリジンなので、localStorage に保存するパスワードを他のアプリと共有しません。

以前の GitHub Pages（https://tomu-ai963.github.io/llm-orchestrator/ ）はルートの `index.html` が移転ページになっていて、
開くとそのブラウザに残っているパスワードを消し、新しい URL へ案内します。

- パスワードと質問を入れて送信（Shift + Enter でも送信）
- 「共有コンテキスト」を開くと、全AIに渡す前提情報を書ける
- 各パネルのヘッダーには、実際に回答したモデル名が出る（Worker が返した値。最初の送信前は空欄）
- 「記憶をリセット」で KV に保存された会話の記憶を消す
- パスワードと共有コンテキストはブラウザの localStorage に保存される。画面下の履歴はページを閉じると消える

### Worker

Worker 名は `llm-council-worker`（`wrangler.toml`）。

- `worker/index.js` — エントリポイント。default export（fetch ハンドラ）だけを持つ
- `worker/council.js` — 処理の本体と定数（テストはここから import する）

`[assets]` を有効にしていると、wrangler はエントリポイントの named export をすべて入口として扱い、
定数を export していると起動に失敗します。エントリポイントには default 以外を export しないでください。

| エンドポイント | 内容 |
|---|---|
| `GET /*` | 画面（`public/` の静的ファイル） |
| `POST /` | 質問する。body: `{ password, prompt, mode?, target?, shared_context? }` |
| `POST /reset-memory` | 会話の記憶を消す。body: `{ password }` |

- 画面と同じオリジンなので CORS ヘッダーは返さない（OPTIONS は 405）
- `public/` の中身だけがアップロードされる。リポジトリの他のファイルは公開されない

- `mode` は `council`（既定）/ `ask` / `review`、`target` は `openai` / `anthropic` / `grok`
- レスポンスは `{ openai, anthropic, grok, memory }`。各AIは `{ ok, text, model }`
- 入力の上限は `prompt` 8000文字、`shared_context` 16000文字
- 各AIへの呼び出しは60秒でタイムアウトする

### Worker が使う設定

値はリポジトリに置かず、Cloudflare 側に置きます。

| 名前 | 置き場所 | 中身 |
|---|---|---|
| `password` | KV（`COUNCIL_KV`） | 画面から送るパスワード |
| `openai_key` | KV（`COUNCIL_KV`） | OpenAI の APIキー |
| `anthropic_key` | KV（`COUNCIL_KV`） | Anthropic の APIキー |
| `memory:history` | KV（`COUNCIL_KV`） | 会話の記憶（Worker が自動で書く） |
| `XAI_API_KEY` | Worker の secret | xAI の APIキー |

### 開発

```bash
npm install
npm test                  # Worker のテスト（fetch と KV はモック。本物の API は呼ばない）
npx wrangler dev --local  # ローカルで画面と API を起動（ローカル KV は空なのでパスワードは通らない）
npx wrangler deploy       # 本番デプロイ（画面と Worker の両方）
```

---

## CLI 版

### 環境

- Android / Termux（他のターミナルでも可）
- Python 3.x
- requests

### セットアップ

```bash
pip install -r requirements.txt
cp config.example.json config.json
# config.json に各APIキーを入力（config.json は .gitignore 済み）
```

### 使い方

```bash
# 共有コンテキストの概要を表示
python orchestrator.py status

# 1つのAIに質問（openai / anthropic / grok）
python orchestrator.py ask openai "質問"

# 3つのAIに質問
python orchestrator.py council "質問"

# 他の2つの回答を踏まえて、指定したAIが再評価
python orchestrator.py review anthropic "質問"

# コンテキストファイルの中身を表示
python orchestrator.py sync
```

### 共有コンテキストのファイル

CLI 版はプロンプトに次のファイルの中身を添えます（Web 版は使いません）。

- `data/shared_context.md` — 長期的な方針・環境情報
- `data/projects.json` — プロジェクト管理
- `data/weekly_update.md` — 週次の進捗・変化

やり取りは `logs/YYYYMMDD.log` に追記されます（`logs/` は .gitignore 済み）。

---

## ファイル構成

```
public/index.html     Web 版の画面（Worker が配信）
worker/index.js       Worker のエントリポイント
worker/council.js     Worker の処理本体
test/worker.test.js   Worker のテスト
index.html            旧 GitHub Pages の移転ページ
wrangler.toml         Worker の設定
orchestrator.py       CLI 版の本体
providers/            CLI 版の各社 API 呼び出し
config.example.json   CLI 版の設定のひな形
data/                 CLI 版の共有コンテキスト
```

## 作者

tomu-ai963
