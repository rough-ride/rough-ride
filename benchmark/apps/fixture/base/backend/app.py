"""The fixture's API: answers on 127.0.0.1:8700."""

PORT = 8700


def notes() -> list[dict]:
    return [{"id": 1, "title": "Welcome"}]
