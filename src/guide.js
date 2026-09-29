'use strict';

const api = window.loupe;
const $ = (s) => document.querySelector(s);
let guide = null;
let saveTimer = 0;

function setStatus(text) { $('#status').textContent = text; }

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

async function save() {
  clearTimeout(saveTimer);
  if (!guide) return;
  await api.invoke('guide:update', {
    title: guide.title,
    steps: guide.steps.map((s) => ({ file: s.file, title: s.title || '', text: s.text || '' })),
  });
}

// Draw a ring where the click happened. The step number isn't drawn into the image,
// so reordering steps never leaves a wrong number behind.
async function markClick(step) {
  const bytes = await api.invoke('guide:image', step.file);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  const img = new Image();
  img.src = url;
  await img.decode();
  URL.revokeObjectURL(url);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const s = step.scale || 1;
  const { x, y } = step.click;
  ctx.beginPath();
  ctx.arc(x, y, 26 * s, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(229, 72, 77, 0.22)';
  ctx.fill();
  ctx.lineWidth = 3 * s;
  ctx.strokeStyle = '#E5484D';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 4 * s, 0, Math.PI * 2);
  ctx.fillStyle = '#E5484D';
  ctx.fill();
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await api.invoke('guide:mark', { file: step.file, png: await blob.arrayBuffer() });
}

function render() {
  const list = $('#steps');
  list.innerHTML = '';
  $('#meta').textContent = `${guide.steps.length} step${guide.steps.length === 1 ? '' : 's'}`;
  if (!guide.steps.length) {
    list.innerHTML = '<p class="empty">All steps were removed. Close this window, or start a new step capture.</p>';
    return;
  }
  guide.steps.forEach((step, i) => {
    const card = document.createElement('article');
    card.className = 'step';

    const num = document.createElement('div');
    num.className = 'num';
    num.textContent = i + 1;

    const fields = document.createElement('div');
    fields.className = 'fields';

    const title = document.createElement('input');
    title.value = step.title || '';
    title.placeholder = `Step ${i + 1}: what to do, e.g. "Click Payments"`;
    title.addEventListener('input', () => { step.title = title.value; scheduleSave(); });

    const text = document.createElement('textarea');
    text.value = step.text || '';
    text.placeholder = 'Optional details';
    text.rows = 2;
    text.addEventListener('input', () => { step.text = text.value; scheduleSave(); });

    const shot = document.createElement('div');
    shot.className = 'shot';
    shot.title = 'Open in the editor to annotate, blur or crop';
    const img = document.createElement('img');
    img.src = step.url;
    img.alt = `Screenshot for step ${i + 1}`;
    img.loading = 'lazy';
    shot.appendChild(img);
    shot.addEventListener('click', () => api.invoke('guide:edit', step.file));

    const row = document.createElement('div');
    row.className = 'row';
    const up = button('Move up', () => move(i, -1), i === 0);
    const down = button('Move down', () => move(i, 1), i === guide.steps.length - 1);
    const edit = button('Edit image', () => api.invoke('guide:edit', step.file));
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const del = button('Delete step', () => remove(i));
    del.classList.add('danger');
    row.append(up, down, edit, spacer, del);

    fields.append(title, text, shot, row);
    card.append(num, fields);
    list.appendChild(card);
  });
}

function button(label, fn, disabled) {
  const b = document.createElement('button');
  b.textContent = label;
  b.disabled = !!disabled;
  b.addEventListener('click', fn);
  return b;
}

function move(i, d) {
  const j = i + d;
  [guide.steps[i], guide.steps[j]] = [guide.steps[j], guide.steps[i]];
  render();
  save();
}

async function remove(i) {
  const [step] = guide.steps.splice(i, 1);
  await save();
  await api.invoke('guide:remove', step.file);
  render();
  setStatus('Step deleted. The screenshot was moved to the trash.');
}

async function exportAs(format) {
  await save();
  setStatus(format === 'pdf' ? 'Creating PDF…' : 'Creating web page…');
  const res = await api.invoke('guide:export', format);
  setStatus(res && res.ok ? `Exported ${res.name}.` : 'Export cancelled.');
}

$('#title').addEventListener('input', () => {
  guide.title = $('#title').value;
  document.title = guide.title || 'Guide';
  scheduleSave();
});
$('#pdf').addEventListener('click', () => exportAs('pdf'));
$('#html').addEventListener('click', () => exportAs('html'));
$('#folder').addEventListener('click', () => api.invoke('guide:reveal'));

// Screenshots may have been edited in the editor; show the latest versions.
window.addEventListener('focus', async () => {
  if (!guide) return;
  const fresh = await api.invoke('guide:config');
  if (!fresh) return;
  const urls = new Map(fresh.steps.map((s) => [s.file, s.url]));
  let changed = false;
  for (const s of guide.steps) {
    if (urls.has(s.file) && urls.get(s.file) !== s.url) { s.url = urls.get(s.file); changed = true; }
  }
  if (changed) render();
});

async function init() {
  guide = await api.invoke('guide:config');
  if (!guide) { setStatus('This guide could not be opened.'); return; }
  $('#title').value = guide.title === 'New guide' ? '' : guide.title;
  $('#title').placeholder = 'Name this guide';
  if (guide.title === 'New guide') guide.title = '';
  document.title = guide.title || 'Guide';

  const unmarked = guide.steps.filter((s) => !s.marked && s.click);
  if (unmarked.length) {
    setStatus('Marking clicks…');
    for (const step of unmarked) {
      try { await markClick(step); step.marked = true; } catch (err) { console.warn('Could not mark click', err); }
    }
    guide = await api.invoke('guide:config');
    if (guide.title === 'New guide') guide.title = '';
    setStatus('Describe each step, then export. Edits are saved automatically.');
  }
  render();
  if (!guide.title) $('#title').focus();
}

init();
