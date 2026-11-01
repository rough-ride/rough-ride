"""Throwaway notes API that the chaos-v1 prototypes attack. Not production code."""

import os
import secrets
import sqlite3
from contextlib import asynccontextmanager, closing
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

DB_PATH = Path(os.environ.get("SAMPLE_DB", Path(__file__).with_name("data.db")))
DEMO_EMAIL = "demo@example.com"
DEMO_PASSWORD = "demo-password"
SEED_NOTES = [
    ("Reading list", "Finish the book on distributed systems."),
    ("Meeting notes", "Agree the release date."),
    ("Garden plan", "Tomatoes along the south fence."),
    ("Gift ideas", "Board game for the weekend."),
    ("Groceries", "Milk, eggs, bread."),
]


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def reset_db() -> None:
    with closing(connect()) as conn, conn:
        conn.executescript(
            """
            DROP TABLE IF EXISTS notes;
            DROP TABLE IF EXISTS sessions;
            CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL);
            """
        )
        conn.executemany("INSERT INTO notes (title, body) VALUES (?, ?)", SEED_NOTES)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not DB_PATH.exists():
        reset_db()
    yield


app = FastAPI(title="Sample notes API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3731", "http://127.0.0.1:3731"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginIn(BaseModel):
    email: str
    password: str


class NoteIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=5000)


def current_user(authorization: str | None = Header(default=None)) -> str:
    token = (authorization or "").removeprefix("Bearer ").strip()
    with closing(connect()) as conn:
        row = conn.execute("SELECT email FROM sessions WHERE token = ?", (token,)).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Not signed in")
    return row["email"]


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/login")
def login(credentials: LoginIn) -> dict:
    if credentials.email != DEMO_EMAIL or credentials.password != DEMO_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = secrets.token_urlsafe(24)
    with closing(connect()) as conn, conn:
        conn.execute("INSERT INTO sessions (token, email) VALUES (?, ?)", (token, credentials.email))
    return {"token": token}


@app.get("/api/me")
def me(email: str = Depends(current_user)) -> dict:
    return {"email": email}


@app.get("/api/notes")
def list_notes(q: str = "", _: str = Depends(current_user)) -> list[dict]:
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT id, title, body, created_at FROM notes"
            " WHERE instr(lower(title), lower(?)) > 0 ORDER BY id DESC",
            (q.strip(),),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/notes", status_code=201)
def create_note(note: NoteIn, _: str = Depends(current_user)) -> dict:
    with closing(connect()) as conn, conn:
        cursor = conn.execute(
            "INSERT INTO notes (title, body) VALUES (?, ?)", (note.title, note.body)
        )
        row = conn.execute(
            "SELECT id, title, body, created_at FROM notes WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
    return dict(row)


@app.post("/api/test/reset", status_code=204)
def reset() -> None:
    reset_db()
