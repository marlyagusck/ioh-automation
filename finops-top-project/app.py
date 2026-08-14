from flask import Flask, jsonify
from google.cloud import bigquery
from google.cloud import resourcemanager_v3

PROJECT_ID = "ck-finops-data-prd-in60"

app = Flask(__name__)

bq = bigquery.Client(project=PROJECT_ID)
projects_client = resourcemanager_v3.ProjectsClient()

@app.route("/")
def health():
    return {"status": "ok"}

def get_project_name(project_id):

    try:

        project = projects_client.get_project(
            name=f"projects/{project_id}"
        )

        return project.display_name

    except Exception:

        return project_id

@app.route("/run")
def run():

    sql = """
    DECLARE window_end TIMESTAMP DEFAULT
      TIMESTAMP(DATETIME(CURRENT_DATE('Asia/Jakarta'), TIME '06:00:00'), 'Asia/Jakarta');
    DECLARE window_start TIMESTAMP DEFAULT TIMESTAMP_SUB(window_end, INTERVAL 7 DAY);

    SELECT
      project_id,
      SUM(total_bytes_billed) total_bytes
    FROM
      `region-asia-southeast2`.INFORMATION_SCHEMA.JOBS_BY_ORGANIZATION
    WHERE
      creation_time BETWEEN window_start AND window_end
    GROUP BY project_id
    ORDER BY total_bytes DESC
    LIMIT 10
    """

    rows = bq.query(sql).result()

    projects = []

    for row in rows:
        projects.append({
            "project_id": row.project_id,
            "project_name": get_project_name(row.project_id),
            "total_bytes": row.total_bytes
        })

    return jsonify({
        "projects": projects
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)