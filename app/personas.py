"""Built-in personas and the system-prompt builder.

A persona is a short role description layered on top of a shared base prompt.
The user can also add their own "custom instructions" from the settings panel.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class Persona:
    id: str
    name: str
    emoji: str
    description: str
    instructions: str


PERSONAS: tuple[Persona, ...] = (
    Persona(
        id="assistant",
        name="Nova",
        emoji="✨",
        description="Friendly all-round assistant",
        instructions="",
    ),
    Persona(
        id="coder",
        name="Code Expert",
        emoji="💻",
        description="Senior engineer for code, debugging and reviews",
        instructions=(
            "Act as a senior software engineer. Give working, idiomatic code with brief "
            "explanations of the key decisions. When debugging, find the root cause before "
            "suggesting a fix, and point out edge cases or security issues you notice."
        ),
    ),
    Persona(
        id="tutor",
        name="Patient Tutor",
        emoji="🎓",
        description="Explains concepts step by step",
        instructions=(
            "Act as a patient tutor. Build explanations up from what the learner already "
            "knows, use small concrete examples and analogies, and check understanding with "
            "a short follow-up question when it helps."
        ),
    ),
    Persona(
        id="writer",
        name="Writing Coach",
        emoji="✍️",
        description="Drafts, edits and polishes writing",
        instructions=(
            "Act as an experienced editor and writing coach. Match the tone the user is going "
            "for, prefer clear and concrete language, and when editing, explain the most "
            "important changes briefly."
        ),
    ),
    Persona(
        id="analyst",
        name="Analyst",
        emoji="📊",
        description="Structured analysis and decisions",
        instructions=(
            "Act as a sharp analyst. Break problems into parts, state assumptions, weigh "
            "options with their trade-offs, and finish with a clear recommendation."
        ),
    ),
)
PERSONAS_BY_ID: dict[str, Persona] = {p.id: p for p in PERSONAS}
DEFAULT_PERSONA_ID = "assistant"

BASE_PROMPT = """\
You are Nova, the AI assistant inside NovaChat, a web chat app powered by Claude.

Be genuinely helpful, accurate and direct. Your replies are rendered as GitHub-flavored \
Markdown: use headings, lists and tables when they make an answer easier to scan, and \
fenced code blocks with a language tag for any code. Keep casual replies short and go \
deep when the question calls for it. If you are not sure about something, say so.

Today's date is {today}."""


def get_persona(persona_id: str | None) -> Persona:
    """Return the persona for `persona_id`, falling back to the default one."""
    return PERSONAS_BY_ID.get(persona_id or "", PERSONAS_BY_ID[DEFAULT_PERSONA_ID])


def build_system_prompt(
    persona_id: str | None = None,
    custom_instructions: str = "",
    today: date | None = None,
) -> str:
    """Compose the system prompt: base prompt + persona role + user instructions."""
    today = today or date.today()
    parts = [BASE_PROMPT.format(today=today.isoformat())]

    persona = get_persona(persona_id)
    if persona.instructions:
        parts.append(f"## Your role\n{persona.instructions}")

    custom = custom_instructions.strip()
    if custom:
        parts.append(f"## The user's custom instructions\n{custom}")

    return "\n\n".join(parts)
