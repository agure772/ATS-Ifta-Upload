/**
 * IFTA upload routes — example / reference implementation
 * -----------------------------------------------------------------
 * Drop into your Express app and wire up the two TODO sections below
 * with your real token store and GHL API client. This is the piece
 * that actually decides "does this upload belong to this opportunity,"
 * not just the front-end form.
 *
 * Design:
 *  1. GET  /api/upload-token/:token
 *       Looks up the record the token was generated for (opportunityId,
 *       contactId, dot_number, company_name, quarter). This is what
 *       populates the badge on the upload page and lets the page
 *       cross-check the DOT# the customer types in real time.
 *
 *  2. POST /api/upload-ifta
 *       Re-validates token -> record server-side (never trust the
 *       client), THEN requires the submitted dot_number to match the
 *       record's dot_number before writing anything to GHL. This is
 *       the actual guarantee that files land on the right card.
 *
 *  If you want the page to also work with a single generic link (no
 *  per-customer token), see the fallback block in the POST handler —
 *  it looks the opportunity up by DOT# alone, but only proceeds on an
 *  unambiguous single match.
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------
// TODO: replace with your real lookup (DB table, Redis, GHL custom
// object, wherever you currently store "token -> opportunity" links).
// ---------------------------------------------------------------
async function getRecordByToken(token) {
  // Example shape of what this should return:
  // return {
  //   token,
  //   opportunityId: 'ghl_opp_id',
  //   contactId: 'ghl_contact_id',
  //   dot_number: '1234567',
  //   company_name: 'Acme Trucking LLC',
  //   quarter: 'Q3 2026',
  // };
  throw new Error('getRecordByToken() not implemented');
}

// TODO: replace with a GHL API search by custom field "DOT Number"
// (used only for the generic-link fallback path).
async function findOpportunityByDot(dotNumber) {
  // Should return an array of matches: [{ opportunityId, contactId, company_name, dot_number }, ...]
  // Use GHL's opportunity/contact search filtered on your DOT custom field.
  throw new Error('findOpportunityByDot() not implemented');
}

// TODO: replace with your actual GHL API calls to attach the files
// (upload to GHL media, then set custom field values / add attachments)
// and to log an audit note on the opportunity.
async function attachFilesToOpportunity({ opportunityId, mileageFile, fuelFile, dotNumber, quarter }) {
  const target = QUARTER_PIPELINES[quarter];
  if (!target) throw new Error(`Unknown quarter "${quarter}" — no pipeline mapping configured`);

  // 1. Upload mileageFile.buffer / fuelFile.buffer to GHL media library
  //    (or your own storage) to get public/API-accessible URLs.
  // 2. PATCH the opportunity's custom fields (e.g. "Mileage Report URL",
  //    "Fuel Report URL") with those URLs.
  // 3. Move (or create, if you generate a fresh opportunity per quarter)
  //    the opportunity into target.pipelineId / target.stageId so it
  //    lands in the correct quarter's pipeline, e.g.:
  //    PUT /opportunities/{opportunityId}  { pipelineId: target.pipelineId, pipelineStageId: target.stageId }
  // 4. Add a Note to the opportunity, e.g.:
  //    `IFTA ${quarter} docs uploaded ${new Date().toISOString()} — DOT# ${dotNumber} — ` +
  //    `mileage: ${mileageFile.originalname}, fuel: ${fuelFile.originalname}`
  //    This note is your audit trail of exactly what was received, for which quarter, and matched to whom.
}

function normalizeDot(v) {
  return (v || '').toString().replace(/\D/g, '');
}

// ---------------------------------------------------------------
// TODO: fill in your real GHL pipeline + stage IDs for each quarter.
// These are what an uploaded quarter gets routed into.
// ---------------------------------------------------------------
const QUARTER_PIPELINES = {
  Q1: { pipelineId: 'PIPELINE_ID_Q1', stageId: 'STAGE_ID_Q1_DOCS_RECEIVED' },
  Q2: { pipelineId: 'PIPELINE_ID_Q2', stageId: 'STAGE_ID_Q2_DOCS_RECEIVED' },
  Q3: { pipelineId: 'PIPELINE_ID_Q3', stageId: 'STAGE_ID_Q3_DOCS_RECEIVED' },
  Q4: { pipelineId: 'PIPELINE_ID_Q4', stageId: 'STAGE_ID_Q4_DOCS_RECEIVED' },
};

// ------------------------------------------------------------------
// GET /api/upload-token/:token
// ------------------------------------------------------------------
router.get('/api/upload-token/:token', async (req, res) => {
  try {
    const record = await getRecordByToken(req.params.token);
    if (!record) return res.status(404).json({ error: 'Invalid or expired link' });

    res.json({
      dot_number: record.dot_number,
      company_name: record.company_name,
      contact_name: record.contact_name,
      quarter: record.quarter,
    });
  } catch (err) {
    res.status(404).json({ error: 'Invalid or expired link' });
  }
});

// ------------------------------------------------------------------
// POST /api/upload-ifta
// ------------------------------------------------------------------
router.post(
  '/api/upload-ifta',
  upload.fields([{ name: 'mileage', maxCount: 1 }, { name: 'fuel', maxCount: 1 }]),
  async (req, res) => {
    const { token, quarter } = req.body;
    const submittedDot = normalizeDot(req.body.dot_number);
    const mileageFile = req.files?.mileage?.[0];
    const fuelFile = req.files?.fuel?.[0];

    if (!token) return res.status(400).json({ error: 'Missing upload token' });
    if (!submittedDot) return res.status(400).json({ error: 'DOT number is required' });
    if (!quarter || !QUARTER_PIPELINES[quarter]) return res.status(400).json({ error: 'A valid filing quarter (Q1–Q4) is required' });
    if (!mileageFile || !fuelFile) return res.status(400).json({ error: 'Both files are required' });

    let record;
    try {
      record = await getRecordByToken(token);
    } catch {
      record = null;
    }

    if (!record) {
      // -----------------------------------------------------------
      // Fallback for a generic (non-unique-per-customer) link: trust
      // the DOT# alone, but only if it resolves to exactly one
      // opportunity. Comment this whole block out if every link you
      // send is already unique per customer.
      // -----------------------------------------------------------
      const matches = await findOpportunityByDot(submittedDot);
      if (!matches || matches.length === 0) {
        return res.status(404).json({ error: 'No account found for that DOT number. Please contact your ATS team.' });
      }
      if (matches.length > 1) {
        return res.status(409).json({ error: 'Multiple accounts matched that DOT number. Please contact your ATS team.' });
      }
      record = matches[0];
    } else {
      // Token resolved to a specific opportunity — the DOT# they typed
      // MUST match it. This is what stops a forwarded/reused link from
      // silently updating the wrong customer's card.
      if (normalizeDot(record.dot_number) !== submittedDot) {
        return res.status(409).json({
          error: 'The DOT number entered does not match the account for this link. Please contact your ATS team.',
        });
      }
    }

    try {
      await attachFilesToOpportunity({
        opportunityId: record.opportunityId,
        mileageFile,
        fuelFile,
        dotNumber: submittedDot,
        quarter,
      });
    } catch (err) {
      console.error('GHL update failed', err);
      return res.status(502).json({ error: 'Could not save your files right now. Please try again shortly.' });
    }

    res.json({
      success: true,
      company_name: record.company_name,
      dot_number: record.dot_number,
      quarter,
    });
  }
);

module.exports = router;

