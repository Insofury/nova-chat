"""Application configuration.

Everything that can change between environments (API key, limits, defaults) is read
from environment variables. For local development you can put them in a `.env` file
in the project root - it is loaded automatically and never overrides real env vars.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = PROJECT_ROOT / "static"


# --------------------------------------------------------------------------- #
# Model catalogue
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ModelInfo:
    """A Claude model the user can pick in the UI."""

    id: str
    label: str
    tagline: str
    # True when the model accepts the server-side `fallbacks: "default"` parameter,
    # which transparently re-runs a request on another model if a safety
    # classifier declines it.
    server_fallback: bool


MODELS: tuple[ModelInfo, ...] = (
    ModelInfo("claude-opus-5-5", "Claude Opus 5.5", "Most capable - deep reasoning and coding", True),
    ModelInfo("claude-sonnet-5-5", "Claude Sonnet 5.5", "Fast and smart for everyday work", True),
    ModelInfo("claude-haiku-5-5", "Claude Haiku 5.5", "Fastest and lightest", False),
)
MODELS_BY_ID: dict[str, ModelInfo] = {m.id: m for m in MODELS}

# Effort controls how much the model thinks before answering (latency vs depth).
EFFORT_LEVELS: dict[str, str] = {
    "low": "Fast",
    "medium": "Balanced",
    "high": "Deep",
}

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_EFFORT = "medium"


# --------------------------------------------------------------------------- #
# .env loading and env parsing helpers
# --------------------------------------------------------------------------- #
def load_dotenv(path: Path | None = None) -> None:
    """Load `KEY=VALUE` lines from a .env file into `os.environ`.

    Real environment variables always win, so production settings are never
    overridden by a stray local file.
    """
    path = path or PROJECT_ROOT / ".env"
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


def _env_str(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or default


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name, "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Settings:
    """Runtime settings. Build with `Settings.from_env()` or directly in tests."""

    app_name: str = "NovaChat"
    anthropic_api_key: str | None = None
    default_model: str = DEFAULT_MODEL
    default_effort: str = DEFAULT_EFFORT
    max_tokens: int = 64_000
    rate_limit_per_minute: int = 20
    access_code: str | None = None
    trust_proxy: bool = False
    max_messages: int = 200
    max_message_chars: int = 50_000
    max_custom_instructions_chars: int = 4_000
    max_images_per_message: int = 4
    max_image_bytes: int = 5 * 1024 * 1024
    max_request_bytes: int = 25 * 1024 * 1024

    @property
    def demo_mode(self) -> bool:
        """With no API key the app still runs, streaming a built-in demo reply."""
        return not self.anthropic_api_key

    @classmethod
    def from_env(cls) -> Settings:
        load_dotenv()
        default_model = _env_str("DEFAULT_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL
        if default_model not in MODELS_BY_ID:
            default_model = DEFAULT_MODEL
        default_effort = _env_str("DEFAULT_EFFORT", DEFAULT_EFFORT) or DEFAULT_EFFORT
        if default_effort not in EFFORT_LEVELS:
            default_effort = DEFAULT_EFFORT
        return cls(
            app_name=_env_str("APP_NAME", "NovaChat") or "NovaChat",
            anthropic_api_key=_env_str("ANTHROPIC_API_KEY"),
            default_model=default_model,
            default_effort=default_effort,
            max_tokens=max(1024, _env_int("MAX_TOKENS", 64_000)),
            rate_limit_per_minute=_env_int("RATE_LIMIT_PER_MINUTE", 20),
            access_code=_env_str("ACCESS_CODE"),
            trust_proxy=_env_bool("TRUST_PROXY", False),
        )
