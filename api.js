/**
 * ATS IFTA Upload — server entry point
 * -----------------------------------------------------------------
 * Built directly off the proven GHL integration in your ATS Dashboard
 * project (same auth pattern, same DOT# field ID, same pipeline-by-name
 * lookup, same /medias/upload endpoint).
 *
 * ENV VARS NEEDED ON RENDER:
 *   GHL_API_TOKEN     - your Private Integration token (pit-...)  [already set]
 *   GHL_LOCATION_ID    - your GHL sub-account location ID          [already set]
 *   ADMIN_SECRET       - a password you make up, protects the
 *                         link-generation endpoint
 *   GHL_FUEL_FIELD_ID  - the ONE piece still missing: the custom field
 *                         ID for "Fuel Report" on the opportunity.
 *                         Find it the same way you'd find any custom
 *                         field ID — GET /locations/{locationId}/customFields
 *                         and look for the fuel report field's "id".
 *
 * Everything else (DOT# field, mileage field, pipeline lookup) uses
 * IDs and patterns already confirmed working in your other project.
 *
 * PIPELINE NAMING:
 *   Pipelines are matched by NAME, not a hardcoded ID — e.g. a token
 *   generated with quarter: "Q2 2026" will look up the pipeline named
 *   "Q2 2026 IFTA Filing". This matches how your ATS Dashboard project
 *   already names its IFTA pipelines, so no manual ID lookup needed.
 *
 * TOKEN STORE:
 *   In-memory (resets on restart) — same approach as your other
 *   project's uploadTokens Map. Fine to start with; move to a real
 *   database once you're sending real customer links regularly.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ------------------------------------------------------------------
// GHL API helper (same pattern as your ATS Dashboard's `ghl()` function)
// ------------------------------------------------------------------
const V2 = 'https://services.leadconnectorhq.com';
const LOC_ID = process.env.GHL_LOCATION_ID;
const API_KEY = process.env.GHL_API_TOKEN || process.env.GHL_API_KEY;
const HDRS = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
  Version: '2021-07-28',
};

async function ghl(method, url, body = null, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method,
      headers: HDRS,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (res.status === 429 && attempt < retries) {
      const wait = attempt * 1000;
      console.log(`GHL 429 rate limit — retrying in ${wait}ms (attempt ${attempt}/${retries})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const err = new Error(data.message || data.msg || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
}

// Confirmed working custom field IDs (from your ATS Dashboard project)
const CF_IDS = {
  dot_number: 'E5MJr7vstJWSi59CxAbK', // DOT# — on the Contact
  mileage_report: '4a8oST56fVNDICUImVKo', // Mileage Report — on the Opportunity
  fuel_report: process.env.GHL_FUEL_FIELD_ID || null, // TODO: fill in via Render env var
};

// ------------------------------------------------------------------
// Pipeline lookup by name (loaded once, cached) — same approach as
// your ATS Dashboard's loadPipelines()/pipelineCache.
// ------------------------------------------------------------------
let pipelineCache = {};

async function loadPipelines() {
  try {
    const d = await ghl('GET', `${V2}/opportunities/pipelines?locationId=${LOC_ID}`);
    (d.pipelines || []).forEach((p) => {
      const stages = {};
      (p.stages || []).forEach((s) => { stages[s.name] = s.id; });
      pipelineCache[p.name] = { id: p.id, stages };
    });
    console.log(`Loaded ${Object.keys(pipelineCache).length} pipelines`);
  } catch (e) {
    console.log('Pipeline load failed:', e.message);
  }
}

// Given a stored "Q2 2026" style quarter string, find the matching
// pipeline (named e.g. "Q2 2026 IFTA Filing") and its "In Progress" stage.
function getIftaPipeline(quarterLabel) {
  const pipelineName = `${quarterLabel} IFTA Filing`;
  const pipeline = pipelineCache[pipelineName];
  if (!pipeline) return null;
  const stageId =
    pipeline.stages['In Progress'] ||
    pipeline.stages['Open'] ||
    Object.values(pipeline.stages)[0];
  return { pipelineId: pipeline.id, stageId, pipelineName };
}

function normalizeDot(v) {
  return (v || '').toString().replace(/\D/g, '');
}

// ------------------------------------------------------------------
// Find a Contact by DOT# — used only by the admin link-generation
// helper below, to save you from copy-pasting contactId/opportunityId
// manually every time.
// ------------------------------------------------------------------
async function findContactByDot(dotNumber) {
  const r = await ghl(
    'GET',
    `${V2}/contacts/?locationId=${LOC_ID}&query=${encodeURIComponent(dotNumber)}&limit=5`
  );
  const contacts = r?.contacts || [];
  return contacts.find((c) => {
    const cf = c.customFields?.find((f) => f.id === CF_IDS.dot_number);
    return normalizeDot(cf?.fieldValue ?? cf?.value) === normalizeDot(dotNumber);
  }) || null;
}

async function findOpportunitiesForContact(contactId) {
  const data = await ghl('GET', `${V2}/contacts/${contactId}/opportunities`);
  return data?.opportunities || [];
}

// ------------------------------------------------------------------
// Token store (in-memory — see header comment)
// ------------------------------------------------------------------
const uploadTokens = new Map(); // token -> { dot_number, company_name, contactId, opportunityId, quarter, created }

// ------------------------------------------------------------------
// Admin: generate a customer upload link by DOT# alone.
// This looks up the contact + the matching quarter's opportunity for
// you, so you don't need to hunt down IDs by hand each time.
// ------------------------------------------------------------------
app.post('/api/admin/generate-link', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { dot_number, quarter } = req.body; // quarter e.g. "Q2 2026"
  if (!dot_number || !quarter) {
    return res.status(400).json({ error: 'dot_number and quarter (e.g. "Q2 2026") are required' });
  }

  try {
    const contact = await findContactByDot(dot_number);
    if (!contact) return res.status(404).json({ error: 'No contact found for that DOT number' });

    const opps = await findOpportunitiesForContact(contact.id);
    const target = getIftaPipeline(quarter);
    if (!target) return res.status(400).json({ error: `No pipeline found named "${quarter} IFTA Filing"` });

    const opp = opps.find((o) => o.pipelineId === target.pipelineId);
    if (!opp) return res.status(404).json({ error: `Contact has no opportunity in the "${quarter} IFTA Filing" pipeline` });

    const token = crypto.randomBytes(16).toString('hex');
    uploadTokens.set(token, {
      dot_number: normalizeDot(dot_number),
      company_name: contact.companyName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      contactId: contact.id,
      opportunityId: opp.id,
      quarter,
      created: Date.now(),
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ token, url: `${baseUrl}/upload.html?t=${token}` });
  } catch (err) {
    console.error('generate-link error:', err.message, err.data || '');
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// GET /api/upload-token/:token
// ------------------------------------------------------------------
app.get('/api/upload-token/:token', (req, res) => {
  const info = uploadTokens.get(req.params.token);
  if (!info) return res.status(404).json({ error: 'Invalid or expired link' });
  if (Date.now() - info.created > 7 * 24 * 60 * 60 * 1000) {
    uploadTokens.delete(req.params.token);
    return res.status(410).json({ error: 'This link has expired. Please request a new one.' });
  }
  res.json({
    dot_number: info.dot_number,
    company_name: info.company_name,
    quarter: info.quarter,
  });
});

// ------------------------------------------------------------------
// Uploads a file buffer to GHL's media library (confirmed endpoint:
// /medias/upload, from your ATS Dashboard project).
// ------------------------------------------------------------------
async function uploadFileToGHL(file) {
  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype });
  form.append('file', blob, file.originalname);
  form.append('locationId', LOC_ID);

  const res = await fetch(`${V2}/medias/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` }, // no Content-Type — FormData sets its own boundary
    body: form,
  });
  const data = await res.json();
  const url = data?.url || data?.fileUrl || data?.mediaUrl;
  if (!url) throw new Error(`GHL media upload did not return a file URL: ${JSON.stringify(data).slice(0, 200)}`);
  return url;
}

// ------------------------------------------------------------------
// POST /api/upload-ifta
// ------------------------------------------------------------------
app.post(
  '/api/upload-ifta',
  upload.fields([{ name: 'mileage', maxCount: 1 }, { name: 'fuel', maxCount: 1 }]),
  async (req, res) => {
    const { token } = req.body;
    const submittedDot = normalizeDot(req.body.dot_number);
    const mileageFile = req.files?.mileage?.[0];
    const fuelFile = req.files?.fuel?.[0];

    if (!token) return res.status(400).json({ error: 'Missing upload token' });
    if (!submittedDot) return res.status(400).json({ error: 'DOT number is required' });
    if (!mileageFile || !fuelFile) return res.status(400).json({ error: 'Both files are required' });

    const info = uploadTokens.get(token);
    if (!info) return res.status(404).json({ error: 'Invalid or expired link. Please contact your ATS team.' });

    if (normalizeDot(info.dot_number) !== submittedDot) {
      return res.status(409).json({
        error: 'The DOT number entered does not match the account for this link. Please contact your ATS team.',
      });
    }

    try {
      const [mileageUrl, fuelUrl] = await Promise.all([
        uploadFileToGHL(mileageFile),
        uploadFileToGHL(fuelFile),
      ]);

      // Update the opportunity: file URLs + move to In Progress
      const target = getIftaPipeline(info.quarter);
      const customFields = [{ id: CF_IDS.mileage_report, field_value: mileageUrl }];
      if (CF_IDS.fuel_report) customFields.push({ id: CF_IDS.fuel_report, field_value: fuelUrl });

      await ghl('PUT', `${V2}/opportunities/${info.opportunityId}`, {
        ...(target ? { pipelineStageId: target.stageId } : {}),
        customFields,
      });

      // Audit trail note on the contact (same pattern as your ATS Dashboard project)
      await ghl('POST', `${V2}/contacts/${info.contactId}/notes`, {
        body: `IFTA ${info.quarter} docs uploaded ${new Date().toISOString()} — DOT# ${submittedDot} — mileage: ${mileageFile.originalname}, fuel: ${fuelFile.originalname} (fuel url: ${fuelUrl})`,
      });

      res.json({
        success: true,
        company_name: info.company_name,
        dot_number: info.dot_number,
        quarter: info.quarter,
      });
    } catch (err) {
      console.error('GHL update failed:', err.message, err.data || '');
      res.status(502).json({ error: 'Could not save your files right now. Please try again shortly.' });
    }
  }
);

app.listen(PORT, async () => {
  console.log(`ATS IFTA upload server listening on port ${PORT}`);
  await loadPipelines();
});
