from __future__ import annotations
import os
from typing import Optional
import requests

class AnthropicProvider:
    API_URL = "https://api.anthropic.com/v1/messages"
    API_VERSION = "2023-06-01"

    def __init__(self, api_key: Optional[str], model: Optional[str] = None, effort: Optional[str] = None) -> None:
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self.model = model or "claude-sonnet-5-5"
        self.effort = effort or "low"

    def send_message(self, prompt: str) -> str:
        if not self.api_key:
            raise ValueError("Anthropic APIキーが設定されていません。")
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": self.API_VERSION,
            "Content-Type": "application/json",
            # 安全分類器で断られたとき、API 側で別モデルに自動で切り替える
            "anthropic-beta": "server-side-fallback-2026-07-01",
        }
        payload = {
            "model": self.model,
            # Sonnet 5.5 は思考が常に有効で、思考分もここに含まれるため 1024 だと途中で切れうる
            "max_tokens": 16000,
            "output_config": {"effort": self.effort},
            "fallbacks": "default",
            "messages": [{"role": "user", "content": prompt}],
        }
        try:
            response = requests.post(self.API_URL, headers=headers, json=payload, timeout=60)
            response.raise_for_status()
            data = response.json()
            texts = [p["text"] for p in data.get("content", []) if "text" in p]
            content = "".join(texts)
            if not content:
                raise RuntimeError("Anthropic APIから有効な応答が得られませんでした。")
            return content.strip()
        except requests.RequestException as e:
            raise RuntimeError(f"Anthropic APIへのリクエストに失敗しました: {e}")
