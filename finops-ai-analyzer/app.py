from flask import Flask, jsonify
from google.cloud import bigquery
from vertexai.generative_models import GenerativeModel
import vertexai

import uuid
import json

from datetime import datetime

PROJECT_ID = "ck-finops-data-prd-in60"
LOCATION = "asia-southeast1"

BQ_PRICE_PER_TB_USD = 6.25  # BigQuery on-demand analysis price. Update if Google changes pricing.
USD_TO_IDR_RATE = 17900     # Kurs tetap untuk estimasi. Update berkala sesuai kurs berjalan.

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


def dry_run_bytes(sql):

    job_config = bigquery.QueryJobConfig(
        dry_run=True,
        use_query_cache=False
    )

    query_job = bq.query(sql, job_config=job_config)

    return query_job.total_bytes_processed


@app.route("/")
def health():
    return {"status": "ok"}


@app.route("/version")
def version():
    return {
        "service": "finops-ai-analyzer",
        "version": "v5"
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
            ) * BQ_PRICE_PER_TB_USD

            prompt = f"""
You are a Senior Google BigQuery FinOps Consultant.

Analyze this query and return ONLY VALID JSON.

{{
  "severity": "HIGH|MEDIUM|LOW",
  "root_cause": "",
  "ai_summary": "",
  "recommendation": "",
  "optimized_sql": "",
  "potential_saving_percent": 0
}}

Query Cost USD:
{round(cost_usd,2)}

SQL Query:
{query_text}
"""

            response = model.generate_content(prompt)

            result = response.text.strip()

            # kadang Gemini menambahkan ```json
            result = result.replace("```json", "")
            result = result.replace("```", "")
            result = result.strip()

            ai = json.loads(result)

            severity = ai.get("severity", "LOW")
            root_cause = ai.get("root_cause", "")
            ai_summary = ai.get("ai_summary", "")
            recommendation = ai.get("recommendation", "")
            optimized_sql = ai.get("optimized_sql", "").strip()

            # potential_saving_percent is measured via BigQuery dry-run
            # (real totalBytesProcessed diff), not taken from Gemini's
            # self-reported number. If optimized_sql doesn't dry-run
            # cleanly, this raises and the row is skipped as FAILED below
            # so it stays pending for the next run instead of being
            # recorded with a fabricated saving.
            if optimized_sql:

                original_bytes = dry_run_bytes(row.query_text)
                optimized_bytes = dry_run_bytes(optimized_sql)

                saving = round(
                    max(0.0, (original_bytes - optimized_bytes) / original_bytes * 100),
                    2
                ) if original_bytes > 0 else 0.0

                estimated_saving_usd = round(
                    (max(0, original_bytes - optimized_bytes) / (1024 ** 4)) * BQ_PRICE_PER_TB_USD,
                    2
                )

            else:

                saving = 0.0
                estimated_saving_usd = 0.0

            estimated_saving_idr = round(
                estimated_saving_usd * USD_TO_IDR_RATE,
                0
            )

            payload = [{

                "recommendation_id":
                    str(uuid.uuid4()),

                "query_id":
                    row.query_id,

                "severity":
                    severity,

                "root_cause":
                    root_cause,

                "ai_summary":
                    ai_summary,

                "recommendation":
                    recommendation,

                "optimized_sql":
                    optimized_sql,

                "potential_saving_percent":
                    saving,

                "estimated_saving_usd":
                    estimated_saving_usd,

                "estimated_saving_idr":
                    estimated_saving_idr,

                "generated_at":
                    datetime.utcnow().isoformat()

            }]

            errors = bq.insert_rows_json(
                f"{PROJECT_ID}.finops_ai.ai_recommendation",
                payload
            )

            if errors:

                print(
                    f"INSERT ERROR {row.query_id}"
                )
                print(errors)

            else:

                analyzed += 1

                print(
                    f"SUCCESS {row.query_id}"
                )

        except Exception as e:

            print(
                f"FAILED {row.query_id}"
            )
            print(str(e))

    return jsonify({
        "status": "SUCCESS",
        "analyzed": analyzed
    })


if __name__ == "__main__":

    app.run(
        host="0.0.0.0",
        port=8080
    )