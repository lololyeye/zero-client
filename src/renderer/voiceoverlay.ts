interface Data { channel: string; users: { name: string; speaking: boolean; mute: boolean; deaf: boolean; me: boolean }[]; size: string }
declare global { interface Window { overlay: { onData(cb: (d: Data) => void): void } } }

const list = document.getElementById('list')!;
const head = document.getElementById('head')!;

window.overlay.onData((d) => {
  document.body.className = d.size === 'small' || d.size === 'large' ? d.size : '';
  head.textContent = d.channel;
  list.replaceChildren(...d.users.map((u) => {
    const li = document.createElement('li');
    li.className = (u.speaking ? 'speaking ' : '') + (u.me ? 'me' : '');
    const dot = document.createElement('span'); dot.className = 'dot';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = u.name;
    li.append(dot, name);
    if (u.deaf || u.mute) { const f = document.createElement('span'); f.className = 'flag'; f.textContent = u.deaf ? 'deafened' : 'muted'; li.append(f); }
    return li;
  }));
});
export {};
