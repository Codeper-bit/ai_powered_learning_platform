import json
import logging
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

    return f"""
    You are an expert exam-prep tutor writing questions for a student.

    Exam type: {exam_type}
    Subject: {subject}
    {topic_line}Difficulty range: from "{min_difficulty}" up to "{max_difficulty}"
    {custom_line}{source_block}
    Generate exactly {total_questions} multiple-choice questions.
    - Spread the difficulty roughly evenly across the requested range (don't make them all the same difficulty).
    - Each question must have exactly 4 options.
    - Do not repeat the same question or concept twice.
    - "difficulty" must be one of the values within the requested range (e.g. Easy, Medium, Hard).
    - "explanation" is a short (1-2 sentence) explanation of why the correct answer is correct.
    - "misconception" is a short description of the most common wrong-answer misconception for this question.

    Return ONLY a valid JSON object (no markdown, no extra text) with this exact shape:
    {{
      "questions": [
        {{
          "question": "The question string here",
          "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
          "correct_answer": "Option A text",
          "concept": "Core Concept Name",
          "difficulty": "Easy",
          "explanation": "Why the correct answer is correct.",
          "misconception": "What a student who picks a wrong option is likely confused about."
        }}
      ]
    }}
    The "questions" array must contain exactly {total_questions} items.
    """


async def generate_question_batch(
    exam_type: str,
    subject: str,
    topic: Optional[str],
    min_difficulty: str,
    max_difficulty: str,
    total_questions: int,
    custom_request: Optional[str] = None,
    source_text: Optional[str] = None,
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
    )

    try:
        response = await client.chat.completions.create(
            model=QUESTION_GEN_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
            response_format={"type": "json_object"},
        )
        raw_content = response.choices[0].message.content
        data = json.loads(raw_content)
    except json.JSONDecodeError as exc:
        logger.error("AI returned invalid JSON: %s", exc)
        raise ValueError(
            "The AI returned a malformed response. Please try again.") from exc
    except Exception as exc:
        logger.error("AI request failed: %s", exc)
        raise ValueError(
            "Could not reach the AI provider. Please try again.") from exc

    raw_questions = data.get("questions", [])
    questions: List[schemas.DynamicQuestion] = []
    for item in raw_questions[:total_questions]:
        try:
            questions.append(
                schemas.DynamicQuestion(
                    question=item["question"],
                    options=item["options"],
                    correct_answer=item["correct_answer"],
                    concept=item.get("concept", subject),
                    difficulty=item.get("difficulty", min_difficulty),
                    explanation=item.get("explanation"),
                    misconception=item.get("misconception"),
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
) -> schemas.AnswerResult:
    """Grade an answer against the stored question and return feedback.

    Grading itself is done locally (exact match against the stored
    correct_answer) so it's instant and free. The AI call is only used to
    generate a targeted explanation when the student gets it wrong and no
    misconception was pre-generated for this question.
    """
    is_correct = selected_answer.strip() == correct_answer.strip()

    if is_correct:
        return schemas.AnswerResult(is_correct=True, correct_answer=correct_answer)

    # Wrong answer: prefer the misconception generated at batch time (no AI call)
    if stored_misconception:
        misconception = schemas.MisconceptionFeedback(
            identified_misconception=stored_misconception,
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
        response = await client.chat.completions.create(
            model=ANALYSIS_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            response_format={"type": "json_object"},
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
