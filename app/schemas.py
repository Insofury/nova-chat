"""Pydantic models describing the JSON the browser sends to the API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ImageMediaType = Literal["image/png", "image/jpeg", "image/gif", "image/webp"]


class ImageAttachment(BaseModel):
    """An image the user attached to a message, sent as base64 (no data: prefix)."""

    media_type: ImageMediaType
    data: str = Field(min_length=1)


class ChatMessage(BaseModel):
    """One turn of the conversation as stored by the browser."""

    role: Literal["user", "assistant"]
    content: str = ""
    images: list[ImageAttachment] = Field(default_factory=list)


class ChatRequest(BaseModel):
    """Body of `POST /api/chat`.

    The browser owns the conversation history and sends all of it on each request
    (the Claude API is stateless). Limits are enforced in `app.chat.build_job`
    because they come from runtime settings.
    """

    messages: list[ChatMessage] = Field(min_length=1)
    model: str | None = None
    effort: str | None = None
    persona: str | None = None
    custom_instructions: str = ""
    show_thinking: bool = True
