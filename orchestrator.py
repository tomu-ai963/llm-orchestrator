#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
import json
import os
import sys
import datetime
from pathlib import Path
from typing import Dict, List, Optional

from providers.openai_provider import OpenAIProvider
from providers.anthropic_provider import AnthropicProvider
from providers.grok_provider import GrokProvider

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = PROJECT_ROOT / "data"
LOGS_DIR = PROJECT_ROOT / "logs"
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.json"
EXAMPLE_CONFIG_PATH = PROJECT_ROOT / "config.example.json"

def load_config(config_path: Path = DEFAULT_CONFIG_PATH) -> Dict:
    target = config_path
    if not target.exists():
        if EXAMPLE_CONFIG_PATH.exists():
            target = EXAMPLE_CONFIG_PATH
        else:
            raise FileNotFoundError(f"設定ファイルが見つかりません: {config_path}")
    with target.open("r", encoding="utf-8") as f:
        return json.load(f)

def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""

def read_projects(path: Path) -> List[Dict]:
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []

def load_shared_context(data_dir: Path) -> Dict:
    return {
        "shared_context": read_text(data_dir / "shared_context.md"),
        "projects": read_projects(data_dir / "projects.json"),
        "weekly_update": read_text(data_dir / "weekly_update.md"),
    }

def build_prompt(question: str, context: Dict, mode: str = "ask", summary: Optional[str] = None) -> str:
    parts = []
    if context.get("shared_context"):
        parts.append("【長期共有コンテキスト】\n" + context["shared_context"])
    if context.get("projects"):
        parts.append("【プロジェクト情報】\n" + json.dumps(context["projects"], ensure_ascii=False, indent=2))
    if context.get("weekly_update"):
        parts.append("【今週の更新】\n" + context["weekly_update"])
    context_text = "\n\n".join(parts)
    if mode == "review" and summary:
        return f"共有コンテキスト:\n{context_text}\n\n他モデルの回答:\n{summary}\n\n質問: {question}\n\n他モデルの回答を参考にしつつ、あなた自身の見解を日本語で述べてください。"
    return f"共有コンテキスト:\n{context_text}\n\n質問: {question}\n\n上記を踏まえて日本語で答えてください。"

def ensure_logs_dir():
    LOGS_DIR.mkdir(parents=True, exist_ok=True)

def log_interaction(mode: str, model: str, question: str, response: str) -> None:
    ensure_logs_dir()
    ts = datetime.datetime.now().strftime("%Y%m%d")
    log_path = LOGS_DIR / f"{ts}.log"
    timestamp = datetime.datetime.now().isoformat()
    with log_path.open("a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] mode={mode} model={model}\nQ: {question}\nA: {response}\n--\n")

def get_provider(name: str, config: Dict):
    name = name.lower()
    if name == "openai":
        cfg = config.get("openai", {})
        return OpenAIProvider(api_key=cfg.get("api_key"), model=cfg.get("model"))
    elif name == "anthropic":
        cfg = config.get("anthropic", {})
        return AnthropicProvider(api_key=cfg.get("api_key"), model=cfg.get("model"))
    elif name == "grok":
        cfg = config.get("grok", {})
        return GrokProvider(api_key=cfg.get("api_key"), model=cfg.get("model"))
    else:
        raise ValueError(f"未知のモデル名: {name}")

def cmd_status(args, config):
    context = load_shared_context(DATA_DIR)
    print("=== 共有コンテキストの概要 ===")
    if context["shared_context"]:
        print("[shared_context.md]")
        print(context["shared_context"][:200])
        print()
    if context["projects"]:
        print(f"[projects.json] プロジェクト数: {len(context['projects'])}")
        for proj in context["projects"]:
            print(f"- {proj.get('project_name')}: {proj.get('status')}")
        print()
    if context["weekly_update"]:
        print("[weekly_update.md]")
        print(context["weekly_update"][:200])

def cmd_ask(args, config):
    context = load_shared_context(DATA_DIR)
    prompt = build_prompt(args.question, context)
    provider = get_provider(args.model, config)
    try:
        answer = provider.send_message(prompt)
    except Exception as e:
        print(f"エラー: {e}", file=sys.stderr)
        return
    print(f"=== {args.model} の回答 ===")
    print(answer)
    log_interaction("ask", args.model, args.question, answer)

def cmd_council(args, config):
    context = load_shared_context(DATA_DIR)
    prompt = build_prompt(args.question, context)
    for model_name in ["openai", "anthropic", "grok"]:
        provider = get_provider(model_name, config)
        try:
            answer = provider.send_message(prompt)
        except Exception as e:
            answer = f"エラー: {e}"
        print(f"=== {model_name} の回答 ===")
        print(answer)
        print()
        log_interaction("council", model_name, args.question, answer)

def cmd_review(args, config):
    context = load_shared_context(DATA_DIR)
    other_models = [m for m in ["openai", "anthropic", "grok"] if m != args.target.lower()]
    base_prompt = build_prompt(args.question, context)
    summaries = []
    for model_name in other_models:
        provider = get_provider(model_name, config)
        try:
            answer = provider.send_message(base_prompt)
        except Exception as e:
            answer = f"エラー: {e}"
        summaries.append(f"【{model_name}】\n{answer}")
        log_interaction("review-collect", model_name, args.question, answer)
    summary_text = "\n\n".join(summaries)
    review_prompt = build_prompt(args.question, context, mode="review", summary=summary_text)
    provider = get_provider(args.target, config)
    try:
        answer = provider.send_message(review_prompt)
    except Exception as e:
        print(f"エラー: {e}", file=sys.stderr)
        return
    print(f"=== {args.target} の再評価 ===")
    print(answer)
    log_interaction("review", args.target, args.question, answer)

def cmd_sync(args, config):
    context = load_shared_context(DATA_DIR)
    print("--- shared_context.md ---")
    print(context["shared_context"] or "(空)")
    print("\n--- projects.json ---")
    print(json.dumps(context["projects"], ensure_ascii=False, indent=2) if context["projects"] else "(空)")
    print("\n--- weekly_update.md ---")
    print(context["weekly_update"] or "(空)")

def build_parser():
    parser = argparse.ArgumentParser(description="マルチLLM共有コンテキスト管理CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("status").set_defaults(func=cmd_status)
    p_ask = subparsers.add_parser("ask")
    p_ask.add_argument("model", choices=["openai", "anthropic", "grok"])
    p_ask.add_argument("question")
    p_ask.set_defaults(func=cmd_ask)
    p_council = subparsers.add_parser("council")
    p_council.add_argument("question")
    p_council.set_defaults(func=cmd_council)
    p_review = subparsers.add_parser("review")
    p_review.add_argument("target", choices=["openai", "anthropic", "grok"])
    p_review.add_argument("question")
    p_review.set_defaults(func=cmd_review)
    subparsers.add_parser("sync").set_defaults(func=cmd_sync)
    return parser

def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        config = load_config()
    except Exception as e:
        print(f"設定ファイルの読み込みに失敗: {e}", file=sys.stderr)
        sys.exit(1)
    args.func(args, config)

if __name__ == "__main__":
    main()
