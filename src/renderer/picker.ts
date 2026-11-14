interface Source { id: string; name: string; kind: 'screen' | 'window'; thumb: string; icon: string | null }
interface Payload { audioRequested: boolean; sources: Source[] }
declare global { interface Window { picker: { load(): Promise<Payload>; choose(id: string | null, audio: boolean): void } } }

let kind: Source['kind'] = 'screen';
let selected: string | null = null;
let data: Payload = { audioRequested: false, sources: [] };
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
  render();
}).catch(() => { grid.replaceChildren(Object.assign(document.createElement('div'), { className: 'note', textContent: 'Could not list your screens.' })); });

export {};
