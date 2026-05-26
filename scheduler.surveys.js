// ============================================
// Add to scheduler.updated.js
// Fires queued survey sends at the right time
// ============================================

// ADD THIS IMPORT at top of scheduler.js:
// const surveyService = require('./services/surveyService');

// JOB 12: Process queued survey sends — every 15 minutes
// Picks up any survey_sends with status='pending'
// where enough time has passed since the visit date
cron.schedule('*/15 * * * *', async () => {
  try {
    // Find pending sends where the delay has elapsed
    const result = await require('./database/db').query(
      `SELECT ss.*, sc.send_delay_hours,
              sc.send_channel, sc.id as config_id,
              l.id as location_id, l.business_name,
              l.google_review_link
       FROM survey_sends ss
       JOIN survey_configs sc ON ss.config_id = sc.id
       JOIN locations l ON ss.location_id = l.id
       WHERE ss.status = 'pending'
         AND ss.sent_at IS NULL
         AND (
           ss.visit_date IS NULL
           OR ss.visit_date + (sc.send_delay_hours || ' hours')::interval <= NOW()
         )
       LIMIT 50`,
      []
    );

    for (const send of result.rows) {
      try {
        // Build the contact from the pending send record
        const contact = {
          name:      send.contact_name,
          email:     send.contact_email,
          phone:     send.contact_phone,
          visitDate: send.visit_date
        };

        const config = await surveyService.getConfig(send.location_id);
        const surveyUrl = `${process.env.FRONTEND_URL}/survey/${send.survey_token}`;

        if (send.channel === 'email' && contact.email) {
          await surveyService.sendSurveyEmail({ config, contact, surveyUrl });
        } else if (send.channel === 'sms' && contact.phone) {
          await surveyService.sendSurveySMS({ config, contact, surveyUrl });
        }

        await require('./database/db').query(
          "UPDATE survey_sends SET status = 'sent', sent_at = NOW() WHERE id = $1",
          [send.id]
        );

      } catch (err) {
        logger.error(`Scheduled survey send failed for ${send.id}:`, err.message);
        await require('./database/db').query(
          "UPDATE survey_sends SET status = 'failed', error_message = $1 WHERE id = $2",
          [err.message, send.id]
        );
      }
    }

    if (result.rows.length > 0) {
      logger.info(`Surveys: processed ${result.rows.length} queued send(s)`);
    }

  } catch (error) {
    logger.error('Scheduler: Survey queue processing failed:', error.message);
  }
});
