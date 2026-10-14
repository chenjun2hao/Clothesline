'use strict';

/** 通用文本输入弹窗（用于“重命名”）。 */

const api = window.clothesline;
const params = new URLSearchParams(location.search);
const input = document.getElementById('value');

document.getElementById('title').textContent = params.get('title') || '';
document.getElementById('message').textContent = params.get('message') || '';
document.getElementById('ok').textContent = params.get('ok') || '确定';
input.value = params.get('value') || '';

function submit() {
  const value = input.value.trim();
  if (!value) return;
  api.submit(value);
}

document.getElementById('ok').addEventListener('click', submit);
document.getElementById('cancel').addEventListener('click', () => api.cancel());
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
  else if (e.key === 'Escape') api.cancel();
});

window.addEventListener('load', () => {
  input.focus();
  input.select();
});