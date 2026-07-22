from flask import Flask, jsonify
from google.cloud import bigquery
import logging
import uuid

PROJECT_ID = "ck-finops-data-prd-in60"

app = Flask(__name__)

logging.basicConfig(level=logging.INFO)

bq = bigquery.Client(project=PROJECT_ID)


def get_top_projects():

    sql = """
    SELECT
      project_id,
      SUM(total_bytes_billed) AS total_bytes
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

    return projects


def get_project_queries(project_id):

    client = bigquery.Client(project=project_id)

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
      AND statement_type = 'SELECT'
      AND query IS NOT NULL
    ORDER BY total_bytes_billed DESC
    LIMIT 20
    """

    return client.query(sql).result()


def save_inventory(row):

    merge_sql = """
    MERGE
    `ck-finops-data-prd-in60.finops_ai.query_inventory` T

    USING (
      SELECT @job_id AS job_id
    ) S

    ON T.job_id = S.job_id

    WHEN NOT MATCHED THEN

    INSERT (
      query_id,
      job_id,
      project_id,
      user_email,
      creation_time,
      statement_type,
      total_bytes_processed,
      total_bytes_billed,
      total_slot_ms,
      query_text,
      status,
      inserted_at
    )

    VALUES (
      @query_id,
      @job_id,
      @project_id,
      @user_email,
      @creation_time,
      @statement_type,
      @total_bytes_processed,
      @total_bytes_billed,
      @total_slot_ms,
      @query_text,
      'NEW',
      CURRENT_TIMESTAMP()
    )
    """

    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter(
                "query_id",
                "STRING",
                str(uuid.uuid4())
            ),
            bigquery.ScalarQueryParameter(
                "job_id",
                "STRING",
                row.job_id
            ),
            bigquery.ScalarQueryParameter(
                "project_id",
                "STRING",
                row.project_id
            ),
            bigquery.ScalarQueryParameter(
                "user_email",
                "STRING",
                row.user_email
            ),
            bigquery.ScalarQueryParameter(
                "creation_time",
                "TIMESTAMP",
                row.creation_time
            ),
            bigquery.ScalarQueryParameter(
                "statement_type",
                "STRING",
                row.statement_type
            ),
            bigquery.ScalarQueryParameter(
                "total_bytes_processed",
                "INT64",
                row.total_bytes_processed
            ),
            bigquery.ScalarQueryParameter(
                "total_bytes_billed",
                "INT64",
                row.total_bytes_billed
            ),
            bigquery.ScalarQueryParameter(
                "total_slot_ms",
                "INT64",
                row.total_slot_ms
            ),
            bigquery.ScalarQueryParameter(
                "query_text",
                "STRING",
                row.query
            )
        ]
    )

    bq.query(
        merge_sql,
        job_config=job_config
    ).result()


def collect_queries():

    projects = get_top_projects()

    logging.info(
        f"Top Projects: {projects}"
    )

    total_inserted = 0

    for project in projects:

        logging.info(
            f"Processing project: {project}"
        )

        try:

            rows = get_project_queries(project)

            for row in rows:

                save_inventory(row)

                total_inserted += 1

        except Exception as e:

            logging.error(
                f"Failed project {project}: {str(e)}"
            )

    return {
        "projects": len(projects),
        "inserted": total_inserted
    }


@app.route("/")
def health():

    return {
        "status": "ok"
    }


@app.route("/run")
def run():

    result = collect_queries()

    return jsonify(result)


if __name__ == "__main__":

    app.run(
        host="0.0.0.0",
        port=8080
    )