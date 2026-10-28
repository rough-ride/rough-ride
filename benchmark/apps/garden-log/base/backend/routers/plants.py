"""Plants and their harvest history."""

import sqlite3

from fastapi import APIRouter, Depends, Query, Response, status

from db import get_db
from routers.common import ensure_bed_exists, escape_like, not_found
from routers.harvests import HARVEST_SELECT
from schemas import PlantDetailOut, PlantIn, PlantOut
from security import require_user

router = APIRouter(prefix="/api/plants", tags=["plants"], dependencies=[Depends(require_user)])

PLANT_SELECT = """
SELECT p.id, p.name, p.variety, p.bed_id, b.name AS bed_name, p.spacing_cm,
       p.planted_on, p.notes, p.created_at, p.updated_at,
       COUNT(h.id) AS harvest_count,
       COALESCE(SUM(h.weight_grams), 0) AS harvest_grams
FROM plants p
JOIN beds b ON b.id = p.bed_id
LEFT JOIN harvests h ON h.plant_id = p.id
"""


def _get_plant(conn: sqlite3.Connection, plant_id: int) -> dict:
    row = conn.execute(
        PLANT_SELECT + " WHERE p.id = ? GROUP BY p.id", (plant_id,)
    ).fetchone()
    if row is None:
        raise not_found("Plant")
    return dict(row)


def _plant_values(payload: PlantIn) -> tuple:
    planted_on = payload.planted_on.isoformat() if payload.planted_on else None
    return (
        payload.name,
        payload.variety,
        payload.bed_id,
        payload.spacing_cm,
        planted_on,
        payload.notes,
    )


@router.get("", response_model=list[PlantOut])
def list_plants(
    q: str = Query(default="", max_length=80),
    bed_id: int | None = Query(default=None, gt=0),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    clauses: list[str] = []
    params: list[object] = []
    term = q.strip()
    if term:
        clauses.append("p.name LIKE ? ESCAPE '\\'")
        params.append(f"%{escape_like(term)}%")
    if bed_id is not None:
        clauses.append("p.bed_id = ?")
        params.append(bed_id)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        PLANT_SELECT + where + " GROUP BY p.id ORDER BY p.name COLLATE NOCASE, p.id",
        params,
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("", response_model=PlantOut, status_code=status.HTTP_201_CREATED)
def create_plant(payload: PlantIn, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    ensure_bed_exists(conn, payload.bed_id)
    cur = conn.execute(
        """
        INSERT INTO plants (name, variety, bed_id, spacing_cm, planted_on, notes)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        _plant_values(payload),
    )
    conn.commit()
    return _get_plant(conn, cur.lastrowid)


@router.get("/{plant_id}", response_model=PlantDetailOut)
def get_plant(plant_id: int, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    plant = _get_plant(conn, plant_id)
    harvests = conn.execute(
        HARVEST_SELECT + " WHERE h.plant_id = ? ORDER BY h.harvested_on DESC, h.id DESC",
        (plant_id,),
    ).fetchall()
    plant["harvests"] = [dict(h) for h in harvests]
    return plant


@router.put("/{plant_id}", response_model=PlantOut)
def update_plant(
    plant_id: int, payload: PlantIn, conn: sqlite3.Connection = Depends(get_db)
) -> dict:
    _get_plant(conn, plant_id)
    ensure_bed_exists(conn, payload.bed_id)
    conn.execute(
        """
        UPDATE plants
        SET name = ?, variety = ?, bed_id = ?, spacing_cm = ?, planted_on = ?,
            notes = ?, updated_at = datetime('now')
        WHERE id = ?
        """,
        (*_plant_values(payload), plant_id),
    )
    conn.commit()
    return _get_plant(conn, plant_id)


@router.delete("/{plant_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_plant(plant_id: int, conn: sqlite3.Connection = Depends(get_db)) -> Response:
    _get_plant(conn, plant_id)
    conn.execute("DELETE FROM plants WHERE id = ?", (plant_id,))
    conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
