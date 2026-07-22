from flask import Flask, jsonify
from google.cloud import bigquery

PROJECT_ID = "ck-finops-data-prd-in60"

app = Flask(__name__)

bq = bigquery.Client(project=PROJECT_ID)

@app.route("/")
def health():
    return {"status": "ok"}

@app.route("/run")
def run():

    sql = """
    SELECT
      project_id,
      SUM(total_bytes_billed) total_bytes
    FROM
      `region-asia-southeast2`.INFORMATION_SCHEMA.JOBS_BY_ORGANIZATION
    WHERE
      creation_time >= TIMESTAMP_SUB(
          CURRENT_TIMESTAMP(),
          INTERVAL 1 DAY
      )
    GROUP BY project_id
    ORDER BY total_bytes DESC
    LIMIT 10
    """

    rows = bq.query(sql).result()

    projects = []

    for row in rows:
        projects.append(row.project_id)

    return jsonify({
        "projects": projects
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)