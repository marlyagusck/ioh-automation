from flask import Flask, jsonify
from google.cloud import bigquery

PROJECT_ID = "ck-finops-data-prd-in60"

app = Flask(__name__)

bq = bigquery.Client(project=PROJECT_ID)


@app.route("/")
def root():
    return jsonify({
        "service": "finops-dashboard-api",
        "status": "RUNNING"
    })


@app.route("/health")
def health():
    return jsonify({
        "status": "ok"
    })


@app.route("/summary")
def summary():

    sql = """
    SELECT
      COUNT(*) AS total_findings,

      COUNTIF(
        severity = 'HIGH'
      ) AS high_findings,

      ROUND(
        AVG(
          potential_saving_percent
        ),
        2
      ) AS avg_saving_percent,

      ROUND(
        SUM(total_bytes_billed)
        / POW(1024,4),
        2
      ) AS total_tb_billed

    FROM
      `ck-finops-data-prd-in60.finops_ai.v_finops_ai_dashboard`
    """

    rows = list(
        bq.query(sql).result()
    )

    if not rows:
        return jsonify({
            "total_findings": 0,
            "high_findings": 0,
            "avg_saving_percent": 0,
            "total_tb_billed": 0
        })

    row = rows[0]

    return jsonify({
        "total_findings":
            row.total_findings or 0,

        "high_findings":
            row.high_findings or 0,

        "avg_saving_percent":
            row.avg_saving_percent or 0,

        "total_tb_billed":
            row.total_tb_billed or 0
    })


@app.route("/dashboard")
def dashboard():

    sql = """
    SELECT
      project_id,
      user_email,
      creation_time,
      statement_type,
      total_bytes_billed,
      total_slot_ms,
      severity,
      root_cause,
      ai_summary,
      recommendation,
      potential_saving_percent,
      generated_at
    FROM
      `ck-finops-data-prd-in60.finops_ai.v_finops_ai_dashboard`
    ORDER BY
      generated_at DESC
    LIMIT 100
    """

    rows = bq.query(sql).result()

    result = []

    for row in rows:

        result.append({

            "project_id": row.project_id,
            "user_email": row.user_email,
            "creation_time": str(row.creation_time),

            "statement_type": row.statement_type,

            "total_bytes_billed": row.total_bytes_billed,

            "total_tb_billed":
                round(
                    row.total_bytes_billed /
                    (1024 ** 4),
                    2
                ),

            "total_slot_ms": row.total_slot_ms,

            "severity": row.severity,
            "root_cause": row.root_cause,
            "ai_summary": row.ai_summary,
            "recommendation": row.recommendation,

            "potential_saving_percent":
                row.potential_saving_percent,

            "generated_at":
                str(row.generated_at)
        })

    return jsonify(result)


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=8080
    )