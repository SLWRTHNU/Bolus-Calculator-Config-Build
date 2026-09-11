// Google Docs API helpers for the per-day meal export Doc. Mechanical only —
// callers (drive-backend.js) build the actual text content; this file just
// knows how to find/create a Doc, wipe its body, and insert+style text via
// the Docs API's index-based batchUpdate requests.

import { getAccessToken } from './auth.js';
import { findFile } from './drive.js';

const DOCS_API = 'https://docs.googleapis.com/v1/documents';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export async function getOrCreateDoc(name, parentId) {
  const existing = await findFile(name, parentId);
  if (existing) return existing.id;

  const token = await getAccessToken();
  const createResp = await fetch(DOCS_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: name })
  });
  if (!createResp.ok) throw new Error(`Docs API error creating doc: ${createResp.status} ${await createResp.text()}`);
  const doc = await createResp.json();
  const docId = doc.documentId;

  // Docs API always creates the file in the user's Drive root, never in
  // parentId. We have to look up whatever parent it actually landed under
  // (not assumed to be 'root' — see drive.js createSheet for the same
  // issue with the Sheets API) and move it into the real target folder.
  const metaResp = await fetch(`${DRIVE_API}/files/${docId}?fields=parents`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const meta = metaResp.ok ? await metaResp.json() : {};
  const currentParents = (meta.parents || []).join(',');

  const moveUrl = new URL(`${DRIVE_API}/files/${docId}`);
  moveUrl.searchParams.set('addParents', parentId);
  if (currentParents) moveUrl.searchParams.set('removeParents', currentParents);
  moveUrl.searchParams.set('fields', 'id,parents');

  const moveResp = await fetch(moveUrl, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!moveResp.ok) {
    console.error('[drive-docs] Failed to move doc into folder:', await moveResp.text());
  }

  return docId;
}

// Wipes the doc's body content so a day can be re-exported without leaving
// stale text behind. The final newline character of a Doc's body can never
// be deleted, so the range stops one short of the body's real end index.
export async function clearDoc(docId) {
  const token = await getAccessToken();
  const getResp = await fetch(`${DOCS_API}/${docId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!getResp.ok) throw new Error(`Docs API error reading doc: ${getResp.status} ${await getResp.text()}`);
  const doc = await getResp.json();
  const content = doc.body?.content || [];
  const endIndex = content.length ? content[content.length - 1].endIndex : 1;
  if (!endIndex || endIndex <= 2) return; // already empty

  const resp = await fetch(`${DOCS_API}/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }]
    })
  });
  if (!resp.ok) throw new Error(`Docs API error clearing doc: ${resp.status} ${await resp.text()}`);
}

// meals: [{ heading, body }, ...] in display order. Builds the whole day's
// text as a single string up front, tracking the character offset of the
// day label and each meal heading, inserts it in one insertText request,
// then applies HEADING_1/HEADING_2 paragraph styles using those offsets
// (shifted by +1 since the Doc body starts at index 1, not 0).
export async function writeDayDoc(docId, dayLabel, meals) {
  let text = dayLabel + '\n';
  const headingRanges = [{ start: 0, end: dayLabel.length, style: 'HEADING_1' }];

  meals.forEach(m => {
    const headingStart = text.length;
    text += m.heading + '\n';
    headingRanges.push({ start: headingStart, end: headingStart + m.heading.length, style: 'HEADING_2' });
    if (m.body) text += m.body + '\n';
  });

  const token = await getAccessToken();

  const insertResp = await fetch(`${DOCS_API}/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text } }] })
  });
  if (!insertResp.ok) throw new Error(`Docs API error inserting text: ${insertResp.status} ${await insertResp.text()}`);

  const styleRequests = headingRanges.map(r => ({
    updateParagraphStyle: {
      range: { startIndex: r.start + 1, endIndex: r.end + 1 },
      paragraphStyle: { namedStyleType: r.style },
      fields: 'namedStyleType'
    }
  }));

  const styleResp = await fetch(`${DOCS_API}/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: styleRequests })
  });
  if (!styleResp.ok) throw new Error(`Docs API error styling headings: ${styleResp.status} ${await styleResp.text()}`);
}
