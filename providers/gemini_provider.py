from __future__ import annotations
import os
from typing import Optional
import requests

class GeminiProvider:
    API_BASE = "https://generativelanguage.googleapis.com/v1beta"

    def __init__(self, api_key: Optional[str], model: Optional[str] = None) -> None:
        self.api_key = api_key or os.environ.get("GOOGLE_GEMINI_API_KEY")
        self.model = model or "gemini-2.0-flash"

    def send_message(self, prompt: str) -> str:
        if not self.api_key:
            raise ValueError("Gemini APIキーが設定されていません。")
        url = f"{self.API_BASE}/models/{self.model}:generateContent?key={self.api_key}"
        headers = {"Content-Type": "application/json"}
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.7},
        }
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=60)
            response.raise_for_status()
            data = response.json()
            candidates = data.get("candidates", [])
            if not candidates:
                raise RuntimeError("Gemini APIから有効な応答が得られませんでした。")
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts)
            if not text:
                raise RuntimeError("Gemini APIから有効な応答が得られませんでした。")
            return text.strip()
        except requests.RequestException as e:
            raise RuntimeError(f"Gemini APIへのリクエストに失敗しました: {e}")
