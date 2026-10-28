"""SQLite access: connection helper and schema."""

import sqlite3
from collections.abc import Iterator
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "garden.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS beds (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sunlight TEXT NOT NULL DEFAULT 'full_sun'
        CHECK (sunlight IN ('full_sun', 'partial_shade', 'shade')),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plants (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    variety TEXT NOT NULL DEFAULT '',
    bed_id INTEGER NOT NULL REFERENCES beds(id) ON DELETE RESTRICT,
    spacing_cm INTEGER CHECK (spacing_cm IS NULL OR spacing_cm > 0),
    planted_on TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plants_bed ON plants(bed_id);

CREATE TABLE IF NOT EXISTS harvests (
    id INTEGER PRIMARY KEY,
    plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    weight_grams INTEGER NOT NULL CHECK (weight_grams > 0),
    harvested_on TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_harvests_plant ON harvests(plant_id);
CREATE INDEX IF NOT EXISTS idx_harvests_date ON harvests(harvested_on);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    due_on TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    done_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(done, due_on);
"""

TABLES_IN_DROP_ORDER = ("tasks", "harvests", "plants", "beds", "sessions", "users")


def connect() -> sqlite3.Connection:
    # FastAPI may run a request's sync dependencies and handler on different
    # worker threads; each connection still serves only one request at a time.
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_db() -> Iterator[sqlite3.Connection]:
    """FastAPI dependency: one connection per request, committed on success."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def drop_schema(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = OFF")
    for table in TABLES_IN_DROP_ORDER:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.execute("PRAGMA foreign_keys = ON")


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None
