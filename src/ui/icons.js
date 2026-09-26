// Line icons for the things the app is made of, drawn in the text colour (or
// a colour given): a workspace is a stack of layers, a project a cube, a
// folder a folder — the same marks wherever those things are listed.

const PATHS = {
  workspace: '<path d="M8 2.2 14 5.2 8 8.2 2 5.2Z"/><path d="M2 8.1l6 3 6-3"/><path d="M2 11l6 3 6-3"/>',
  project: '<path d="M8 1.8 13.8 5v6L8 14.2 2.2 11V5Z"/><path d="M2.2 5 8 8.2 13.8 5M8 8.2v6"/>',
  folder: '<path d="M1.8 4.3c0-.6.4-1 1-1h3.4l1.4 1.5h5.6c.6 0 1 .4 1 1v6.7c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z"/>',
  agenda: '<rect x="3" y="2.6" width="10" height="11.6" rx="1.6"/><path d="M6 2.6v-.8h4v.8M5.6 6.2h.01M7.6 6.2H11M5.6 8.6h.01M7.6 8.6H11M5.6 11h.01M7.6 11H11"/>',
  people: '<circle cx="6" cy="5.6" r="2.2"/><path d="M2 13.2c.4-2.2 2-3.4 4-3.4s3.6 1.2 4 3.4"/><path d="M10.6 3.6a2 2 0 0 1 0 4M12 9.9c1.2.4 1.9 1.6 2.1 3.3"/>',
  list: '<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/>',
  timeline: '<path d="M2.5 4h6M4.5 8h8M3.5 12h5"/>',
  kanban: '<rect x="2" y="2.5" width="12" height="11" rx="1.6"/><path d="M6 2.5v11M10 2.5v11"/>',
  sheet: '<rect x="2" y="2.5" width="12" height="11" rx="1.4"/><path d="M2 6h12M2 9.5h12M6 2.5v11"/>',
  priority: '<path d="M4 14V2.5M4 3h7.5l-1.6 2.6L11.5 8H4"/>',
  resources: '<rect x="2" y="3" width="12" height="10" rx="1.6"/><circle cx="6.2" cy="7" r="1.5"/><path d="M3.9 11c.4-1 1.2-1.6 2.3-1.6s1.9.6 2.3 1.6M10 6.5h2.5M10 9h2.5"/>',
  usage: '<path d="M2.5 13.5h11M4.5 13.5V9M8 13.5V5M11.5 13.5V7.5"/>',
  network: '<rect x="1.8" y="6.2" width="4" height="3.6" rx=".8"/><rect x="10.2" y="2.4" width="4" height="3.6" rx=".8"/><rect x="10.2" y="10" width="4" height="3.6" rx=".8"/><path d="M5.8 8h2.2m0-3.8v7.6M8 4.2h2.2M8 11.8h2.2"/>',
  clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2 13.8 13.8"/>',
  star: '<path d="M8 2.2l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11l-3.5 1.9.8-3.9-2.9-2.7 3.9-.5Z"/>',
};

/** A calendar page with today's date on it, as Motion's sidebar has. */
function calendarIcon() {
  const day = new Date().getDate();
  return `<rect x="1.8" y="2.8" width="12.4" height="11.4" rx="1.8"/><path d="M1.8 6.2h12.4M5 1.6v2.4M11 1.6v2.4"/><text x="8" y="12.4" text-anchor="middle" font-size="5.6" font-weight="700" fill="currentColor" stroke="none" font-family="system-ui, sans-serif">${day}</text>`;
}

/** An icon as an element: `icon('project', 'hsl(320 65% 60%)')`. */
export function icon(name, colour = null) {
  const span = document.createElement('span');
  span.className = `ic ic-${name}`;
  if (colour) span.style.color = colour;
  span.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${name === 'calendar' ? calendarIcon() : PATHS[name] || ''}</svg>`;
  return span;
}

/** A project's own colour for its icon, or null for the text colour. */
export const projectColour = (hue) => (Number.isFinite(hue) ? `hsl(${hue} 65% 60%)` : null);
