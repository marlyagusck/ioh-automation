function doGet() {
  return HtmlService
    .createHtmlOutputFromFile("Dashboard")
    .setTitle("FinOps AI Advisor");
}

const PROJECT_ID = "ck-finops-data-prd-in60";
const DATASET = "finops_ai";
const VIEW_NAME = "v_finops_dashboard_v2";
const EMAIL_TABLE = "email_notification";

const AUTO_SEND_INTERVAL_PROPERTY = 'AUTO_SEND_INTERVAL_MINUTES';
const DEFAULT_AUTO_SEND_INTERVAL_MINUTES = 60;

const BQ_PRICE_PER_TB_USD = 6.25;
const BQ_SLOT_COMMITMENT_RATE_USD = 0.05;
const BQ_SLOT_AUTOSCALE_RATE_USD = 0.06;
const USD_TO_IDR_RATE = 18000;
const INFO_SCHEMA_REGION = 'region-asia-southeast2';

function dryRunQuery(sql, projectId) {

  if (!sql || !String(sql).trim()) {
    throw new Error('SQL query is required.');
  }

  const targetProject = projectId || PROJECT_ID;

  const result = BigQuery.Jobs.query(
    {
      query: sql,
      useLegacySql: false,
      dryRun: true
    },
    targetProject
  );

  const totalBytesProcessed = Number(result.totalBytesProcessed || 0);
  const tb = totalBytesProcessed / 1099511627776;
  const costUsd = tb * BQ_PRICE_PER_TB_USD;
  const costIdr = costUsd * USD_TO_IDR_RATE;

  return {
    totalBytesProcessed: totalBytesProcessed,
    tb: tb,
    costUsd: costUsd,
    costIdr: costIdr
  };

}

function getAutomationStatus() {
  const trigger = findAutoSendTrigger();
  const storedInterval = Number(PropertiesService.getScriptProperties().getProperty(AUTO_SEND_INTERVAL_PROPERTY));
  return {
    enabled: !!trigger,
    triggerId: trigger ? trigger.getUniqueId() : null,
    intervalMinutes: storedInterval || DEFAULT_AUTO_SEND_INTERVAL_MINUTES
  };
}

function setAutoSendEnabled(enabled, intervalMinutes) {
  const existing = findAutoSendTrigger();

  if (existing) {
    ScriptApp.deleteTrigger(existing);
  }

  if (enabled) {
    const minutes = Number(intervalMinutes) || DEFAULT_AUTO_SEND_INTERVAL_MINUTES;
    createAutoSendTrigger(minutes);
    PropertiesService.getScriptProperties().setProperty(AUTO_SEND_INTERVAL_PROPERTY, String(minutes));
  }

  return getAutomationStatus();
}

function findAutoSendTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  return triggers.find(function(trigger) {
    return trigger.getHandlerFunction() === 'runAutoSendBatch';
  });
}

function createAutoSendTrigger(intervalMinutes) {
  const minutes = Number(intervalMinutes) || DEFAULT_AUTO_SEND_INTERVAL_MINUTES;
  const builder = ScriptApp.newTrigger('runAutoSendBatch').timeBased();

  if (minutes < 60) {
    builder.everyMinutes(minutes);
  } else if (minutes < 1440) {
    builder.everyHours(minutes / 60);
  } else {
    builder.everyDays(1);
  }

  return builder.create();
}

function getDashboardData(fromDate, toDate, projectFilter, severityFilter) {

  const TIMESTAMP_COLUMN = 'creation_time'; // change if your view uses a different timestamp column

  const whereClauses = [];

  if (fromDate && toDate) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fromDate) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(toDate)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD');
    }
    whereClauses.push(`DATE(a.${TIMESTAMP_COLUMN}) BETWEEN DATE('${fromDate}') AND DATE('${toDate}')`);
  } else if (fromDate) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fromDate)) throw new Error('Invalid date format. Use YYYY-MM-DD');
    whereClauses.push(`DATE(a.${TIMESTAMP_COLUMN}) >= DATE('${fromDate}')`);
  } else if (toDate) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(toDate)) throw new Error('Invalid date format. Use YYYY-MM-DD');
    whereClauses.push(`DATE(a.${TIMESTAMP_COLUMN}) <= DATE('${toDate}')`);
  }

  if (projectFilter) {
    projectFilter = String(projectFilter).replace(/'/g, "''");
    whereClauses.push(`a.project_id = '${projectFilter}'`);
  }

  if (severityFilter) {
    severityFilter = String(severityFilter).replace(/'/g, "''");
    whereClauses.push(`a.severity = '${severityFilter}'`);
  }

  const whereSql = whereClauses.length ? '\nWHERE ' + whereClauses.join(' AND ') + '\n' : '\n';

  const sql = `
SELECT * EXCEPT(rn) FROM (
  SELECT
    a.query_id,
    a.project_id,
    a.project_name,
    a.user_email,
    a.query_text,
    a.severity,
    a.root_cause,
    a.ai_summary,
    a.recommendation,
    a.optimized_sql,
    a.potential_saving_percent,
    a.estimated_saving_usd,
    a.estimated_saving_idr,
    a.total_bytes_billed,
    a.total_slot_ms,
    b.cc_email,
    ROW_NUMBER() OVER (PARTITION BY a.query_id ORDER BY a.total_bytes_billed DESC) AS rn

  FROM \`${PROJECT_ID}.${DATASET}.${VIEW_NAME}\` a

  LEFT JOIN \`${PROJECT_ID}.${DATASET}.${EMAIL_TABLE}\` b
  ON a.query_id = b.query_id
  ${whereSql}
)
WHERE rn = 1
ORDER BY total_bytes_billed DESC
LIMIT 100
`;

  const result = BigQuery.Jobs.query(
    {
      query: sql,
      useLegacySql: false
    },
    PROJECT_ID
  );

  const rows = [];

  if (result.rows) {

    result.rows.forEach(function(r){

      rows.push({

        query_id: r.f[0].v,

        project_id: r.f[1].v,

        project_name: r.f[2].v,

        user_email: r.f[3].v,

        query_text: r.f[4].v,

        severity: r.f[5].v,

        root_cause: r.f[6].v,

        ai_summary: r.f[7].v,

        recommendation: r.f[8].v,

        optimized_sql: r.f[9].v,

        saving:
          Number(r.f[10].v || 0),

        saving_usd:
          Number(r.f[11].v || 0),

        saving_idr:
          Number(r.f[12].v || 0),

        bytes:
          Number(r.f[13].v || 0),

        tb:
          (
            Number(r.f[13].v || 0)
            / 1099511627776
          ).toFixed(2),

        slot_ms:
          Number(r.f[14].v || 0),

        cc_email:
          r.f[15]
          ? r.f[15].v
          : "",

        status:
          r.f[9].v
          ? "OPTIMIZED"
          : "PENDING"

      });

    });

  }

  return rows;

}

function runBigQuerySync(sql, projectId, timeoutMs) {

  let queryResult = BigQuery.Jobs.query(
    {
      query: sql,
      useLegacySql: false,
      timeoutMs: timeoutMs || 30000
    },
    projectId
  );

  const jobId = queryResult.jobReference.jobId;
  const jobLocation = queryResult.jobReference.location;

  while (!queryResult.jobComplete) {
    Utilities.sleep(1000);
    queryResult = BigQuery.Jobs.getQueryResults(projectId, jobId, { location: jobLocation });
  }

  let rows = queryResult.rows || [];

  while (queryResult.pageToken) {
    queryResult = BigQuery.Jobs.getQueryResults(projectId, jobId, {
      location: jobLocation,
      pageToken: queryResult.pageToken
    });
    rows = rows.concat(queryResult.rows || []);
  }

  return rows;

}

function getCostUsageSummary(fromDate, toDate) {

  const whereClauses = [
    `job_type = 'QUERY'`,
    `statement_type != 'SCRIPT'`,
    `state = 'DONE'`
  ];

  if (fromDate && toDate) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fromDate) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(toDate)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD');
    }
    whereClauses.push(`DATE(creation_time) BETWEEN DATE('${fromDate}') AND DATE('${toDate}')`);
  } else if (fromDate) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fromDate)) throw new Error('Invalid date format. Use YYYY-MM-DD');
    whereClauses.push(`DATE(creation_time) >= DATE('${fromDate}')`);
  } else if (toDate) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(toDate)) throw new Error('Invalid date format. Use YYYY-MM-DD');
    whereClauses.push(`DATE(creation_time) <= DATE('${toDate}')`);
  }

  const whereSql = 'WHERE ' + whereClauses.join(' AND ');

  const slotCommitmentRateIdr = BQ_SLOT_COMMITMENT_RATE_USD * USD_TO_IDR_RATE;
  const slotAutoscaleRateIdr = BQ_SLOT_AUTOSCALE_RATE_USD * USD_TO_IDR_RATE;
  const onDemandRateIdr = BQ_PRICE_PER_TB_USD * USD_TO_IDR_RATE;

  const sql = `
SELECT
  CASE
    WHEN ENDS_WITH(user_email, '.gserviceaccount.com') THEN 'Service Account (SA)'
    WHEN ENDS_WITH(user_email, '@ioh.co.id') THEN 'Human User'
    ELSE 'Third-Party / Cross-Project SA'
  END AS account_type,
  COUNT(1) AS total_queries,
  ROUND(SUM(total_slot_ms) / (1000 * 3600), 2) AS total_slot_hours,
  ROUND(SUM(total_bytes_billed) / POW(1024, 4), 4) AS total_tb_scanned,
  ROUND(SUM(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND)) / 1000, 2) AS total_duration_seconds,
  ROUND((SUM(total_slot_ms) / (1000 * 3600)) * ${slotCommitmentRateIdr}, 0) AS est_cost_slot_commitment_idr,
  ROUND((SUM(total_slot_ms) / (1000 * 3600)) * ${slotAutoscaleRateIdr}, 0) AS est_cost_slot_autoscale_idr,
  ROUND((SUM(total_bytes_billed) / POW(1024, 4)) * ${onDemandRateIdr}, 0) AS est_cost_ondemand_scan_idr
FROM \`${INFO_SCHEMA_REGION}\`.INFORMATION_SCHEMA.JOBS_BY_ORGANIZATION
${whereSql}
GROUP BY account_type
ORDER BY total_slot_hours DESC
`;

  const queryRows = runBigQuerySync(sql, PROJECT_ID);

  const rows = [];

  queryRows.forEach(function(r) {
    rows.push({
      account_type: r.f[0].v,
      total_queries: Number(r.f[1].v || 0),
      total_slot_hours: Number(r.f[2].v || 0),
      total_tb_scanned: Number(r.f[3].v || 0),
      total_duration_seconds: Number(r.f[4].v || 0),
      est_cost_slot_commitment_idr: Number(r.f[5].v || 0),
      est_cost_slot_autoscale_idr: Number(r.f[6].v || 0),
      est_cost_ondemand_scan_idr: Number(r.f[7].v || 0)
    });
  });

  return rows;

}

function getSentEmailList(fromDate, toDate) {

  const whereClauses = ['b.email_sent = TRUE'];

  if (fromDate && toDate) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fromDate) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(toDate)) {
      throw new Error('Invalid date format. Use YYYY-MM-DD');
    }
    whereClauses.push(`DATE(b.sent_at) BETWEEN DATE('${fromDate}') AND DATE('${toDate}')`);
  } else if (fromDate) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fromDate)) throw new Error('Invalid date format. Use YYYY-MM-DD');
    whereClauses.push(`DATE(b.sent_at) >= DATE('${fromDate}')`);
  } else if (toDate) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(toDate)) throw new Error('Invalid date format. Use YYYY-MM-DD');
    whereClauses.push(`DATE(b.sent_at) <= DATE('${toDate}')`);
  }

  const whereSql = 'WHERE ' + whereClauses.join(' AND ');

  const sql = `
SELECT
  b.notification_id,
  b.query_id,
  b.recipient,
  b.cc_email,
  b.sent_at,
  b.acknowledged,
  a.project_id,
  a.project_name,
  a.severity
FROM \`${PROJECT_ID}.${DATASET}.${EMAIL_TABLE}\` b
LEFT JOIN \`${PROJECT_ID}.${DATASET}.${VIEW_NAME}\` a
  ON a.query_id = b.query_id
${whereSql}
ORDER BY b.sent_at DESC
LIMIT 500
`;

  const result = BigQuery.Jobs.query(
    {
      query: sql,
      useLegacySql: false
    },
    PROJECT_ID
  );

  const rows = [];

  if (result.rows) {

    result.rows.forEach(function(r){

      rows.push({
        notification_id: r.f[0].v,
        query_id: r.f[1].v,
        recipient: r.f[2].v,
        cc_email: r.f[3].v || "",
        sent_at: r.f[4].v,
        acknowledged: r.f[5].v === "true",
        project_id: r.f[6].v || "",
        project_name: r.f[7].v || "",
        severity: r.f[8].v || ""
      });

    });

  }

  return rows;

}