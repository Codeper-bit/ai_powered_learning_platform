import asyncpg
from fastapi import APIRouter, Depends, HTTPException

import schemas
from auth import hash_password, verify_password
from deps import get_db
from tokens import create_access_token

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=schemas.AuthResponse)
async def register(payload: schemas.RegisterRequest, db: asyncpg.Pool = Depends(get_db)):
    if not payload.name or not payload.password:
        raise HTTPException(status_code=400, detail="Name and password are required.")
    if len(payload.password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters.")

    existing = await db.fetchrow(
        "SELECT id, password_hash FROM users WHERE name = $1", payload.name
    )

    if existing is not None:
        if existing["password_hash"]:
            raise HTTPException(
                status_code=409,
                detail="That name is already taken. Try logging in instead.",
            )
        # A row with this name already exists but has no password — it was
        # created before login existed (or via the old get-or-create-by-name
        # flow). Claim it by setting a password now, instead of dead-ending
        # the user with "name taken" on register and "wrong password" on
        # login for an account they can never actually get into.
        try:
            await db.execute(
                "UPDATE users SET password_hash = $1, email = COALESCE($2, email) WHERE id = $3",
                hash_password(payload.password),
                payload.email,
                existing["id"],
            )
        except asyncpg.UniqueViolationError:
            raise HTTPException(status_code=409, detail="That email is already registered.")
        token = create_access_token(existing["id"])
        return schemas.AuthResponse(user_id=existing["id"], name=payload.name, access_token=token)

    try:
        row = await db.fetchrow(
            "INSERT INTO users (name, password_hash, email) VALUES ($1, $2, $3) RETURNING id",
            payload.name,
            hash_password(payload.password),
            payload.email,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="That email is already registered.")
    token = create_access_token(row["id"])
    return schemas.AuthResponse(user_id=row["id"], name=payload.name, access_token=token)


@router.post("/login", response_model=schemas.AuthResponse)
async def login(payload: schemas.LoginRequest, db: asyncpg.Pool = Depends(get_db)):
    row = await db.fetchrow(
        "SELECT id, name, password_hash FROM users WHERE name = $1", payload.name
    )
    if row is None or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect name or password.")
    token = create_access_token(row["id"])
    return schemas.AuthResponse(user_id=row["id"], name=row["name"], access_token=token)
