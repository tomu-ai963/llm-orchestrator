# LLM Orchestrator

TermuxからClaude・ChatGPT・Geminiを一括操作できるマルチLLM CLIツール。

## 概要

`shared_context.md`に自分の状況・進捗を書いておくだけで、3つのAIが同じ文脈を持った状態で回答してくれます。記憶の共有ではなく、文脈の共有によるマルチAI運用を実現します。

## 環境

- Android / Termux
- Python 3.x
- requests

## セットアップ

```bash
pip install requests
cp config.example.json config.json
# config.json に各APIキーを入力
使い方
# 共有コンテキストの確認
python orchestrator.py status

# 1つのAIに質問
python orchestrator.py ask openai "質問"

# 3AIに同時質問
python orchestrator.py council "質問"

# 他AIの回答を踏まえて再評価
python orchestrator.py review claude "質問"

# コンテキストファイルの確認
python orchestrator.py sync
ファイル構成
shared_context.md — 長期的な方針・環境情報
projects.json — プロジェクト管理
weekly_update.md — 週次の進捗・変化
作者
tomu-ai963
