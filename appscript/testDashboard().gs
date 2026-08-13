function saveCcEmail(queryId, recipient, ccEmail) {

  const checkSql = `
    SELECT COUNT(*) AS total
    FROM \`${PROJECT_ID}.${DATASET}.${EMAIL_TABLE}\`
    WHERE query_id = '${queryId}'
  `;

  const checkResult = BigQuery.Jobs.query(
    {
      query: checkSql,
      useLegacySql: false
    },
    PROJECT_ID
  );

  const total = Number(checkResult.rows[0].f[0].v);

  let sql = "";

  if (total > 0) {

    sql = `
      UPDATE \`${PROJECT_ID}.${DATASET}.${EMAIL_TABLE}\`
      SET
        recipient = '${recipient}',
        cc_email = '${ccEmail}'
      WHERE query_id = '${queryId}'
    `;

  } else {

    sql = `
      INSERT INTO \`${PROJECT_ID}.${DATASET}.${EMAIL_TABLE}\`
      (
        notification_id,
        query_id,
        recipient,
        cc_email,
        email_sent,
        acknowledged
      )
      VALUES
      (
        GENERATE_UUID(),
        '${queryId}',
        '${recipient}',
        '${ccEmail}',
        FALSE,
        FALSE
      )
    `;

  }

  Logger.log(sql);

  BigQuery.Jobs.query(
    {
      query: sql,
      useLegacySql: false
    },
    PROJECT_ID
  );

  return {
    success: true
  };

}

function sendRecommendationEmail(rowData, recipient, ccEmail, subject) {

  if (!rowData || !recipient) {
    throw new Error("Recipient email is required.");
  }

  const emailSubject = subject || `[BQ AI Advisor] Query Optimization Recommendation – ${rowData.project_id || "Recommendation"}`;

  const MANDATORY_CC = "johan.regar@ioh.co.id";
  const ccList = String(ccEmail || "")
    .split(",")
    .map(function(e) { return e.trim(); })
    .filter(function(e) { return e && e.toLowerCase() !== MANDATORY_CC.toLowerCase(); });
  ccList.push(MANDATORY_CC);
  const finalCcEmail = ccList.join(", ");

  const htmlBody = `
    <div style="font-family:Segoe UI, Arial, sans-serif; color:#111827; max-width:720px;">

      <p style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:4px;font-size:14px;line-height:1.6;">
        <strong>Note:</strong> To improve query efficiency and optimize BigQuery costs, we recommend using
        <strong>Agentspace</strong> (<a href="https://agentspace.ioh.co.id" style="color:#b45309;">agentspace.ioh.co.id</a>)
        before executing your SQL query. Agentspace can help generate and refine optimized SQL statements,
        reducing unnecessary data scans, improving query performance, and minimizing BigQuery processing costs.
      </p>

      <p style="font-size:15px;">Hello,</p>

      <p style="font-size:14px;line-height:1.6;">
        The BQ AI Advisor has identified an optimization opportunity for the following project.
      </p>

      <p style="font-size:14px;line-height:1.8;">
        <strong>Project:</strong> ${rowData.project_id || "-"}<br>
        <strong>Severity:</strong> ${rowData.severity || "-"}${rowData.root_cause ? " — " + rowData.root_cause : ""}<br>
        <strong>Status:</strong> NOT OPTIMIZED
      </p>

      <p style="font-size:14px;line-height:1.6;">
        <strong>Recommendation</strong><br>
        ${String(rowData.recommendation || "-").replace(/\n/g, "<br>")}
      </p>

      <p style="font-size:14px;"><strong>Existing Query</strong></p>
      <pre style="background:#f3f4f6;padding:14px;border-radius:8px;white-space:pre-wrap;font-size:13px;line-height:1.5;">${String(rowData.query_text || "-").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>

      <p style="font-size:14px;"><strong>Optimized Query</strong></p>
      <pre style="background:#f3f4f6;padding:14px;border-radius:8px;white-space:pre-wrap;font-size:13px;line-height:1.5;">${String(rowData.optimized_sql || "Waiting AI Optimization").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>

      <p style="font-size:14px;line-height:1.6;">
        Please reach out to <a href="mailto:johan.regar@ioh.co.id">johan.regar@ioh.co.id</a>
        should you find any difficulties implementing the optimized query or have other concerns about these recommendations.
      </p>

      <p style="font-size:14px;">
        Regards,<br>
        <strong>BQ AI Advisor</strong>
      </p>

    </div>
  `;

  const messageParts = [
    `To: ${recipient}`,
    `Cc: ${finalCcEmail}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    `Subject: ${emailSubject}`,
    "",
    htmlBody
  ];

  const message = messageParts.join("\r\n");
  const encodedMessage = Utilities.base64EncodeWebSafe(message);

  Gmail.Users.Messages.send(
    {
      raw: encodedMessage
    },
    "me"
  );

  upsertEmailNotification(rowData.query_id, recipient, finalCcEmail, true);

  return {
    success: true,
    message: "Email sent successfully."
  };

}

function upsertEmailNotification(queryId, recipient, ccEmail, emailSent) {
  const safeQueryId = String(queryId || '').replace(/'/g, "''");
  const safeRecipient = String(recipient || '').replace(/'/g, "''");
  const safeCcEmail = String(ccEmail || '').replace(/'/g, "''");
  const sentFlag = emailSent ? 'TRUE' : 'FALSE';

  const checkSql = `
    SELECT COUNT(*) AS total
    FROM \`${PROJECT_ID}.${DATASET}.${EMAIL_TABLE}\`
    WHERE query_id = '${safeQueryId}'
  `;

  const checkResult = BigQuery.Jobs.query(
    {
      query: checkSql,
      useLegacySql: false
    },
    PROJECT_ID
  );

  const total = Number(checkResult.rows[0].f[0].v || 0);
  let sql;

  if (total > 0) {
    sql = `
      UPDATE \`${PROJECT_ID}.${DATASET}.${EMAIL_TABLE}\`
      SET
        recipient = '${safeRecipient}',
        cc_email = '${safeCcEmail}',
        email_sent = ${sentFlag}
        ${emailSent ? ", sent_at = CURRENT_TIMESTAMP()" : ""}
      WHERE query_id = '${safeQueryId}'
    `;
  } else {
    sql = `
      INSERT INTO \`${PROJECT_ID}.${DATASET}.${EMAIL_TABLE}\`
      (
        notification_id,
        query_id,
        recipient,
        cc_email,
        email_sent,
        sent_at,
        acknowledged
      )
      VALUES
      (
        GENERATE_UUID(),
        '${safeQueryId}',
        '${safeRecipient}',
        '${safeCcEmail}',
        ${sentFlag},
        ${emailSent ? "CURRENT_TIMESTAMP()" : "NULL"},
        FALSE
      )
    `;
  }

  BigQuery.Jobs.query(
    {
      query: sql,
      useLegacySql: false
    },
    PROJECT_ID
  );
}

function fetchPendingEmailRecommendations(fromDate, toDate, projectFilter, severityFilter, limit) {
  const TIMESTAMP_COLUMN = 'creation_time';
  const whereClauses = [
    'a.optimized_sql IS NOT NULL',
    'a.optimized_sql != ""',
    '(b.email_sent IS NULL OR b.email_sent = FALSE)'
  ];

  if (fromDate && toDate) {
    whereClauses.push(`DATE(a.${TIMESTAMP_COLUMN}) BETWEEN DATE('${fromDate}') AND DATE('${toDate}')`);
  } else if (fromDate) {
    whereClauses.push(`DATE(a.${TIMESTAMP_COLUMN}) >= DATE('${fromDate}')`);
  } else if (toDate) {
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
  const rowLimit = Number(limit) || 100;

  const sql = `
SELECT * EXCEPT(project_rn) FROM (
  SELECT * EXCEPT(rn),
    ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY total_bytes_billed DESC) AS project_rn
  FROM (
    SELECT
      a.query_id,
      a.project_id,
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
)
WHERE project_rn = 1
ORDER BY total_bytes_billed DESC
LIMIT ${rowLimit}
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
    result.rows.forEach(function(r) {
      rows.push({
        query_id: r.f[0].v,
        project_id: r.f[1].v,
        user_email: r.f[2].v,
        query_text: r.f[3].v,
        severity: r.f[4].v,
        root_cause: r.f[5].v,
        ai_summary: r.f[6].v,
        recommendation: r.f[7].v,
        optimized_sql: r.f[8].v,
        saving: Number(r.f[9].v || 0),
        saving_usd: Number(r.f[10].v || 0),
        saving_idr: Number(r.f[11].v || 0),
        bytes: Number(r.f[12].v || 0),
        slot_ms: Number(r.f[13].v || 0),
        cc_email: r.f[14] ? r.f[14].v : ''
      });
    });
  }

  return rows;
}

function sendPendingEmailRecommendations(fromDate, toDate, projectFilter, severityFilter, batchSize) {
  const rows = fetchPendingEmailRecommendations(fromDate, toDate, projectFilter, severityFilter, batchSize || 50);
  const results = [];

  rows.forEach(function(row) {
    try {
      const response = sendRecommendationEmail(
        row,
        row.user_email,
        row.cc_email,
        `[BQ AI Advisor] Query Optimization Recommendation – ${row.project_id || 'Recommendation'}`
      );
      results.push({ query_id: row.query_id, success: true, message: response.message });
    } catch (err) {
      results.push({ query_id: row.query_id, success: false, message: err.message });
    }
  });

  return {
    totalCandidates: rows.length,
    results: results
  };
}

function runAutoSendBatch() {
  // Scheduled batch trigger handler
  return sendPendingEmailRecommendations(null, null, '', '', 50);
}