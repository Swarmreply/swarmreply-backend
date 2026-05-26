// ============================================
// services/csvImportService.js
// CSV import and automated review request trigger
// Parses customer/patient lists, deduplicates,
// schedules review requests on a delay
// Works with any source: Dentrix export,
// Eaglesoft report, manual spreadsheet, etc.
// ============================================

const { parse } = require('csv-parse/sync');
const { query } = require('../database/db');
const logger = require('../utils/logger');

// ============================================
// COLUMN DETECTION
// Maps common column name variations to
// our standard fields: name, email, phone,
// visit_date, provider, notes
// ============================================

const COLUMN_MAPS = {
  name: [
    'name', 'full name', 'fullname', 'patient name', 'patientname',
    'customer name', 'customername', 'client name', 'contact name',
    'first name', 'firstname', 'last name', 'lastname',
    'patient', 'customer', 'client'
  ],
  first_name: ['first name', 'firstname', 'first', 'fname', 'given name'],
  last_name: ['last name', 'lastname', 'last', 'lname', 'surname', 'family name'],
  email: [
    'email', 'email address', 'emailaddress', 'e-mail',
    'patient email', 'customer email', 'contact email'
  ],
  phone: [
    'phone', 'phone number', 'phonenumber', 'mobile', 'cell',
    'cell phone', 'mobile phone', 'telephone', 'tel',
    'patient phone', 'customer phone', 'contact phone', 'sms'
  ],
  visit_date: [
    'date', 'visit date', 'visitdate', 'appointment date', 'appointmentdate',
    'service date', 'servicedate', 'date of service', 'dos',
    'date of visit', 'procedure date', 'treatment date',
    'appointment', 'last visit', 'lastvisit'
  ],
  provider: [
    'provider', 'doctor', 'dentist', 'physician', 'staff',
    'hygienist', 'practitioner', 'clinician', 'dr'
  ],
  notes: ['notes', 'note', 'comments', 'comment', 'memo', 'remarks']
};

/**
 * detectColumns()
 * Auto-detect which columns map to which fields
 * Handles messy real-world CSV exports from dental PMS
 *
 * @param {Array} headers - Array of header strings from CSV
 * @returns {Object} Map of field → column index
 */
function detectColumns(headers) {
  const normalized = headers.map(h =>
    (h || '').toString().toLowerCase().trim().replace(/[_\-*]/g, ' ')
  );

  const mapping = {};

  for (const [field, aliases] of Object.entries(COLUMN_MAPS)) {
    for (let i = 0; i < normalized.length; i++) {
      if (aliases.some(alias => normalized[i] === alias || normalized[i].includes(alias))) {
        if (!mapping[field]) mapping[field] = i;
      }
    }
  }

  return mapping;
}

// ============================================
// CSV PARSER
// ============================================

/**
 * parseCSV()
 * Parse a CSV buffer into structured contact rows
 * Auto-detects columns, handles encoding issues,
 * validates each row, returns stats
 *
 * @param {Buffer|string} fileContent - CSV file content
 * @returns {Object} { contacts, errors, columnMapping, stats }
 */
function parseCSV(fileContent) {
  // Try to parse the CSV
  let records;
  try {
    records = parse(fileContent.toString(), {
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true // Handle Excel BOM characters
    });
  } catch (err) {
    throw new Error(`Invalid CSV format: ${err.message}`);
  }

  if (records.length < 2) {
    throw new Error('CSV must have at least a header row and one data row');
  }

  const headers = records[0];
  const dataRows = records.slice(1);
  const columnMapping = detectColumns(headers);

  // Validate we have minimum required columns
  const hasName = columnMapping.name !== undefined ||
    (columnMapping.first_name !== undefined && columnMapping.last_name !== undefined);
  const hasContact = columnMapping.email !== undefined || columnMapping.phone !== undefined;

  if (!hasName) {
    throw new Error(
      'Could not find a name column. Please ensure your CSV has a column named ' +
      '"Name", "Full Name", "Patient Name", or "First Name" + "Last Name".'
    );
  }
  if (!hasContact) {
    throw new Error(
      'Could not find an email or phone column. Please ensure your CSV has ' +
      '"Email" or "Phone" columns.'
    );
  }

  const contacts = [];
  const errors = [];

  dataRows.forEach((row, idx) => {
    const lineNum = idx + 2; // 1-indexed, account for header

    // Extract name
    let name = '';
    if (columnMapping.name !== undefined) {
      name = (row[columnMapping.name] || '').trim();
    } else if (columnMapping.first_name !== undefined && columnMapping.last_name !== undefined) {
      const first = (row[columnMapping.first_name] || '').trim();
      const last = (row[columnMapping.last_name] || '').trim();
      name = [first, last].filter(Boolean).join(' ');
    } else if (columnMapping.first_name !== undefined) {
      name = (row[columnMapping.first_name] || '').trim();
    }

    // Extract contact
    const email = columnMapping.email !== undefined
      ? (row[columnMapping.email] || '').trim().toLowerCase()
      : '';
    const phone = columnMapping.phone !== undefined
      ? cleanPhone(row[columnMapping.phone])
      : '';

    // Extract optional fields
    const visitDate = columnMapping.visit_date !== undefined
      ? parseDate(row[columnMapping.visit_date])
      : null;
    const provider = columnMapping.provider !== undefined
      ? (row[columnMapping.provider] || '').trim()
      : '';
    const notes = columnMapping.notes !== undefined
      ? (row[columnMapping.notes] || '').trim()
      : '';

    // Validate row
    if (!name) {
      errors.push(`Row ${lineNum}: missing name — skipped`);
      return;
    }
    if (!email && !phone) {
      errors.push(`Row ${lineNum}: "${name}" has no email or phone — skipped`);
      return;
    }
    if (email && !isValidEmail(email)) {
      errors.push(`Row ${lineNum}: "${name}" has invalid email "${email}" — skipped`);
      return;
    }
    if (phone && phone.length < 10) {
      errors.push(`Row ${lineNum}: "${name}" has invalid phone "${phone}" — skipped`);
      return;
    }

    contacts.push({
      name,
      email: email || null,
      phone: phone || null,
      visitDate,
      provider,
      notes,
      rawRow: idx
    });
  });

  return {
    contacts,
    errors,
    columnMapping,
    detectedHeaders: headers,
    stats: {
      totalRows: dataRows.length,
      validContacts: contacts.length,
      skipped: errors.length
    }
  };
}

// ============================================
// DEDUPLICATION
// ============================================

/**
 * deduplicateContacts()
 * Filter out contacts already sent to recently
 * and duplicates within the import itself
 *
 * @param {Array} contacts - Parsed contacts from CSV
 * @param {string} locationId - Location to check send history for
 * @param {number} dayWindow - Days to look back (default 30)
 * @returns {Object} { toSend, duplicates, recentlySent }
 */
async function deduplicateContacts(contacts, locationId, dayWindow = 30) {
  try {
    // Get recent sends for this location
    const recentResult = await query(
      `SELECT contact_email, contact_phone
       FROM review_request_sends
       WHERE location_id = $1
       AND created_at >= NOW() - INTERVAL '${dayWindow} days'
       AND status = 'sent'`,
      [locationId]
    );

    const recentEmails = new Set(
      recentResult.rows
        .map(r => r.contact_email)
        .filter(Boolean)
        .map(e => e.toLowerCase())
    );
    const recentPhones = new Set(
      recentResult.rows
        .map(r => r.contact_phone)
        .filter(Boolean)
        .map(p => cleanPhone(p))
    );

    const toSend = [];
    const recentlySent = [];
    const duplicatesInFile = [];
    const seenInThisImport = new Set();

    contacts.forEach(contact => {
      const emailKey = contact.email?.toLowerCase();
      const phoneKey = contact.phone;
      const dedupKey = emailKey || phoneKey;

      // Duplicate within this file
      if (seenInThisImport.has(dedupKey)) {
        duplicatesInFile.push(contact);
        return;
      }
      seenInThisImport.add(dedupKey);

      // Recently sent
      const wasEmailSent = emailKey && recentEmails.has(emailKey);
      const wasPhoneSent = phoneKey && recentPhones.has(phoneKey);

      if (wasEmailSent || wasPhoneSent) {
        recentlySent.push(contact);
        return;
      }

      toSend.push(contact);
    });

    return { toSend, recentlySent, duplicatesInFile };

  } catch (error) {
    logger.error('Deduplication failed:', error.message);
    // On error, return all contacts — don't silently drop them
    return { toSend: contacts, recentlySent: [], duplicatesInFile: [] };
  }
}

// ============================================
// IMPORT STORAGE
// ============================================

/**
 * saveImport()
 * Save the import record to DB for history/auditing
 *
 * @param {Object} importData
 * @returns {string} Import ID
 */
async function saveImport(importData) {
  const {
    locationId, filename, totalRows, validContacts,
    skipped, deduped, toSendCount, templateId,
    sendDelayHours, status = 'pending'
  } = importData;

  const result = await query(
    `INSERT INTO csv_imports
     (location_id, filename, total_rows, valid_contacts,
      skipped, deduped, to_send_count, template_id,
      send_delay_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      locationId, filename, totalRows, validContacts,
      skipped, deduped, toSendCount, templateId,
      sendDelayHours, status
    ]
  );

  return result.rows[0].id;
}

/**
 * updateImportStatus()
 * Update an import's status and progress
 */
async function updateImportStatus(importId, status, sentCount = null, errorMessage = null) {
  await query(
    `UPDATE csv_imports
     SET status = $1,
         sent_count = COALESCE($2, sent_count),
         error_message = $3,
         completed_at = CASE WHEN $1 IN ('complete', 'failed') THEN NOW() ELSE completed_at END,
         updated_at = NOW()
     WHERE id = $4`,
    [status, sentCount, errorMessage, importId]
  );
}

/**
 * getImportHistory()
 * Get import history for a location
 */
async function getImportHistory(locationId, limit = 20) {
  const result = await query(
    `SELECT ci.*, t.name as template_name, t.channel as template_channel
     FROM csv_imports ci
     LEFT JOIN review_request_templates t ON ci.template_id = t.id
     WHERE ci.location_id = $1
     ORDER BY ci.created_at DESC
     LIMIT $2`,
    [locationId, limit]
  );
  return result.rows;
}

// ============================================
// SCHEDULED SENDING ENGINE
// ============================================

/**
 * processPendingImports()
 * Called by scheduler — finds imports that are
 * due to send and processes them
 * Handles the delay logic (e.g. "send 2 hours after visit")
 */
async function processPendingImports() {
  try {
    // Find imports that are scheduled and ready
    const result = await query(
      `SELECT ci.*, l.id as loc_id, l.business_name,
              l.google_review_link, l.owner_name,
              c.email as customer_email
       FROM csv_imports ci
       JOIN locations l ON ci.location_id = l.id
       JOIN customers c ON l.customer_id = c.id
       WHERE ci.status = 'scheduled'
       AND ci.scheduled_for <= NOW()`,
      []
    );

    for (const importRecord of result.rows) {
      await processImport(importRecord);
    }

  } catch (error) {
    logger.error('processPendingImports failed:', error.message);
  }
}

/**
 * processImport()
 * Send review requests for all contacts in an import
 */
async function processImport(importRecord) {
  const reviewRequestSender = require('./reviewRequestSender');

  logger.info(`Processing import ${importRecord.id} for ${importRecord.business_name}`);

  try {
    await updateImportStatus(importRecord.id, 'sending');

    // Get all pending contacts for this import
    const contactsResult = await query(
      `SELECT * FROM csv_import_contacts
       WHERE import_id = $1 AND status = 'pending'
       ORDER BY id ASC`,
      [importRecord.id]
    );

    const contacts = contactsResult.rows;
    let sentCount = 0;

    const location = {
      id: importRecord.location_id,
      business_name: importRecord.business_name,
      google_review_link: importRecord.google_review_link,
      owner_name: importRecord.owner_name
    };

    for (const contact of contacts) {
      try {
        const result = await reviewRequestSender.sendReviewRequest({
          templateId: importRecord.template_id,
          contact: {
            name: contact.name,
            email: contact.email,
            phone: contact.phone
          },
          location,
          customerId: importRecord.customer_id
        });

        await query(
          `UPDATE csv_import_contacts
           SET status = $1, sent_at = NOW(), error_message = $2
           WHERE id = $3`,
          [
            result.success ? 'sent' : 'failed',
            result.error || null,
            contact.id
          ]
        );

        if (result.success) sentCount++;

        // Rate limit — 500ms between sends
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        logger.error(`Failed to send to ${contact.name}:`, err.message);
        await query(
          "UPDATE csv_import_contacts SET status = 'failed', error_message = $1 WHERE id = $2",
          [err.message, contact.id]
        );
      }
    }

    await updateImportStatus(importRecord.id, 'complete', sentCount);
    logger.info(`Import ${importRecord.id} complete: ${sentCount}/${contacts.length} sent`);

  } catch (error) {
    logger.error(`Import ${importRecord.id} failed:`, error.message);
    await updateImportStatus(importRecord.id, 'failed', null, error.message);
  }
}

// ============================================
// HELPERS
// ============================================

function cleanPhone(raw) {
  if (!raw) return '';
  const digits = raw.toString().replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return digits.length >= 7 ? digits : '';
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseDate(raw) {
  if (!raw) return null;
  const str = raw.toString().trim();
  if (!str) return null;
  // Try common date formats
  const formats = [
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/, // MM/DD/YYYY
    /^(\d{4})-(\d{2})-(\d{2})$/,           // YYYY-MM-DD
    /^(\d{1,2})-(\d{1,2})-(\d{2,4})$/      // MM-DD-YYYY
  ];
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

module.exports = {
  parseCSV,
  detectColumns,
  deduplicateContacts,
  saveImport,
  updateImportStatus,
  getImportHistory,
  processPendingImports,
  processImport
};
