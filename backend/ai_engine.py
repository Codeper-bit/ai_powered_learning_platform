import asyncio
import json
import logging
import random
import re
from typing import List, Optional

from groq import AsyncGroq

import schemas
import os
from dotenv import load_dotenv
from text_extraction import sample_for_prompt

load_dotenv()
logger = logging.getLogger("ai_engine")

client = AsyncGroq(
    api_key=os.getenv("GROQ_API_KEY"), timeout=120.0, max_retries=4,) if os.getenv("GROQ_API_KEY") else None

QUESTION_GEN_MODEL = "openai/gpt-oss-120b"
ANALYSIS_MODEL = "openai/gpt-oss-120b"
AI_TIMEOUT_SECONDS = int(os.getenv("AI_TIMEOUT_SECONDS", "45"))


def _require_client():
    if not client:
        raise ValueError("GROQ_API_KEY is not configured in .env")


def _build_batch_prompt(
    exam_type: str,
    subject: str,
    topic: Optional[str],
    min_difficulty: str,
    max_difficulty: str,
    total_questions: int,
    custom_request: Optional[str],
    source_text: Optional[str],
    avoid_questions: Optional[List[str]] = None,
    focus_concepts: Optional[List[str]] = None,
) -> str:
    topic_line = f"Topic focus: {topic}\n    " if topic else ""
    custom_line = f"Extra instructions from the student: {custom_request}\n    " if custom_request else ""

    if source_text:
        source_block = f"""
    The student uploaded their own study material below. Base every question
    strictly on facts, definitions, and ideas that appear in this material —
    do not invent outside content.
    ---BEGIN MATERIAL---
    {sample_for_prompt(source_text)}
    ---END MATERIAL---
    """
    else:
        source_block = ""

    # Only populated by "Retry" (routers/sessions.py). Empty for a normal
    # quiz, so the prompt for every other caller is unchanged.
    retry_block = ""
    if focus_concepts:
        retry_block += f"""
    The student previously struggled with these concepts: {", ".join(focus_concepts)}.
    Make roughly a third to a half of the questions test these concepts, using
    the concept name exactly as written above in each question's "concept" field.
    For these concepts only, you may ask more than one question (use a different
    "sub_concept" each time) - this is the one exception to the "do not repeat
    the same concept" rule below. Do NOT make the quiz easier: keep the same
    difficulty spread across the requested range.
    """
    if avoid_questions:
        listed = "\n".join(f"    - {q}" for q in avoid_questions)
        retry_block += f"""
    The student has already seen the questions listed below. Do not repeat or
    lightly reword any of them - write new questions (testing the same ideas
    with different problems is fine).
    ---QUESTIONS ALREADY SEEN---
{listed}
    ---END QUESTIONS ALREADY SEEN---
    """

    return f"""
    You are an expert exam-prep tutor writing questions for a student.

    Exam type: {exam_type}
    Subject: {subject}
    {topic_line}Difficulty range: from "{min_difficulty}" up to "{max_difficulty}"
    {custom_line}{source_block}{retry_block}
    Generate exactly {total_questions} multiple-choice questions.
    - Spread the difficulty roughly evenly across the requested range (don't make them all the same difficulty).
    - Each question must have exactly 4 options.
    - Do not repeat the same question or concept twice.
    - "difficulty" must be one of the values within the requested range (e.g. Easy, Medium, Hard).
    - "concept" is the core concept; "sub_concept" is a narrower skill within it (e.g. concept "Differentiation", sub_concept "Chain Rule").
    - "explanation" is a short (1-2 sentence) explanation of why the correct answer is correct.
    - "misconception" is a short description of the single most common wrong-answer misconception for this question.
    - "option_insights" maps EACH of the 3 incorrect option strings (verbatim, as they appear in "options") to a short phrase describing what choosing that option suggests the student is confused about. Do not include the correct option as a key.

    Return ONLY a valid JSON object (no markdown, no extra text) with this exact shape:
    {{
      "questions": [
        {{
          "question": "The question string here",
          "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
          "correct_answer": "Option A text",
          "concept": "Core Concept Name",
          "sub_concept": "Narrower Skill Name",
          "difficulty": "Easy",
          "explanation": "Why the correct answer is correct.",
          "misconception": "What a student who picks a wrong option is likely confused about.",
          "option_insights": {{
            "Option B text": "What picking this suggests",
            "Option C text": "What picking this suggests",
            "Option D text": "What picking this suggests"
          }}
        }}
      ]
    }}
    The "questions" array must contain exactly {total_questions} items.
    """


# --- Answer-position shuffling ------------------------------------------------
# Models overwhelmingly put the correct answer first (the prompt's own example
# does too), so a student could score well by always picking "A". Options are
# therefore shuffled here, in code, after generation. Grading compares answer
# TEXT (never a letter/position) and option_insights is keyed by option text,
# so reordering is safe -- except for options that refer to other options by
# position, which would be corrupted by a shuffle.
_POSITIONAL_OPTION = re.compile(
    r"\b[A-D]\s*(?:,|and|&|or)\s*[A-D]\b"      # "A and C", "B, D"
    r"|\b[A-D]\s+(?i:only)\b|\b(?i:only)\s+[A-D]\b"   # "B only"
    r"|\((?:[A-D])\)"                                     # "(A)"
    r"|\b(?i:options?|choices?)\s+[A-D]\b",              # "Option B"
)
# Not positional by themselves, but only make sense as the LAST option.
_CLOSING_OPTION = re.compile(
    r"^\s*(?:all|none|neither|both)\b.{0,20}\b(?:above|these|them)\b", re.IGNORECASE
)


def shuffle_options(options: List[str], correct_answer: str) -> List[str]:
    """Return `options` in random order (a new list). Left untouched when it
    can't be done safely: correct answer not among the options, or an option
    that refers to another by letter. "All/None of the above"-style options
    stay last."""
    if not isinstance(options, list) or len(options) < 2:
        return options
    texts = [str(o) for o in options]
    if str(correct_answer).strip() not in {t.strip() for t in texts}:
        return options
    if any(_POSITIONAL_OPTION.search(t) for t in texts):
        return options
    movable = [o for o, t in zip(options, texts) if not _CLOSING_OPTION.match(t)]
    closing = [o for o, t in zip(options, texts) if _CLOSING_OPTION.match(t)]
    random.shuffle(movable)
    return movable + closing


# --- Output budget ------------------------------------------------------------
# QUESTION_GEN_MODEL is a reasoning model: its hidden reasoning tokens count
# against the completion limit. With no explicit limit, a long prompt (a
# document, or Retry's extra instructions) could burn the default budget
# before the JSON was finished, and Groq answered 400 json_validate_failed
# ("max completion tokens reached before generating a valid document").
# So: set the limit explicitly (scaled to the batch), keep reasoning short —
# writing quiz JSON needs little deliberation — and, if the output is still
# cut off, retry once with double the budget.
MAX_COMPLETION_TOKENS_CAP = 60000


def _completion_budget(total_questions: int) -> int:
    """~300 tokens of JSON per question (question, options, explanation,
    misconception, option_insights) x safety margin, plus room for reasoning."""
    return min(32000, 6000 + 500 * total_questions)


def _is_truncation_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "max completion tokens" in text or "json_validate_failed" in text


async def generate_question_batch(
    exam_type: str,
    subject: str,
    topic: Optional[str],
    min_difficulty: str,
    max_difficulty: str,
    total_questions: int,
    custom_request: Optional[str] = None,
    source_text: Optional[str] = None,
    avoid_questions: Optional[List[str]] = None,
    focus_concepts: Optional[List[str]] = None,
) -> List[schemas.DynamicQuestion]:
    """Generate a full batch of questions for one quiz_session in a single AI call.

    The whole session's question set is produced up front and persisted, so
    the quiz can run without hitting the AI again for every question (only
    for the analysis step). When `source_text` is provided (an uploaded
    document), questions are grounded in that material instead of general
    subject knowledge.
    """
    _require_client()

    total_questions = max(1, min(total_questions, 50))

    prompt = _build_batch_prompt(
        exam_type, subject, topic, min_difficulty, max_difficulty,
        total_questions, custom_request, source_text,
        avoid_questions, focus_concepts,
    )

    budget = _completion_budget(total_questions)
    for attempt in (1, 2):
        try:
            response = await asyncio.wait_for(
                client.chat.completions.create(
                    model=QUESTION_GEN_MODEL,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.7,
                    response_format={"type": "json_object"},
                    max_completion_tokens=budget,
                    # via extra_body so it works whatever groq SDK version is installed
                    extra_body={"reasoning_effort": "low"},
                ),
                timeout=AI_TIMEOUT_SECONDS,
            )
            raw_content = response.choices[0].message.content
            data = json.loads(raw_content)
            break
        except asyncio.TimeoutError as exc:
            logger.error("AI request timed out after %ss",
                         AI_TIMEOUT_SECONDS)
            raise ValueError(
                "The AI provider took too long to respond. Please try again.") from exc
        except json.JSONDecodeError as exc:
            logger.error("AI returned invalid JSON: %s", exc)
            raise ValueError(
                "The AI returned a malformed response. Please try again.") from exc
        except Exception as exc:
            if _is_truncation_error(exc):
                if attempt == 1:
                    budget = min(budget * 2, MAX_COMPLETION_TOKENS_CAP)
                    logger.warning(
                        "AI output was cut off; retrying once with a %s-token budget", budget)
                    continue
                logger.error("AI output cut off again at %s tokens: %s", budget, exc)
                raise ValueError(
                    "The AI ran out of space while writing this quiz. "
                    "Try again, or ask for fewer questions.") from exc
            logger.error("AI request failed: %s", exc)
            raise ValueError(
                "Could not reach the AI provider. Please try again.") from exc

    # The model is asked for a JSON object ({"questions": [...]}), but LLMs
    # don't always honor a wrapper shape perfectly — some responses come
    # back as a bare array instead. Accept either instead of crashing on
    # `.get()` when it's a list.
    if isinstance(data, list):
        raw_questions = data
    elif isinstance(data, dict):
        raw_questions = data.get("questions", [])
    else:
        raw_questions = []
    questions: List[schemas.DynamicQuestion] = []
    for item in raw_questions[:total_questions]:
        try:
            option_insights = item.get("option_insights")
            if not isinstance(option_insights, dict):
                option_insights = None
            questions.append(
                schemas.DynamicQuestion(
                    question=item["question"],
                    options=shuffle_options(item["options"], item["correct_answer"]),
                    correct_answer=item["correct_answer"],
                    concept=item.get("concept", subject),
                    difficulty=item.get("difficulty", min_difficulty),
                    explanation=item.get("explanation"),
                    misconception=item.get("misconception"),
                    option_insights=option_insights,
                )
            )
        except (KeyError, TypeError):
            # Skip malformed entries rather than failing the whole batch
            continue

    if not questions:
        raise ValueError("AI returned no usable questions for this batch")

    return questions


async def analyze_user_attempt(
    question_text: str,
    correct_answer: str,
    selected_answer: str,
    stored_explanation: Optional[str] = None,
    stored_misconception: Optional[str] = None,
    option_insights: Optional[dict] = None,
) -> schemas.AnswerResult:
    """Grade an answer against the stored question and return feedback.

    Grading itself is done locally (exact match against the stored
    correct_answer) so it's instant and free. The AI call is only used to
    generate a targeted explanation when the student gets it wrong and no
    misconception was pre-generated for this question.

    Note: the confidence label (repeated-error tracking) is layered on top
    of this in routers/attempts.py, which has access to the student's
    history — this function only ever grades a single, isolated attempt.
    """
    is_correct = selected_answer.strip() == correct_answer.strip()

    if is_correct:
        return schemas.AnswerResult(is_correct=True, correct_answer=correct_answer)

    # Wrong answer: prefer the option-specific insight for exactly the
    # option the student picked (most precise, no AI call), then fall back
    # to the question's single generic misconception (also no AI call).
    option_specific = None
    if option_insights and isinstance(option_insights, dict):
        option_specific = option_insights.get(selected_answer.strip())

    if option_specific or stored_misconception:
        misconception = schemas.MisconceptionFeedback(
            identified_misconception=option_specific or stored_misconception,
            confidence_score=1.0,
            targeted_explanation=stored_explanation or "Review the concept and try a similar question.",
        )
        return schemas.AnswerResult(
            is_correct=False,
            correct_answer=correct_answer,
            misconception_analysis=misconception,
        )

    # Fallback: no stored misconception (e.g. older question) - ask the AI live
    if not client:
        return schemas.AnswerResult(
            is_correct=False,
            correct_answer=correct_answer,
            misconception_analysis=schemas.MisconceptionFeedback(
                identified_misconception="Incorrect selection.",
                confidence_score=0.5,
                targeted_explanation="Review the problem and try again.",
            ),
        )

    prompt = f"""
    You are an AI diagnostic tutor. A student answered a question incorrectly.

    Question: {question_text}
    Correct answer: {correct_answer}
    Student's answer: {selected_answer}

    Return ONLY a JSON object in this exact format:
    {{
      "identified_misconception": "short description",
      "confidence_score": 0.85,
      "targeted_explanation": "short, encouraging explanation of the correct concept"
    }}
    """

    try:
        response = await asyncio.wait_for(
            client.chat.completions.create(
                model=ANALYSIS_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                response_format={"type": "json_object"},
            ),
            timeout=AI_TIMEOUT_SECONDS,
        )
        data = json.loads(response.choices[0].message.content)
    except Exception as exc:
        logger.error("Attempt analysis failed: %s", exc)
        data = {}

    misconception = schemas.MisconceptionFeedback(
        identified_misconception=data.get(
            "identified_misconception", "Incorrect selection."),
        confidence_score=data.get("confidence_score", 0.7),
        targeted_explanation=data.get(
            "targeted_explanation", "Review the problem and try again."),
    )

    return schemas.AnswerResult(
        is_correct=False,
        correct_answer=correct_answer,
        misconception_analysis=misconception,
    )
