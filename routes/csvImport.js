// ============================================
// routes/csvImport.js
// Merge into backend/routes/index.js
// Handles file upload, preview, scheduling,
// history, and cancellation
// ============================================

const multer = require('multer');
const csvImportService = require('../services/csvImportService');

// Multer setup — store in memory, 5MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.endsWith('.csv') ||
      file.originalname.endsWith('.txt')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  }
});

// ============================================
// PARSE + PREVIEW (no data saved yet)
// ============================================

// POST /api/imports/:locationId/preview
// Upload CSV, return parsed preview — no sending yet
// Customer sees exactly what will be sent before confirming
router.post(
  '/imports/:locationId/preview',
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      // Parse CSV
      const { contacts, errors, stats, columnMapping, detectedHeaders } =
        csvImportService.parseCSV(req.file.buffer);

      // Deduplicate against send history
      const { toSend, recentlySent, duplicatesInFile } =
        await csvImportService.deduplicateContacts(
          contacts,
          req.params.locationId,
          parseInt(req.body.dayWindow) || 30
        );

      // Return preview — first 10 contacts as sample
      res.json({
        preview: true,
        filename: req.file.originalname,
        filesize: req.file.size,
        stats: {
          ...stats,
          toSend: toSend.length,
          recentlySent: recentlySent.length,
          duplicatesInFile: duplicatesInFile.length
        },
        columnMapping,
        detectedHeaders,
        errors: errors.slice(0, 20), // Cap errors shown
        sample: toSend.slice(0, 10).map(c => ({
          name: c.name,
          email: c.email,
          phone: c.phone,
          visitDate: c.visitDate,
          provider: c.provider
        })),
        // Return serialized contacts for the confirm step
        // (avoids re-parsing the file)
        contactsJson: JSON.stringify(toSend.slice(0, 500)) // Max 500 per import
      });

    } catch (err) {
      logger.error('CSV preview error:', err.message);
      res.status(400).json({ error: err.message });
    }
  }
);

// ============================================
// CONFIRM + SCHEDULE
// ============================================

// POST /api/imports/:locationId/confirm
// Save contacts and schedule sends
router.post('/imports/:locationId/confirm', async (req, res) => {
  const {
    contactsJson,  // From preview step
    templateId,
    sendDelayHours = 0,  // 0 = send now, 2 = send in 2 hours, etc.
    filename = 'import.csv',
    dayWindow = 30
  } = req.body;

  if (!contactsJson || !templateId) {
    return res.status(400).json({ error: 'contactsJson and templateId are required' });
  }

  let contacts;
  try {
    contacts = JSON.parse(contactsJson);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid contacts data' });
  }

  if (!contacts.length) {
    return res.status(400).json({ error: 'No contacts to send to' });
  }

  if (contacts.length > 500) {
    return res.status(400).json({ error: 'Maximum 500 contacts per import' });
  }

  try {
    // Verify template exists and belongs to this location
    const tResult = await query(
      'SELECT * FROM review_request_templates WHERE id = $1 AND location_id = $2',
      [templateId, req.params.locationId]
    );
    if (!tResult.rows.length) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Calculate scheduled time
    const scheduledFor = new Date(Date.now() + sendDelayHours * 60 * 60 * 1000);
    const status = sendDelayHours > 0 ? 'scheduled' : 'scheduled'; // Always scheduled, 0 = fire immediately

    // Save import record
    const importId = await csvImportService.saveImport({
      locationId: req.params.locationId,
      filename,
      totalRows: contacts.length,
      validContacts: contacts.length,
      skipped: 0,
      deduped: 0,
      toSendCount: contacts.length,
      templateId,
      sendDelayHours,
      status
    });

    // Update scheduled_for
    await query(
      'UPDATE csv_imports SET scheduled_for = $1 WHERE id = $2',
      [scheduledFor, importId]
    );

    // Save individual contacts
    for (const contact of contacts) {
      await query(
        `INSERT INTO csv_import_contacts
         (import_id, location_id, name, email, phone, visit_date, provider, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          importId,
          req.params.locationId,
          contact.name,
          contact.email || null,
          contact.phone || null,
          contact.visitDate || null,
          contact.provider || null,
          contact.notes || null
        ]
      );
    }

    // If delay is 0, process immediately (async — don't wait)
    if (sendDelayHours === 0) {
      const importRecord = await query(
        `SELECT ci.*, l.business_name, l.google_review_link, l.owner_name
         FROM csv_imports ci JOIN locations l ON ci.location_id = l.id
         WHERE ci.id = $1`,
        [importId]
      );
      // Fire and forget
      csvImportService.processImport(importRecord.rows[0])
        .catch(err => logger.error(`Immediate import ${importId} failed:`, err.message));
    }

    res.status(201).json({
      importId,
      contactCount: contacts.length,
      scheduledFor,
      status: sendDelayHours > 0 ? 'scheduled' : 'sending',
      message: sendDelayHours > 0
        ? `Scheduled to send to ${contacts.length} contacts in ${sendDelayHours} hour${sendDelayHours !== 1 ? 's' : ''}`
        : `Sending to ${contacts.length} contacts now`
    });

  } catch (err) {
    logger.error('Import confirm error:', err.message);
    res.status(500).json({ error: 'Failed to schedule import' });
  }
});

// ============================================
// HISTORY + STATUS
// ============================================

// GET /api/imports/:locationId
// Get import history for a location
router.get('/imports/:locationId', async (req, res) => {
  try {
    const history = await csvImportService.getImportHistory(
      req.params.locationId,
      parseInt(req.query.limit) || 20
    );
    res.json({ imports: history });
  } catch (err) {
    logger.error('Import history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch import history' });
  }
});

// GET /api/imports/:locationId/:importId/contacts
// Get contacts for a specific import (with send status)
router.get('/imports/:locationId/:importId/contacts', async (req, res) => {
  try {
    const result = await query(
      `SELECT name, email, phone, visit_date, status, sent_at, error_message
       FROM csv_import_contacts
       WHERE import_id = $1
       ORDER BY created_at ASC`,
      [req.params.importId]
    );
    res.json({ contacts: result.rows });
  } catch (err) {
    logger.error('Import contacts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch import contacts' });
  }
});

// DELETE /api/imports/:locationId/:importId
// Cancel a scheduled import (only if not yet sending)
router.delete('/imports/:locationId/:importId', async (req, res) => {
  try {
    const result = await query(
      `UPDATE csv_imports SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND location_id = $2 AND status IN ('pending', 'scheduled')
       RETURNING id`,
      [req.params.importId, req.params.locationId]
    );

    if (!result.rows.length) {
      return res.status(400).json({
        error: 'Import cannot be cancelled — it may already be sending or complete'
      });
    }

    res.json({ success: true, message: 'Import cancelled' });
  } catch (err) {
    logger.error('Import cancel error:', err.message);
    res.status(500).json({ error: 'Failed to cancel import' });
  }
});
