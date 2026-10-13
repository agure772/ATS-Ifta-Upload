/**
 * ATS IFTA Upload — server entry point
 * -----------------------------------------------------------------
 * Built directly off the proven GHL integration in your ATS Dashboard
 * project (same auth pattern, same DOT# field ID, same pipeline-by-name
 * lookup).
 *
 * ENV VARS NEEDED ON RENDER:
 *   GHL_API_TOKEN     - your Private Integration token (pit-...)  [already set]
 *   GHL_LOCATION_ID    - your GHL sub-account location ID          [already set]
 *   ADMIN_SECRET       - a password you make up, protects the admin
 *                         endpoints (link generation + field lookup)
 *   GHL_FUEL_FIELD_ID  - custom field ID for "Please Upload your Fuel
 *                         Report Here" on the opportunity. Find it with
 *                         the temporary lookup route below, then remove
 *                         that route.
 *
 * PIPELINE NAMING:
 *   Pipelines are matched by NAME, e.g. quarter "Q2 2026" looks up the
 *   pipeline named "Q2 2026 IFTA Filing".
 *
 * TOKEN STORE:
 *   In-memory (resets on restart). Fine to start with; move to a real
 *   database once you send real customer links regularly.
 *
 * NOTE ON FILE FIELDS:
 *   The Mileage/Fuel boxes on the opportunity card look like native GHL
 *   file-upload fields. Writing a media-library URL into them may not
 *   display the file. After the field IDs and dataType are confirmed,
 *   the upload step may need to switch to GHL's dedicated "upload file
 *   to custom field" endpoint. Test with one real upload first.
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
  fuel_report: process.env.GHL_FUEL_FIELD_ID || null, // set via Render env var
};

// ------------------------------------------------------------------
// Pipeline lookup by name (loaded once, cached)
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

// Given "Q2 2026", find the pipeline named "Q2 2026 IFTA Filing" and
// its "In Progress" stage.
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
// Token store (in-memory)
// ------------------------------------------------------------------
const uploadTokens = new Map(); // token -> { dot_number, company_name, contactId, opportunityId, quarter, created }

function requireAdmin(req, res) {
  const secret = process.env.ADMIN_SECRET;
  const supplied = req.headers['x-admin-secret'] || req.query.key;
  if (!secret || supplied !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ------------------------------------------------------------------
// TEMPORARY: look up custom field IDs.
// Browser-friendly. Examples:
//   /api/admin/custom-fields?key=YOUR_ADMIN_SECRET&model=opportunity&q=fuel
//   /api/admin/custom-fields?key=YOUR_ADMIN_SECRET&model=opportunity&q=mileage
// Returns only id, name, dataType, model and fieldKey (not the whole
// field definition). REMOVE THIS ROUTE once you have the IDs.
// ------------------------------------------------------------------
app.get('/api/admin/custom-fields', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const model = req.query.model ? `?model=${encodeURIComponent(req.query.model)}` : '';
    const data = await ghl('GET', `${V2}/locations/${LOC_ID}/customFields${model}`);
    const q = (req.query.q || '').toString().toLowerCase();
    const fields = (data.customFields || [])
      .filter((f) => !q || `${f.name} ${f.fieldKey}`.toLowerCase().includes(q))
      .map((f) => ({
        id: f.id,
        name: f.name,
        dataType: f.dataType,
        model: f.model,
        fieldKey: f.fieldKey,
      }));
    res.json({ count: fields.length, fields });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.data || null });
  }
});

// ------------------------------------------------------------------
// Admin: generate a customer upload link by DOT# + quarter.
// ------------------------------------------------------------------
app.post('/api/admin/generate-link', async (req, res) => {
  if (!requireAdmin(req, res)) return;
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
// Uploads a file buffer to GHL's media library (see NOTE ON FILE
// FIELDS in the header comment — this may need to change).
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

      const target = getIftaPipeline(info.quarter);
      const customFields = [{ id: CF_IDS.mileage_report, field_value: mileageUrl }];
      if (CF_IDS.fuel_report) customFields.push({ id: CF_IDS.fuel_report, field_value: fuelUrl });

      await ghl('PUT', `${V2}/opportunities/${info.opportunityId}`, {
        ...(target ? { pipelineStageId: target.stageId } : {}),
        customFields,
      });

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
