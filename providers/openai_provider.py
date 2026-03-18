from __future__ import annotations
import os
from typing import Optional
import requests

class OpenAIProvider:
    def __init__(self, api_key: Optional[str], model: Optional[str] = None) -> None:
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self.model = model or "gpt-3.5-turbo"

    def send_message(self, prompt: str) -> str:
        if not self.api_key:
            raise ValueError("OpenAI APIキーが設定されていません。")
        url = "https://api.openai.com/v1/chat/completions"
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
            response = requests.post(url, headers=headers, json=payload, timeout=60)
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            if not content:
                raise RuntimeError("OpenAI APIから有効な応答が得られませんでした。")
            return content.strip()
        except requests.RequestException as e:
            raise RuntimeError(f"OpenAI APIへのリクエストに失敗しました: {e}")
