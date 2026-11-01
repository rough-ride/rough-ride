"""Resets the sample database to its seed notes: `npm run db:reset`."""

from app import reset_db

if __name__ == "__main__":
    reset_db()
    print("Database reset.")
