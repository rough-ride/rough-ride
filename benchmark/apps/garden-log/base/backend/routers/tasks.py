"""Garden tasks."""

import sqlite3
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response, status

from db import get_db
from routers.common import not_found
from schemas import TaskIn, TaskOut, TaskUpdate
from security import require_user

router = APIRouter(prefix="/api/tasks", tags=["tasks"], dependencies=[Depends(require_user)])

TASK_COLUMNS = "id, title, due_on, done, done_at"


def _with_overdue(row: sqlite3.Row) -> dict:
    task = dict(row)
    task["done"] = bool(task["done"])
    task["overdue"] = not task["done"] and task["due_on"] < date.today().isoformat()
    return task


def _get_task(conn: sqlite3.Connection, task_id: int) -> dict:
    row = conn.execute(f"SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise not_found("Task")
    return _with_overdue(row)


@router.get("", response_model=list[TaskOut])
def list_tasks(
    state: Literal["open", "done", "all"] = Query(default="open"),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    if state == "open":
        sql = f"SELECT {TASK_COLUMNS} FROM tasks WHERE done = 0 ORDER BY due_on, id"
    elif state == "done":
        sql = f"SELECT {TASK_COLUMNS} FROM tasks WHERE done = 1 ORDER BY done_at DESC, id DESC"
    else:
        sql = f"SELECT {TASK_COLUMNS} FROM tasks ORDER BY done, due_on, id"
    return [_with_overdue(r) for r in conn.execute(sql).fetchall()]


@router.get("/upcoming", response_model=list[TaskOut])
def upcoming_tasks(
    limit: int = Query(default=5, ge=1, le=50),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    rows = conn.execute(
        f"SELECT {TASK_COLUMNS} FROM tasks WHERE done = 0 ORDER BY due_on, id LIMIT ?",
        (limit,),
    ).fetchall()
    return [_with_overdue(r) for r in rows]


@router.post("", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
def create_task(payload: TaskIn, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    cur = conn.execute(
        "INSERT INTO tasks (title, due_on) VALUES (?, ?)",
        (payload.title, payload.due_on.isoformat()),
    )
    conn.commit()
    return _get_task(conn, cur.lastrowid)


@router.patch("/{task_id}", response_model=TaskOut)
def update_task(
    task_id: int, payload: TaskUpdate, conn: sqlite3.Connection = Depends(get_db)
) -> dict:
    task = _get_task(conn, task_id)
    title = payload.title if payload.title is not None else task["title"]
    due_on = payload.due_on.isoformat() if payload.due_on is not None else task["due_on"]
    done = payload.done if payload.done is not None else task["done"]
    if done and not task["done"]:
        done_at_sql = "datetime('now')"
    elif done:
        done_at_sql = "done_at"
    else:
        done_at_sql = "NULL"
    conn.execute(
        f"UPDATE tasks SET title = ?, due_on = ?, done = ?, done_at = {done_at_sql} WHERE id = ?",
        (title, due_on, int(done), task_id),
    )
    conn.commit()
    return _get_task(conn, task_id)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: int, conn: sqlite3.Connection = Depends(get_db)) -> Response:
    _get_task(conn, task_id)
    conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
