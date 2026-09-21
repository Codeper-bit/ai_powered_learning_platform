from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

import schemas
from supabase_jwt_auth import get_current_user
from deps import get_db

router = APIRouter(prefix="/todos", tags=["todos"])


def _to_schema(row) -> schemas.Todo:
    return schemas.Todo(
        id=row["id"],
        title=row["title"],
        subject=row["subject"],
        due_date=row["due_date"].isoformat() if row["due_date"] else None,
        priority=row["priority"],
        is_complete=row["is_complete"],
        created_at=row["created_at"].isoformat(),
    )


@router.get("", response_model=list[schemas.Todo])
async def list_todos(
    db: asyncpg.Pool = Depends(get_db),
    user_id: UUID = Depends(get_current_user),
):
    rows = await db.fetch(
        """
        SELECT id, title, subject, due_date, priority, is_complete, created_at
        FROM todos
        WHERE user_id = $1
        ORDER BY is_complete ASC, due_date ASC NULLS LAST, created_at DESC
        """,
        user_id,
    )
    return [_to_schema(r) for r in rows]


@router.post("", response_model=schemas.Todo)
async def create_todo(
    payload: schemas.TodoCreateRequest,
    db: asyncpg.Pool = Depends(get_db),
    user_id: UUID = Depends(get_current_user),
):
    if not payload.title:
        raise HTTPException(status_code=400, detail="A task needs a title.")
    row = await db.fetchrow(
        """
        INSERT INTO todos (user_id, title, subject, due_date, priority)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, title, subject, due_date, priority, is_complete, created_at
        """,
        user_id,
        payload.title,
        payload.subject or None,
        payload.due_date or None,
        payload.priority,
    )
    return _to_schema(row)


@router.patch("/{todo_id}", response_model=schemas.Todo)
async def update_todo(
    todo_id: int,
    payload: schemas.TodoUpdateRequest,
    db: asyncpg.Pool = Depends(get_db),
    user_id: UUID = Depends(get_current_user),
):
    existing = await db.fetchrow("SELECT user_id FROM todos WHERE id = $1", todo_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    if existing["user_id"] != user_id:
        raise HTTPException(
            status_code=403, detail="This task belongs to a different user.")

    row = await db.fetchrow(
        """
        UPDATE todos SET
            title = COALESCE($2, title),
            subject = CASE WHEN $3::boolean THEN $4 ELSE subject END,
            due_date = CASE WHEN $5::boolean THEN $6 ELSE due_date END,
            priority = COALESCE($7, priority),
            is_complete = COALESCE($8, is_complete)
        WHERE id = $1
        RETURNING id, title, subject, due_date, priority, is_complete, created_at
        """,
        todo_id,
        payload.title,
        payload.subject is not None,
        payload.subject,
        payload.due_date is not None,
        payload.due_date,
        payload.priority,
        payload.is_complete,
    )
    return _to_schema(row)


@router.delete("/{todo_id}")
async def delete_todo(
    todo_id: int,
    db: asyncpg.Pool = Depends(get_db),
    user_id: UUID = Depends(get_current_user),
):
    existing = await db.fetchrow("SELECT user_id FROM todos WHERE id = $1", todo_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    if existing["user_id"] != user_id:
        raise HTTPException(
            status_code=403, detail="This task belongs to a different user.")
    await db.execute("DELETE FROM todos WHERE id = $1", todo_id)
    return {"deleted": True}
