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
 *
 * PIPELINE NAMING:
 *   Pipelines are matched by NAME, e.g. quarter "Q2 2026" looks up the
 *   pipeline named "Q2 2026 IFTA Filing".
 *
 * UPLOAD LINKS:
 *   Links are signed tokens that carry the customer details themselves, so
 *   nothing is stored and they survive restarts. They last 30 days. Optional
 *   env var TOKEN_SECRET signs them (falls back to ADMIN_SECRET).
 *
 * MAKING A LINK (browser address bar):
 *   /api/admin/generate-link?key=ADMIN_SECRET&dot_number=1234567&quarter=Q2%202026
 *
 * FILE FIELDS:
 *   Files are uploaded to GHL media storage, then the file URL is written into
 *   the opportunity's Mileage and Fuel upload fields (confirmed working).
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

// Serve the upload page at /upload.html (and /) no matter what the file
// in the repo is named (upload.html, index.html, or the old inde.html typo).
const fs = require('fs');
function sendUploadPage(req, res) {
  for (const name of ['upload.html', 'index.html', 'inde.html']) {
    const f = path.join(__dirname, name);
    if (fs.existsSync(f)) return res.sendFile(f);
  }
  res.status(404).send('Upload page file not found in the repo. Add upload.html next to api.js.');
}
app.get(['/', '/upload.html'], sendUploadPage);

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
  // "Please Upload your Fuel Report Here" — FILE_UPLOAD on the Opportunity
  fuel_report: process.env.GHL_FUEL_FIELD_ID || 'pd6X6ONuhYl3sP5SdD0o',
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
  const data = await ghl(
    'GET',
    `${V2}/opportunities/search?location_id=${LOC_ID}&contact_id=${contactId}&limit=100`
  );
  return data?.opportunities || [];
}

// ------------------------------------------------------------------
// Token store (in-memory)
// ------------------------------------------------------------------
// Signed, self-contained tokens: the link itself carries the customer details
// (DOT#, contact, opportunity, quarter) plus a signature, so nothing is stored
// on the server and links survive Render restarts and sleep. Changing
// TOKEN_SECRET (or ADMIN_SECRET if TOKEN_SECRET is not set) invalidates all
// existing links.
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // links last 30 days
function tokenSecret() {
  return process.env.TOKEN_SECRET || process.env.ADMIN_SECRET || '';
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
// Returns the payload, or null if the token is malformed, tampered with, or expired.
function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig || !tokenSecret()) return null;
    const expected = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const info = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!info.created || Date.now() - info.created > TOKEN_TTL_MS) return null;
    return info;
  } catch {
    return null;
  }
}

// Company names in GHL often already end with "DOT# 1234567"; strip it so the
// page does not show the DOT# twice.
function cleanCompanyName(name) {
  return (name || '').replace(/\s*[-–(]?\s*DOT\s*#?\s*\d+\)?/i, '').trim();
}

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
// Admin: generate a customer upload link by DOT# + quarter.
// ------------------------------------------------------------------
app.all('/api/admin/generate-link', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { dot_number, quarter } = { ...req.query, ...(req.body || {}) }; // quarter e.g. "Q2 2026" (works from the browser address bar too)
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

    if (!tokenSecret()) return res.status(500).json({ error: 'Set ADMIN_SECRET (or TOKEN_SECRET) on Render first' });
    const token = signToken({
      dot_number: normalizeDot(dot_number),
      company_name: cleanCompanyName(contact.companyName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim()),
      contactId: contact.id,
      opportunityId: opp.id,
      quarter,
      created: Date.now(),
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ token, company_name: cleanCompanyName(contact.companyName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim()), quarter, url: `${baseUrl.replace(/^http:/, 'https:')}/upload.html?t=${token}` });
  } catch (err) {
    console.error('generate-link error:', err.message, err.data || '');
    res.status(500).json({ error: err.message });
  }
});


// ------------------------------------------------------------------
// /admin — a small page for you (not customers) to make upload links:
// type the DOT# and quarter, click, copy. The password is typed into the page
// and sent as a header; it is never stored on the server or put in the URL.
// ------------------------------------------------------------------
const ADMIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ATS Upload Link Maker</title>
<style>
  body{margin:0;background:#0d110d;color:#d8e2d8;font-family:system-ui,Segoe UI,Arial,sans-serif;padding:24px 16px}
  .card{max-width:560px;margin:0 auto;background:#151b15;border:1px solid #243024;border-radius:16px;padding:24px}
  h1{margin:0 0 4px;font-size:20px;color:#6fcf6f} p.sub{margin:0 0 20px;color:#8a998a;font-size:14px}
  label{display:block;font-size:13px;color:#9fb09f;margin:14px 0 6px}
  input,select{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid #2c3b2c;background:#0f140f;color:#e6efe6;font-size:15px}
  .row{display:flex;gap:10px} .row>div{flex:1}
  button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;background:#5cb85c;color:#07130a;font-weight:700;font-size:15px;cursor:pointer}
  button.alt{background:#243024;color:#cfe0cf;margin-top:8px}
  .out{margin-top:18px;padding:14px;border-radius:12px;background:#0f140f;border:1px solid #2c3b2c;font-size:14px;display:none;word-break:break-all}
  .err{border-color:#7a2f2f;color:#ff8a8a} .ok b{color:#6fcf6f}
</style></head><body><div class="card">
<h1>Upload Link Maker</h1><p class="sub">Make a customer's IFTA upload link — no copying tokens.</p>
<label>Admin password</label><input id="pw" type="password" autocomplete="current-password">
<label>DOT number</label><input id="dot" inputmode="numeric" placeholder="e.g. 3671576">
<div class="row">
  <div><label>Quarter</label><select id="q"><option>Q1</option><option>Q2</option><option>Q3</option><option>Q4</option></select></div>
  <div><label>Year</label><input id="yr" inputmode="numeric" maxlength="4"></div>
</div>
<button id="go">Make link</button>
<div id="out" class="out"></div>
</div>
<script>
  var $ = function(id){return document.getElementById(id)};
  var now = new Date();
  $('yr').value = now.getFullYear();
  var curQ = 'Q' + (Math.floor(now.getMonth()/3)+1);
  // IFTA is filed after the quarter ends, so default to the previous quarter
  var prev = {Q1:'Q4',Q2:'Q1',Q3:'Q2',Q4:'Q3'}[curQ];
  $('q').value = prev;
  if (curQ === 'Q1') $('yr').value = now.getFullYear()-1;
  try { $('pw').value = sessionStorage.getItem('ats_pw') || ''; } catch(e){}

  function show(html, cls){ var o=$('out'); o.className='out '+(cls||''); o.innerHTML=html; o.style.display='block'; }
  function esc(t){ return String(t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]}); }

  $('go').onclick = function(){
    var dot = $('dot').value.replace(/\\D/g,'');
    var quarter = $('q').value + ' ' + $('yr').value.trim();
    if(!dot){ show('Enter a DOT number.','err'); return; }
    try { sessionStorage.setItem('ats_pw', $('pw').value); } catch(e){}
    show('Working…');
    fetch('/api/admin/generate-link', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-admin-secret':$('pw').value},
      body: JSON.stringify({dot_number:dot, quarter:quarter})
    }).then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d}})})
    .then(function(x){
      if(!x.ok){ show(esc(x.d.error||'Something went wrong'),'err'); return; }
      var d = x.d;
      var msg = 'Hi' + (d.company_name ? ' ' + d.company_name : '') + ', please upload your ' + d.quarter +
        ' IFTA mileage and fuel reports using this secure link: ' + d.url;
      show('<div class="ok"><b>' + esc(d.company_name||'Account found') + '</b> · DOT# ' + esc(dot) + ' · ' + esc(d.quarter) +
        '</div><div style="margin:10px 0;color:#9fb09f">' + esc(d.url) + '</div>' +
        '<button id="c1">Copy link</button><button id="c2" class="alt">Copy ready-to-send message</button>');
      function copy(t,btn,label){ navigator.clipboard.writeText(t).then(function(){ btn.textContent='Copied ✓'; setTimeout(function(){btn.textContent=label},1500); }); }
      $('c1').onclick=function(){copy(d.url,this,'Copy link')};
      $('c2').onclick=function(){copy(msg,this,'Copy ready-to-send message')};
    }).catch(function(){ show('Could not reach the server. It may be waking up — try again in 30 seconds.','err'); });
  };
</script></body></html>`;
app.get('/admin', (req, res) => res.type('html').send(ADMIN_PAGE));

// ------------------------------------------------------------------
// GET /api/upload-token/:token
// ------------------------------------------------------------------
app.get('/api/upload-token/:token', (req, res) => {
  const info = verifyToken(req.params.token);
  if (!info) return res.status(404).json({ error: 'Invalid or expired link' });
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
  // GHL's documented media endpoint is /medias/upload-file; /medias/upload is
  // the older route. Try the documented one first, then fall back, and report
  // both answers if neither returns a URL.
  const attempts = [];
  for (const endpoint of ['/medias/upload-file', '/medias/upload']) {
    const form = new FormData();
    const blob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
    form.append('file', blob, file.originalname);
    form.append('name', file.originalname);
    form.append('hosted', 'false');
    form.append('altId', String(LOC_ID));
    form.append('altType', 'location');
    form.append('locationId', String(LOC_ID));

    const res = await fetch(`${V2}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, Version: '2021-07-28' }, // no Content-Type — FormData sets its own boundary
      body: form,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
    const url = data?.url || data?.fileUrl || data?.mediaUrl;
    if (url) return url;
    attempts.push(`${endpoint} -> ${res.status} ${JSON.stringify(data).slice(0, 160)}`);
  }
  throw new Error(`GHL media upload did not return a file URL. ${attempts.join(' | ')}`);
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

    const info = verifyToken(token);
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
