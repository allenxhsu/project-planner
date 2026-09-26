// Line icons for the things the app is made of, drawn in the text colour (or
// a colour given): a workspace is a stack of layers, a project a cube, a
// folder a folder — the same marks wherever those things are listed.

const PATHS = {
  workspace: '<path d="M8 2.2 14 5.2 8 8.2 2 5.2Z"/><path d="M2 8.1l6 3 6-3"/><path d="M2 11l6 3 6-3"/>',
  project: '<path d="M8 1.8 13.8 5v6L8 14.2 2.2 11V5Z"/><path d="M2.2 5 8 8.2 13.8 5M8 8.2v6"/>',
  folder: '<path d="M1.8 4.3c0-.6.4-1 1-1h3.4l1.4 1.5h5.6c.6 0 1 .4 1 1v6.7c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z"/>',
};

/** An icon as an element: `icon('project', 'hsl(320 65% 60%)')`. */
export function icon(name, colour = null) {
  const span = document.createElement('span');
  span.className = `ic ic-${name}`;
  if (colour) span.style.color = colour;
  span.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
  return span;
}

/** A project's own colour for its icon, or null for the text colour. */
export const projectColour = (hue) => (Number.isFinite(hue) ? `hsl(${hue} 65% 60%)` : null);
