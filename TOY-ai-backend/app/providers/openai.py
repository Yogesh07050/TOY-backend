"""OpenAI, over the Chat Completions REST API.

Present so the ``USE_GROQ`` switch has something to switch to; the calling code
cannot tell the providers apart. The call itself lives in
``openai_compatible.py``, which Groq shares.
"""

from __future__ import annotations

from ..config import settings
from .openai_compatible import OpenAICompatibleProvider


class OpenAIProvider(OpenAICompatibleProvider):
    name = "openai"
    label = "OpenAI"

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
    ) -> None:
        super().__init__(
            api_key=api_key if api_key is not None else settings.openai_api_key,
            model=model or settings.openai_model,
            base_url=base_url or settings.openai_base_url,
        )
