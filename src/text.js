'use strict';

const api = window.loupe;
const $ = (s) => document.querySelector(s);

$('#close').addEventListener('click', () => window.close());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') copy();
});

async function copy() {
  await api.invoke('text:copy', $('#text').value);
  $('#state').textContent = 'Copied to the clipboard.';
  $('#state').className = 'state ok';
}
$('#copy').addEventListener('click', copy);

async function init() {
  const res = await api.invoke('text:config');
  $('#loading').hidden = true;
  const area = $('#text');
  area.hidden = false;
  if (res.error) {
    $('#state').textContent = `Couldn't read text: ${res.error}`;
    $('#state').className = 'state bad';
    return;
  }
  if (!res.text) {
    $('#state').textContent = 'No text found in that area.';
    $('#state').className = 'state bad';
    area.placeholder = 'Try selecting a larger area, or text with more contrast.';
    return;
  }
  area.value = res.text;
  $('#copy').disabled = false;
  const lines = res.text.split('\n').length;
  $('#state').textContent = `Copied to the clipboard · ${lines} line${lines === 1 ? '' : 's'}. You can correct the text and copy again.`;
  $('#state').className = 'state ok';
  area.focus();
  area.setSelectionRange(0, 0);
  area.scrollTop = 0;
}

init();
