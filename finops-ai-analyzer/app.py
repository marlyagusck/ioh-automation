from flask import Flask, jsonify
from google.cloud import bigquery
from vertexai.generative_models import GenerativeModel
import vertexai

import uuid
import re

from datetime import datetime

PROJECT_ID = "ck-finops-data-prd-in60"
LOCATION = "asia-southeast1"

app = Flask(__name__)

bq = bigquery.Client(
    project=PROJECT_ID
)

vertexai.init(
    project=PROJECT_ID,
    location=LOCATION
)

model = GenerativeModel(
    "gemini-2.5-flash"
)


def extract(pattern, text):

    match = re.search(
        pattern,
        text,
        re.IGNORECASE | re.DOTALL
    )

    if match:
        return match.group(1).strip()

    return ""


@app.route("/")
def health():

    return {
        "status": "ok"
    }


@app.route("/version")
def version():

    return {
        "service": "finops-ai-analyzer",
        "version": "v4"
    }


@app.route("/run")
def run():

    sql = """
    SELECT
      q.query_id,
      q.project_id,
      q.query_text,
      q.total_bytes_billed,
      q.total_slot_ms
    FROM
      `ck-finops-data-prd-in60.finops_ai.query_inventory` q
    LEFT JOIN
      `ck-finops-data-prd-in60.finops_ai.ai_recommendation` r
    ON
      q.query_id = r.query_id
    WHERE
      r.query_id IS NULL
      AND q.statement_type = 'SELECT'
      AND q.query_text IS NOT NULL
      AND q.total_bytes_billed > 1000000000
    ORDER BY
      q.total_bytes_billed DESC,
      q.total_slot_ms DESC
    LIMIT 10
    """

    rows = bq.query(sql).result()

    analyzed = 0

    for row in rows:

        try:

            query_text = row.query_text[:15000]

            cost_usd = (
                row.total_bytes_billed /
                (1024 ** 4)
            ) * 5

            prompt = f"""
You are a Senior Google BigQuery FinOps Consultant.

Analyze this BigQuery query.

Return EXACTLY in this format.

SEVERITY:
HIGH|MEDIUM|LOW

ROOT_CAUSE:
<short root cause>

AI_SUMMARY:
<short summary>

RECOMMENDATION:
<recommendation>

POTENTIAL_SAVING_PERCENT:
<number>

QUERY COST USD:
{round(cost_usd,2)}

QUERY:
{query_text}
"""

            response = model.generate_content(
                prompt
            )

            result = response.text

            severity = extract(
                r"SEVERITY:\s*(.*?)\n",
                result
            )

            root_cause = extract(
                r"ROOT_CAUSE:\s*(.*?)\n",
                result
            )

            ai_summary = extract(
                r"AI_SUMMARY:\s*(.*?)\n",
                result
            )

            recommendation = extract(
                r"RECOMMENDATION:\s*(.*?)\nPOTENTIAL_SAVING_PERCENT:",
                result
            )

            saving = extract(
                r"POTENTIAL_SAVING_PERCENT:\s*(\d+)",
                result
            )

            if saving == "":
                saving = 0
            else:
                saving = float(saving)

            payload = [{
                "recommendation_id": str(
                    uuid.uuid4()
                ),
                "query_id": row.query_id,
                "severity": severity,
                "root_cause": root_cause,
                "ai_summary": ai_summary,
                "recommendation": recommendation,
                "optimized_sql": None,
                "potential_saving_percent": saving,
                "generated_at": datetime.utcnow().isoformat()
            }]

            errors = bq.insert_rows_json(
                f"{PROJECT_ID}.finops_ai.ai_recommendation",
                payload
            )

            if errors:

                print(
                    f"INSERT ERROR: {errors}"
                )

            else:

                analyzed += 1

                print(
                    f"SUCCESS query_id={row.query_id}"
                )

        except Exception as e:

            print(
                f"ERROR query_id={row.query_id}: {str(e)}"
            )

    return jsonify({
        "status": "SUCCESS",
        "analyzed": analyzed
    })


if __name__ == "__main__":

    app.run(
        host="0.0.0.0",
        port=8080
    )