'use strict';

/** “最近文件”抽屉窗口逻辑。 */

const api = window.clothesline;
const listEl = document.getElementById('list');
const qEl = document.getElementById('q');
let timer = null;

async function refresh() {
  const files = await api.list(qEl.value || '');
  listEl.textContent = '';
  if (!files.length) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = qEl.value ? '没有匹配的文件' : '暂无最近文件';
    listEl.appendChild(div);
    return;
  }
  for (const file of files) {
    const li = document.createElement('li');
    li.draggable = true;

    const img = document.createElement('img');
    li.appendChild(img);
    api.icon(file.path).then((data) => { if (data) img.src = data; });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = file.name;
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = dirnameOf(file.path);
    meta.appendChild(n);
    meta.appendChild(d);
    li.appendChild(meta);

    const btn = document.createElement('button');
    btn.textContent = '挂上';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.action('attachFiles', { paths: [file.path] });
    });
    li.appendChild(btn);

    li.addEventListener('dblclick', () => api.action('open', { path: file.path }));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      api.action('quickLook', { path: file.path });
    });
    li.addEventListener('dragstart', (event) => {
      event.preventDefault();
      api.dragStart(file.path);
    });

    listEl.appendChild(li);
  }
}

qEl.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(refresh, 120);
});

function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

refresh();