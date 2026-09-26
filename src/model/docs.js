// A project's docs and sheets, as Motion keeps them under a project's
// Navigate tab: a doc is a page of markdown, a sheet a small table (a Name
// column, and more if you add them). They live in the plan, so they travel
// and sync with it.

const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();

export const docsOf = (p) => (Array.isArray(p.docs) ? p.docs : []);
export const getDoc = (p, id) => docsOf(p).find((d) => d.id === id) || null;

/** A new doc or sheet at the end of the project's list. */
export function addDoc(p, kind = 'doc', title = '') {
  const d = kind === 'sheet'
    ? { id: uid('sheet'), kind: 'sheet', title: title || 'New Sheet', columns: [{ id: uid('col'), name: 'Name' }], rows: [1, 2, 3].map(() => ({ id: uid('row'), cells: {} })), createdAt: now(), updatedAt: now() }
    : { id: uid('doc'), kind: 'doc', title: title || 'New doc', body: '', createdAt: now(), updatedAt: now() };
  p.docs = [...docsOf(p), d];
  return d;
}
export function updateDoc(p, id, patch) {
  const d = getDoc(p, id);
  if (!d) throw new Error('That doc is gone.');
  if ('title' in patch) d.title = String(patch.title).trim() || (d.kind === 'sheet' ? 'New Sheet' : 'New doc');
  if ('body' in patch && d.kind === 'doc') d.body = String(patch.body);
  d.updatedAt = now();
  return d;
}
export function removeDoc(p, id) { p.docs = docsOf(p).filter((d) => d.id !== id); }

// ---- sheets
const sheet = (p, id) => { const d = getDoc(p, id); if (!d || d.kind !== 'sheet') throw new Error('That sheet is gone.'); d.updatedAt = now(); return d; };
export function addColumn(p, id, name = 'Column') { const d = sheet(p, id); const c = { id: uid('col'), name }; d.columns.push(c); return c; }
export function renameColumn(p, id, colId, name) { const c = sheet(p, id).columns.find((x) => x.id === colId); if (c) c.name = String(name).trim() || c.name; }
export function removeColumn(p, id, colId) {
  const d = sheet(p, id);
  if (d.columns.length <= 1) throw new Error('A sheet keeps at least one column.');
  d.columns = d.columns.filter((c) => c.id !== colId);
  for (const r of d.rows) delete r.cells[colId];
}
export function addRow(p, id) { const d = sheet(p, id); const r = { id: uid('row'), cells: {} }; d.rows.push(r); return r; }
export function removeRow(p, id, rowId) { const d = sheet(p, id); d.rows = d.rows.filter((r) => r.id !== rowId); }
export function setCell(p, id, rowId, colId, value) {
  const r = sheet(p, id).rows.find((x) => x.id === rowId);
  if (!r) return;
  if (value === '' || value === null || value === undefined) delete r.cells[colId]; else r.cells[colId] = String(value);
}

/** What the file keeps: docs and sheets that make sense, nothing else. */
export function cleanDocs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((d) => d && typeof d.id === 'string' && (d.kind === 'doc' || d.kind === 'sheet')).map((d) => (d.kind === 'doc'
    ? { id: d.id, kind: 'doc', title: String(d.title || 'New doc'), body: String(d.body || ''), createdAt: d.createdAt || null, updatedAt: d.updatedAt || null }
    : {
      id: d.id, kind: 'sheet', title: String(d.title || 'New Sheet'),
      columns: (Array.isArray(d.columns) && d.columns.length ? d.columns : [{ id: 'col_name', name: 'Name' }]).filter((c) => c && c.id).map((c) => ({ id: String(c.id), name: String(c.name || 'Column') })),
      rows: (Array.isArray(d.rows) ? d.rows : []).filter((r) => r && r.id).map((r) => ({ id: String(r.id), cells: r.cells && typeof r.cells === 'object' ? Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, String(v)])) : {} })),
      createdAt: d.createdAt || null, updatedAt: d.updatedAt || null,
    }));
}
