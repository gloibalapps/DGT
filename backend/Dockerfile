FROM python:3.12-slim
WORKDIR /app/backend
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Runtime dependencies only. pytest, black, flake8, and mypy are requirements-dev.txt.
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
# server.py also serves ../website for the legacy /api/site|privacy|terms routes
COPY website/ /app/website/
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
