from __future__ import annotations
import os
from typing import Optional
import requests

class AnthropicProvider:
    API_URL = "https://api.anthropic.com/v1/messages"
    API_VERSION = "2023-06-01"

    def __init__(self, api_key: Optional[str], model: Optional[str] = None) -> None:
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self.model = model or "claude-sonnet-4-6"

    def send_message(self, prompt: str) -> str:
        if not self.api_key:
            raise ValueError("Anthropic APIキーが設定されていません。")
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": self.API_VERSION,
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "max_tokens": 1024,
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
