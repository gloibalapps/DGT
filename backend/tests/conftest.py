import os
import uuid
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

# Load frontend .env for EXPO_PUBLIC_BACKEND_URL (public URL)
load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture
def profile_id():
    """Unique profile per test-run so we don't collide with other data."""
    return f"TEST_{uuid.uuid4().hex[:12]}"
