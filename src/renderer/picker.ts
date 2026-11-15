interface Source { id: string; name: string; kind: 'screen' | 'window'; thumb: string; icon: string | null }
interface Preset { id: string; name: string; kind: 'screen' | 'window'; source: string; audio: boolean }
interface Presets { presets: Preset[]; last: Omit<Preset, 'id' | 'name'> | null; hardwareEncode: boolean }
interface Payload { audioRequested: boolean; sources: Source[]; presets: Presets | null }
declare global {
  interface Window {
    picker: {
      load(): Promise<Payload>; choose(id: string | null, audio: boolean): void;
      savePreset(id: string, name: string, audio: boolean): Promise<Preset[] | null>; deletePreset(id: string): Promise<Preset[] | null>;
    };
  }
}

let kind: Source['kind'] = 'screen';
let selected: string | null = null;
let data: Payload = { audioRequested: false, sources: [], presets: null };
let answered = false;

const grid = document.getElementById('grid')!;
const go = document.getElementById('go') as HTMLButtonElement;
const audio = document.getElementById('audio') as HTMLInputElement;

function answer(id: string | null) {
  if (answered) return;
  answered = true;
  document.body.classList.add('closing');
  window.setTimeout(() => window.picker.choose(id, audio.checked && data.audioRequested), id ? 0 : 110);
}

function render() {
  const list = data.sources.filter((s) => s.kind === kind);
  grid.replaceChildren();
  if (!list.length) {
    const n = document.createElement('div'); n.className = 'note';
    n.textContent = kind === 'screen' ? 'No screen found.' : 'No open application window found.';
    grid.append(n);
  }
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'tile'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(s.id === selected));
    const img = document.createElement('img'); img.className = 'thumb'; img.alt = ''; if (s.thumb) img.src = s.thumb;
    const name = document.createElement('div'); name.className = 'name';
    if (s.icon) { const ic = document.createElement('img'); ic.src = s.icon; ic.alt = ''; name.append(ic); }
    const label = document.createElement('span'); label.textContent = s.name; label.title = s.name; // window titles are untrusted text
    name.append(label);
    b.append(img, name);
    b.addEventListener('click', () => { selected = s.id; render(); go.focus(); });
    b.addEventListener('dblclick', () => { selected = s.id; answer(s.id); });
    grid.append(b);
  }
  go.disabled = !selected || !data.sources.some((s) => s.id === selected);
}

document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((t) => t.addEventListener('click', () => {
  kind = t.dataset.kind as Source['kind'];
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
  render();
}));
go.addEventListener('click', () => { if (selected) answer(selected); });

// ---- StreamPresets (shown only while that plugin is on)
/** The open source a saved one points to: same name, else (windows) a title that contains it, since titles change. */
function findSource(p: { kind: Source['kind']; source: string }): Source | null {
  const list = data.sources.filter((s) => s.kind === p.kind);
  const want = p.source.toLowerCase();
  return list.find((s) => s.name === p.source) ?? list.find((s) => s.name.toLowerCase() === want)
    ?? (p.kind === 'window' && want.length >= 4 ? list.find((s) => s.name.toLowerCase().includes(want) || want.includes(s.name.toLowerCase())) : undefined) ?? null;
}
function selectSource(s: Source) {
  kind = s.kind; selected = s.id;
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-selected', String((x as HTMLElement).dataset.kind === kind)));
  render();
}
function renderPresets() {
  const box = document.getElementById('presets')!;
  const p = data.presets;
  box.hidden = !p;
  if (!p) return;
  const listEl = document.getElementById('preset-list')!;
  listEl.replaceChildren();
  listEl.hidden = !p.presets.length;
  for (const preset of p.presets) {
    const src = findSource(preset);
    const chip = document.createElement('span'); chip.className = 'chip' + (src ? '' : ' missing');
    const start = document.createElement('button'); start.type = 'button';
    start.textContent = '▶ ' + preset.name;
    start.title = src ? `Share ${preset.source}${preset.audio && data.audioRequested ? ' with sound' : ''}` : `${preset.source} is not open right now`;
    start.disabled = !src;
    start.addEventListener('click', () => { if (!src) return; selectSource(src); audio.checked = preset.audio; answer(src.id); });
    const del = document.createElement('button'); del.type = 'button'; del.className = 'del'; del.textContent = '×';
    del.setAttribute('aria-label', 'Delete preset ' + preset.name);
    del.addEventListener('click', () => { void window.picker.deletePreset(preset.id).then((list) => { if (list && data.presets) { data.presets.presets = list; renderPresets(); } }); });
    chip.append(start, del);
    listEl.append(chip);
  }
  document.getElementById('caps')!.textContent = (p.hardwareEncode ? 'Your graphics card encodes the stream.' : 'The stream is encoded by the CPU (no hardware encoder available).')
    + ' Resolution and frame rate are set in Discord’s stream menu.';
}
document.getElementById('save-form')!.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('preset-name') as HTMLInputElement;
  const name = input.value.trim();
  if (!selected || !name) { input.focus(); return; }
  void window.picker.savePreset(selected, name, audio.checked).then((list) => {
    if (list && data.presets) { data.presets.presets = list; input.value = ''; renderPresets(); }
  });
});
document.getElementById('cancel')!.addEventListener('click', () => answer(null));
document.getElementById('x')!.addEventListener('click', () => answer(null));
document.getElementById('backdrop')!.addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) answer(null); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); answer(null); }
  if (e.key === 'Enter' && selected && document.activeElement?.classList.contains('tile') === false) answer(selected);
});

void window.picker.load().then((p) => {
  data = p;
  document.getElementById('audio-row')!.hidden = !p.audioRequested;
  selected = p.sources.find((s) => s.kind === 'screen')?.id ?? p.sources[0]?.id ?? null;
  // StreamPresets: start where you left off (same source, same sound choice)
  const last = p.presets?.last ? findSource(p.presets.last) : null;
  if (last && p.presets?.last) { audio.checked = p.presets.last.audio; selectSource(last); }
  renderPresets();
  render();
}).catch(() => { grid.replaceChildren(Object.assign(document.createElement('div'), { className: 'note', textContent: 'Could not list your screens.' })); });

export {};
