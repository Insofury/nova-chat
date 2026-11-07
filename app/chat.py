"""Turns a raw `ChatRequest` from the browser into a validated `ChatJob`.

This is where all request rules live: which models/efforts are allowed, how big
messages and images may be, and how browser messages map onto the Claude
Messages API content-block format.
"""

from __future__ import annotations

import base64
import binascii
from datetime import date
from typing import Any

from .config import EFFORT_LEVELS, MODELS_BY_ID, Settings
from .llm import ChatJob
from .personas import build_system_prompt
from .schemas import ChatMessage, ChatRequest


class ChatValidationError(ValueError):
    """Raised when a request breaks one of the rules below (becomes HTTP 400)."""


def _decoded_size(b64: str) -> int:
    """Validate base64 and return the decoded byte size."""
    try:
        return len(base64.b64decode(b64, validate=True))
    except (binascii.Error, ValueError) as exc:
        raise ChatValidationError("An attached image is not valid base64 data.") from exc


def to_api_message(message: ChatMessage) -> dict[str, Any] | None:
    """Convert one browser message to a Messages API message (None = skip it)."""
    text = message.content
    has_text = bool(text.strip())

    if message.role == "assistant" or not message.images:
        return {"role": message.role, "content": text} if has_text else None

    blocks: list[dict[str, Any]] = [
        {"type": "image", "source": {"type": "base64", "media_type": img.media_type, "data": img.data}}
        for img in message.images
    ]
    if has_text:
        blocks.append({"type": "text", "text": text})
    return {"role": "user", "content": blocks}


def build_job(request: ChatRequest, settings: Settings, today: date | None = None) -> ChatJob:
    """Validate the request against `settings` and build the job for an engine."""
    model = request.model or settings.default_model
    if model not in MODELS_BY_ID:
        raise ChatValidationError(f"Unknown model '{model}'.")

    effort = request.effort or settings.default_effort
    if effort not in EFFORT_LEVELS:
        raise ChatValidationError(f"Unknown effort level '{effort}'.")

    if len(request.messages) > settings.max_messages:
        raise ChatValidationError(
            f"This conversation is too long ({len(request.messages)} messages). Please start a new chat."
        )

    if len(request.custom_instructions) > settings.max_custom_instructions_chars:
        raise ChatValidationError("Custom instructions are too long.")

    for message in request.messages:
        if len(message.content) > settings.max_message_chars:
            raise ChatValidationError(
                f"A message is longer than the {settings.max_message_chars:,} character limit."
            )
        if message.images and message.role != "user":
            raise ChatValidationError("Only user messages can contain images.")
        if len(message.images) > settings.max_images_per_message:
            raise ChatValidationError(f"You can attach up to {settings.max_images_per_message} images per message.")
        for image in message.images:
            if _decoded_size(image.data) > settings.max_image_bytes:
                limit_mb = settings.max_image_bytes / (1024 * 1024)
                raise ChatValidationError(f"Each image must be smaller than {limit_mb:.0f} MB.")

    api_messages = [m for m in (to_api_message(msg) for msg in request.messages) if m is not None]

    # The Messages API needs the conversation to start and end with a user turn.
    while api_messages and api_messages[0]["role"] != "user":
        api_messages.pop(0)
    if not api_messages or api_messages[-1]["role"] != "user":
        raise ChatValidationError("The last message must be a non-empty user message.")

    return ChatJob(
        model=model,
        system=build_system_prompt(request.persona, request.custom_instructions, today),
        messages=api_messages,
        effort=effort,
        show_thinking=request.show_thinking,
    )
