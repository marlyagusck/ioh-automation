from flask import Flask, request, jsonify
from google.cloud import bigquery
import uuid

PROJECT_ID = "ck-finops-data-prd-in60"

app = Flask(__name__)

bq = bigquery.Client(project=PROJECT_ID)

@app.route("/")
def health():
    return {"status": "ok"}

@app.route("/run", methods=["POST"])
def run():

    body = request.get_json()

    project_id = body["project_id"]

    client = bigquery.Client(
        project=project_id
    )

    sql = """
    SELECT
      job_id,
      project_id,
      user_email,
      creation_time,
      statement_type,
      query,
      total_bytes_processed,
      total_bytes_billed,
      total_slot_ms
    FROM
      `region-asia-southeast2`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
    WHERE
      creation_time >= TIMESTAMP_SUB(
          CURRENT_TIMESTAMP(),
          INTERVAL 1 DAY
      )
      AND query IS NOT NULL
    ORDER BY total_bytes_billed DESC
    LIMIT 20
    """

    rows = client.query(sql).result()

    inserted = 0

    for row in rows:

        table = f"{PROJECT_ID}.finops_ai.query_inventory"

        payload = [{
            "query_id": str(uuid.uuid4()),
            "job_id": row.job_id,
            "project_id": row.project_id,
            "user_email": row.user_email,
            "creation_time": row.creation_time.isoformat(),
            "statement_type": row.statement_type,
            "total_bytes_processed": row.total_bytes_processed,
            "total_bytes_billed": row.total_bytes_billed,
            "total_slot_ms": row.total_slot_ms,
            "query_text": row.query,
            "status": "NEW",
            "inserted_at": None
        }]

        errors = bq.insert_rows_json(
            table,
            payload
        )

        if not errors:
            inserted += 1

    return jsonify({
        "project_id": project_id,
        "inserted": inserted
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)