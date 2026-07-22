FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .

RUN pip install \
    --no-cache-dir \
    -r requirements.txt

COPY . .

CMD gunicorn \
    --bind :8080 \
    --workers 2 \
    --threads 8 \
    --timeout 300 \
    app:app