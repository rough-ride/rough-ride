"""Shared helpers for the resource routers."""

import sqlite3

from fastapi import HTTPException, status


def not_found(what: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found.")


def conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def ensure_bed_exists(conn: sqlite3.Connection, bed_id: int) -> None:
    if conn.execute("SELECT 1 FROM beds WHERE id = ?", (bed_id,)).fetchone() is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Choose an existing bed.",
        )


def ensure_plant_exists(conn: sqlite3.Connection, plant_id: int) -> None:
    if conn.execute("SELECT 1 FROM plants WHERE id = ?", (plant_id,)).fetchone() is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Choose an existing plant.",
        )


def escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
