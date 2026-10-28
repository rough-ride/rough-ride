"""Garden beds."""

import sqlite3

from fastapi import APIRouter, Depends, Response, status

from db import get_db
from routers.common import conflict, not_found
from schemas import BedIn, BedOut
from security import require_user

router = APIRouter(prefix="/api/beds", tags=["beds"], dependencies=[Depends(require_user)])

BED_SELECT = """
SELECT b.id, b.name, b.sunlight, b.notes,
       (SELECT COUNT(*) FROM plants p WHERE p.bed_id = b.id) AS plant_count,
       (SELECT COALESCE(SUM(h.weight_grams), 0)
          FROM harvests h JOIN plants p ON p.id = h.plant_id
         WHERE p.bed_id = b.id) AS harvest_grams
FROM beds b
"""


def _get_bed(conn: sqlite3.Connection, bed_id: int) -> dict:
    row = conn.execute(BED_SELECT + " WHERE b.id = ?", (bed_id,)).fetchone()
    if row is None:
        raise not_found("Bed")
    return dict(row)


def _name_taken(conn: sqlite3.Connection, name: str, exclude_id: int | None = None) -> bool:
    row = conn.execute(
        "SELECT id FROM beds WHERE name = ? AND id IS NOT ?", (name, exclude_id)
    ).fetchone()
    return row is not None


@router.get("", response_model=list[BedOut])
def list_beds(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    rows = conn.execute(BED_SELECT + " ORDER BY b.name COLLATE NOCASE").fetchall()
    return [dict(r) for r in rows]


@router.post("", response_model=BedOut, status_code=status.HTTP_201_CREATED)
def create_bed(payload: BedIn, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    if _name_taken(conn, payload.name):
        raise conflict("A bed with that name already exists.")
    cur = conn.execute(
        "INSERT INTO beds (name, sunlight, notes) VALUES (?, ?, ?)",
        (payload.name, payload.sunlight, payload.notes),
    )
    conn.commit()
    return _get_bed(conn, cur.lastrowid)


@router.put("/{bed_id}", response_model=BedOut)
def update_bed(bed_id: int, payload: BedIn, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    _get_bed(conn, bed_id)
    if _name_taken(conn, payload.name, exclude_id=bed_id):
        raise conflict("A bed with that name already exists.")
    conn.execute(
        "UPDATE beds SET name = ?, sunlight = ?, notes = ? WHERE id = ?",
        (payload.name, payload.sunlight, payload.notes, bed_id),
    )
    conn.commit()
    return _get_bed(conn, bed_id)


@router.delete("/{bed_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bed(bed_id: int, conn: sqlite3.Connection = Depends(get_db)) -> Response:
    bed = _get_bed(conn, bed_id)
    if bed["plant_count"] > 0:
        raise conflict("Move or delete the plants in this bed first.")
    conn.execute("DELETE FROM beds WHERE id = ?", (bed_id,))
    conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
