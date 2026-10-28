"""Drop and recreate the schema, then create the single demo user."""

from db import DB_PATH, connect, create_schema, drop_schema
from security import hash_password

DEMO_EMAIL = "demo@example.com"
DEMO_PASSWORD = "demo-password"
DEMO_NAME = "Demo Gardener"


def main() -> None:
    conn = connect()
    try:
        drop_schema(conn)
        create_schema(conn)
        conn.execute(
            "INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)",
            (DEMO_EMAIL, DEMO_NAME, hash_password(DEMO_PASSWORD)),
        )
        conn.commit()
    finally:
        conn.close()
    print(f"Database reset at {DB_PATH}")
    print(f"Sign in with {DEMO_EMAIL} / {DEMO_PASSWORD}")


if __name__ == "__main__":
    main()
