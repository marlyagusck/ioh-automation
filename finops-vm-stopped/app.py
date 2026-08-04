from flask import Flask, request, jsonify
from google.cloud import bigquery, compute_v1
from datetime import datetime, timezone
import uuid

PROJECT_ID = "ck-finops-data-prd-in60"

STOPPED_THRESHOLD_DAYS = 14

app = Flask(__name__)

bq = bigquery.Client(project=PROJECT_ID)

instances_client = compute_v1.InstancesClient()

@app.route("/")
def health():
    return {"status": "ok"}

@app.route("/run", methods=["POST"])
def run():

    body = request.get_json()

    project_id = body["project_id"]

    now = datetime.now(timezone.utc)

    agg_request = compute_v1.AggregatedListInstancesRequest(
        project=project_id,
        filter='status = "TERMINATED"'
    )

    agg_list = instances_client.aggregated_list(request=agg_request)

    stopped_vms = []

    for zone, response in agg_list:

        if not response.instances:
            continue

        for instance in response.instances:

            if instance.status != "TERMINATED":
                continue

            if not instance.last_stop_timestamp:
                continue

            last_stop = datetime.fromisoformat(
                instance.last_stop_timestamp
            )

            stopped_days = (now - last_stop).days

            if stopped_days < STOPPED_THRESHOLD_DAYS:
                continue

            stopped_vms.append({
                "vm_id": str(uuid.uuid4()),
                "instance_id": str(instance.id),
                "instance_name": instance.name,
                "project_id": project_id,
                "zone": zone.split("/")[-1],
                "machine_type": instance.machine_type.split("/")[-1],
                "status": instance.status,
                "last_stop_timestamp": last_stop.isoformat(),
                "stopped_days": stopped_days,
                "inserted_at": datetime.utcnow().isoformat()
            })

    inserted = 0

    if stopped_vms:

        table = f"{PROJECT_ID}.finops_ai.vm_stopped_inventory"

        errors = bq.insert_rows_json(
            table,
            stopped_vms
        )

        if not errors:
            inserted = len(stopped_vms)

    return jsonify({
        "project_id": project_id,
        "stopped_vms_found": len(stopped_vms),
        "inserted": inserted
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
