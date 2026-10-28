"""Sign-in, sign-out and current session."""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from db import get_db
from schemas import LoginIn, SessionOut
from security import (
    SESSION_COOKIE,
    clear_session_cookie,
    create_session,
    delete_session,
    optional_user,
    set_session_cookie,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

INVALID_LOGIN = "Email or password is incorrect."


@router.post("/login", response_model=SessionOut)
def login(
    payload: LoginIn, response: Response, conn: sqlite3.Connection = Depends(get_db)
) -> dict:
    row = conn.execute(
        "SELECT id, email, display_name, password_hash FROM users WHERE email = ?",
        (payload.email,),
    ).fetchone()
    if row is None or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=INVALID_LOGIN)
    token = create_session(conn, row["id"])
    conn.commit()
    set_session_cookie(response, token)
    return {"user": {"id": row["id"], "email": row["email"], "display_name": row["display_name"]}}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, conn: sqlite3.Connection = Depends(get_db)) -> Response:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        delete_session(conn, token)
        conn.commit()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookie(response)
    return response


@router.get("/me", response_model=SessionOut)
def me(user: dict | None = Depends(optional_user)) -> dict:
    return {"user": user}
