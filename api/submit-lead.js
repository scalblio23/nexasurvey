// Backup lead capture — writes straight into a Google Sheet via a Google
// service account, independent of the Zapier webhook already wired into
// this page. This is a Vercel serverless function (free on the Hobby
// plan) so a lapsed Zapier subscription can never take this path down.
//
// Required Vercel environment variables (see README for setup steps):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY
//   GOOGLE_SHEET_ID

import { JWT } from 'google-auth-library'

// No sheet/tab name prefix — the Sheets API falls back to the first visible
// tab when one isn't specified, so renaming that tab doesn't break this.
const SHEET_RANGE = 'A:A' // append after the last row of column A

// Known lead fields, in the order they land as sheet columns. Anything else
// in the submitted payload (e.g. passthrough UTM/campaign params) is folded
// into the trailing "extra_params" column instead of being dropped.
const KNOWN_FIELDS = [
  'submitted_at',
  'name',
  'email',
  'phone',
  'address',
  'q1_question',
  'q1_answer',
  'q2_question',
  'q2_answer',
  'q3_question',
  'q3_answer',
  'survey',
  'seconds_to_complete',
  'page_url',
  'referrer',
  'user_agent',
  'submitted_at_local',
]

const HEADER_ROW = [...KNOWN_FIELDS, 'extra_params']

// The sheet starts out blank, so the first lead ever appended would otherwise
// land in row 1 with no column labels. Check row 1 of the first tab and,
// if it's empty, write the header labels before appending the lead. Best
// effort — a failure here never blocks lead capture itself.
async function ensureHeaderRow(token, sheetId) {
  try {
    const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/1:1`
    const checkRes = await fetch(checkUrl, { headers: { Authorization: `Bearer ${token}` } })
    if (!checkRes.ok) return
    const data = await checkRes.json()
    if (data.values && data.values.length) return // row 1 already has something in it

    const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1?valueInputOption=RAW`
    await fetch(headerUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [HEADER_ROW] }),
    })
  } catch (err) {
    console.error('submit-lead: header check/write failed', err)
  }
}

// Normalizes the handful of ways a pasted service-account private key
// commonly gets mangled when it goes through an env var UI:
//  - Vercel env vars can't store real newlines, so the key is usually
//    pasted with literal "\n" sequences — turn them back into real ones.
//  - Sometimes the whole value gets pasted still wrapped in the JSON
//    file's surrounding double quotes — strip a single matching pair.
//  - Trim stray leading/trailing whitespace from the paste.
function normalizePrivateKey(raw) {
  let key = raw.trim()
  if (key.length >= 2 && key[0] === '"' && key[key.length - 1] === '"') {
    key = key.slice(1, -1)
  }
  return key.replace(/\\n/g, '\n').trim()
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID } = process.env
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_SHEET_ID) {
    console.error('submit-lead: missing Google service account env vars')
    res.status(500).json({ error: 'Server not configured' })
    return
  }

  const lead = req.body || {}

  try {
    const client = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: normalizePrivateKey(GOOGLE_PRIVATE_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
    const { token } = await client.getAccessToken()

    await ensureHeaderRow(token, GOOGLE_SHEET_ID)

    const extra = {}
    for (const key of Object.keys(lead)) {
      if (!KNOWN_FIELDS.includes(key)) extra[key] = lead[key]
    }

    const row = [
      ...KNOWN_FIELDS.map((key) => lead[key] ?? ''),
      Object.keys(extra).length ? JSON.stringify(extra) : '',
    ]

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(
      SHEET_RANGE
    )}:append?valueInputOption=USER_ENTERED`

    const sheetsRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    })

    if (!sheetsRes.ok) {
      const text = await sheetsRes.text()
      console.error('submit-lead: Sheets API error', sheetsRes.status, text)
      res.status(502).json({ error: 'Sheets append failed' })
      return
    }

    res.status(200).json({ ok: true })
  } catch (err) {
    console.error('submit-lead: unexpected error', err)
    res.status(500).json({ error: 'Unexpected error' })
  }
}
