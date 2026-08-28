"""Runtime configuration for the AI service.

Environment is read from every ``.env`` between the repository root and this
service, loaded outermost first so the closest file wins:

    OTY/.env  ->  TOY-backend/.env  ->  TOY-backend/TOY-ai-backend/.env  ->  real env

Walking up rather than hardcoding a depth means the service keeps working
wherever it is nested. Two things fall out of it for free:

  * ``GROQ_API_KEY`` is read from this service's own ``.env``. Provider keys
    live here and nowhere else, because this is the only process that calls a
    provider. An enclosing ``.env`` may still supply it, but nothing outside
    this directory is expected to hold it.
  * ``AI_SERVICE_TOKEN`` set in ``TOY-backend/.env`` is picked up here too, so
    the shared secret cannot drift between the API and this service.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

SERVICE_DIR = Path(__file__).resolve().parent.parent

#: How far up to look for enclosing .env files.
_MAX_DEPTH = 4


def _env_files() -> list[Path]:
    """Enclosing .env paths, outermost first."""
    candidates: list[Path] = []
    directory = SERVICE_DIR
    for _ in range(_MAX_DEPTH):
        candidates.append(directory / ".env")
        if directory.parent == directory:
            break
        directory = directory.parent
    return list(reversed(candidates))


for _path in _env_files():
    # Later (closer) files override earlier (outer) ones.
    load_dotenv(_path, override=True)

REPO_ROOT = SERVICE_DIR.parent.parent


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip())
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip())
    except (TypeError, ValueError):
        return default


def _str(name: str, default: str = "") -> str:
    value = os.getenv(name)
    return value.strip() if value and value.strip() else default


def _list(name: str, default: list[str]) -> list[str]:
    raw = _str(name)
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    env: str = field(default_factory=lambda: _str("AI_ENV", "development"))
    host: str = field(default_factory=lambda: _str("AI_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _int("AI_PORT", 8000))
    cors_origins: list[str] = field(
        default_factory=lambda: _list("AI_CORS_ORIGINS", ["http://localhost:3000"])
    )
    service_token: str = field(default_factory=lambda: _str("AI_SERVICE_TOKEN"))

    #: The switch TOY.md asks for. True -> Groq, False -> OpenAI.
    use_groq: bool = field(default_factory=lambda: _bool("USE_GROQ", True))

    #: Escape hatch: name a provider outright and the boolean is ignored. This
    #: is the only way to select Gemini, which is no longer on the switch.
    provider_override: str = field(default_factory=lambda: _str("AI_PROVIDER"))

    groq_api_key: str = field(default_factory=lambda: _str("GROQ_API_KEY"))
    # Free-tier friendly and honours JSON response_format, which §28 relies on.
    # Groq retires models fairly often, so confirm a name against
    # GET /openai/v1/models before pinning it here.
    groq_model: str = field(default_factory=lambda: _str("GROQ_MODEL", "openai/gpt-oss-120b"))
    groq_base_url: str = field(
        default_factory=lambda: _str("GROQ_BASE_URL", "https://api.groq.com").rstrip("/")
    )
    #: "low" | "medium" | "high", or empty for a model that is not a reasoner.
    groq_reasoning_effort: str = field(
        default_factory=lambda: _str("GROQ_REASONING_EFFORT", "low")
    )

    gemini_api_key: str = field(default_factory=lambda: _str("GEMINI_API_KEY"))
    # The "-latest" aliases keep working when a dated model is retired.
    gemini_model: str = field(
        default_factory=lambda: _str("GEMINI_MODEL", "gemini-flash-lite-latest")
    )
    gemini_base_url: str = field(
        default_factory=lambda: _str(
            "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com"
        ).rstrip("/")
    )

    openai_api_key: str = field(default_factory=lambda: _str("OPENAI_API_KEY"))
    openai_model: str = field(default_factory=lambda: _str("OPENAI_MODEL", "gpt-4o-mini"))
    openai_base_url: str = field(
        default_factory=lambda: _str("OPENAI_BASE_URL", "https://api.openai.com").rstrip("/")
    )

    timeout_seconds: float = field(
        default_factory=lambda: _float("AI_REQUEST_TIMEOUT_SECONDS", 45.0)
    )
    max_retries: int = field(default_factory=lambda: _int("AI_MAX_RETRIES", 2))
    temperature: float = field(default_factory=lambda: _float("AI_TEMPERATURE", 0.7))
    max_output_tokens: int = field(default_factory=lambda: _int("AI_MAX_OUTPUT_TOKENS", 2048))

    @property
    def provider_name(self) -> str:
        if self.provider_override:
            return self.provider_override.lower()
        return "groq" if self.use_groq else "openai"

    @property
    def provider_keys(self) -> dict[str, str]:
        return {
            "groq": self.groq_api_key,
            "openai": self.openai_api_key,
            "gemini": self.gemini_api_key,
        }

    @property
    def provider_models(self) -> dict[str, str]:
        return {
            "groq": self.groq_model,
            "openai": self.openai_model,
            "gemini": self.gemini_model,
        }

    @property
    def api_key_env_var(self) -> str:
        """The variable to name when the selected provider has no key."""
        return f"{self.provider_name.upper()}_API_KEY"

    @property
    def active_model(self) -> str:
        return self.provider_models.get(self.provider_name, "unknown")

    @property
    def is_configured(self) -> bool:
        """Whether the *selected* provider has a usable key."""
        return bool(self.provider_keys.get(self.provider_name))


settings = Settings()
