from __future__ import annotations
import os
from typing import Optional
import requests

class GrokProvider:
    """xAI Grok プロバイダー（OpenAI 互換チャット補完フォーマット）。"""

    API_URL = "https://api.x.ai/v1/chat/completions"

    def __init__(self, api_key: Optional[str], model: Optional[str] = None) -> None:
        self.api_key = api_key or os.environ.get("XAI_API_KEY")
        self.model = model or "grok-4.3"

    def send_message(self, prompt: str) -> str:
        if not self.api_key:
            raise ValueError("Grok(xAI) APIキーが設定されていません。")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.7,
        }
        try:
            response = requests.post(self.API_URL, headers=headers, json=payload, timeout=60)
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            if not content:
                raise RuntimeError("Grok(xAI) APIから有効な応答が得られませんでした。")
            return content.strip()
        except requests.RequestException as e:
            raise RuntimeError(f"Grok(xAI) APIへのリクエストに失敗しました: {e}")
