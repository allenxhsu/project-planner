// Reading a profile out of the Profiler app.
//
// Stakeholder profiles belong to Profiler, not here. What a planner needs from
// one is small: who this is, and the headline of each instrument — "INTJ",
// "High D / High C" — so the person you are assigning work to is a person you
// know something about. So this reads Profiler's own export file rather than
// its storage, and keeps only the summary.
//
// Profiler's export module names exactly what is stable: `format`,
// `formatVersion`, `subject`, and per instrument `id`, `headline`, `codes`,
// `confidence` and `caveats`. Those are the fields read here. `detail` is
// documented as unstable and is ignored. Raw item responses are never copied:
// a plan is not the place for someone's answers.

export const PROFILE_FORMAT = 'profiler.profile';

/** Where the Profiler app lives, from where this one is being served. */
export function profilerUrl() {
  const loc = globalThis.location;
  if (loc && /^https?:$/.test(loc.protocol)) {
    // Every app in the suite is served from one origin, at /<app-id>/.
    const at = loc.pathname.replace(/[^/]*$/, '');
    return at.endsWith('/project/') ? `${at.slice(0, -'project/'.length)}profiler/` : new URL('/profiler/', loc.origin).href;
  }
  return 'profiler://';
}

/**
 * Read a Profiler export into the summary a person record carries.
 *
 * @param {string} text the contents of a `.json` file Profiler wrote
 * @returns {{ subjectId: string|null, name: string|null, team: string|null,
 *   role: string|null, generatedAt: string|null,
 *   instruments: Array<{id, name, headline, tagline, codes, confidence, caveats}> }}
 * @throws if the file is not a Profiler profile
 */
export function readProfile(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('That file is not JSON.'); }
  if (!doc || typeof doc !== 'object') throw new Error('That file is not a profile.');
  if (doc.format !== PROFILE_FORMAT) {
    throw new Error(`That is not a Profiler profile — it says its format is "${doc.format ?? 'nothing'}". In Profiler, finish an instrument and use Export.`);
  }
  // A later formatVersion is read anyway: Profiler's contract is that additive
  // fields do not bump it, and unknown keys are to be ignored, not rejected.
  const list = Array.isArray(doc.instruments) ? doc.instruments : [];
  const instruments = list.filter((i) => i && i.id).map((i) => ({
    id: String(i.id),
    name: String(i.name || i.id),
    headline: String(i.headline || '').trim(),
    tagline: String(i.tagline || '').trim(),
    codes: i.codes && typeof i.codes === 'object' ? { ...i.codes } : {},
    confidence: Number.isFinite(+i.confidence) ? Math.max(0, Math.min(1, +i.confidence)) : null,
    caveats: Array.isArray(i.caveats) ? i.caveats.map(String) : [],
  }));
  if (!instruments.length) throw new Error('That profile has no instrument results in it.');
  const subject = doc.subject && typeof doc.subject === 'object' ? doc.subject : {};
  return {
    subjectId: subject.id ? String(subject.id) : null,
    name: subject.name ? String(subject.name) : null,
    team: subject.team ? String(subject.team) : null,
    role: subject.role ? String(subject.role) : null,
    generatedAt: doc.generatedAt ? String(doc.generatedAt) : null,
    instruments,
  };
}

/** One line for a card: "INTJ · High D / High C". */
export const profileLine = (profile) =>
  (profile?.instruments || []).map((i) => i.headline).filter(Boolean).join(' · ');
