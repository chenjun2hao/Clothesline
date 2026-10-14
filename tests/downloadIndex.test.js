'use strict';

/**
 * 核心逻辑单测（对应 macOS 版的 DownloadIndexTests.swift）。
 * 只使用自建的临时目录/文件，不触碰用户真实下载目录。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isCandidateName, scan, read, DownloadCompletionGate, makeFile } =
  require('../src/main/downloadIndex');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clothesline-test-'));
}

test('isCandidateName：过滤隐藏文件、Office 临时文件与下载临时后缀', () => {
  assert.equal(isCandidateName('report.pdf'), true);
  assert.equal(isCandidateName('archive.zip'), true);
  assert.equal(isCandidateName('.hidden'), false);
  assert.equal(isCandidateName('~$draft.docx'), false);
  assert.equal(isCandidateName('movie.crdownload'), false);
  assert.equal(isCandidateName('movie.download'), false);
  assert.equal(isCandidateName('movie.part'), false);
  assert.equal(isCandidateName('movie.tmp'), false);
  assert.equal(isCandidateName('.DS_Store'), false);
  assert.equal(isCandidateName(''), false);
});

test('scan：排除临时兄弟文件指向的目标文件，并按最近排序', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'paper.pdf'), 'x');
    fs.writeFileSync(path.join(dir, 'paper.pdf.crdownload'), 'y');
    fs.writeFileSync(path.join(dir, '.hidden'), 'z');
    fs.writeFileSync(path.join(dir, 'other.zip'), 'w');
    fs.mkdirSync(path.join(dir, 'folder'));

    const files = await scan(dir);
    const names = files.map((f) => f.name).sort();
    assert.deepEqual(names, ['folder', 'other.zip']);
    assert.equal(files.some((f) => f.name === 'paper.pdf'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scan：目录被识别为目录，且带 directory 指纹', async () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'a-folder'));
    const files = await scan(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].isDirectory, true);
    assert.match(files[0].fingerprint, /\|directory\|/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read：符号链接与隐藏文件返回 null', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'hello');
    fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'));
    fs.writeFileSync(path.join(dir, '.secret'), 'x');
    assert.equal(await read(path.join(dir, 'link.txt')), null);
    assert.equal(await read(path.join(dir, '.secret')), null);
    assert.ok(await read(path.join(dir, 'real.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('完成度门控：需要两次稳定样本 + 静默期', () => {
  const gate = new DownloadCompletionGate({ requiredSamples: 2, quietPeriod: 2 });
  const t0 = 1_000_000;
  const file = makeFile('/tmp/example.zip', 100, t0, t0, false);

  // 第一次扫描：样本不足，不显示。
  assert.equal(gate.completed([file], t0).length, 0);
  // 第二次扫描：样本一致，但距写入不足 2 秒，仍不显示。
  assert.equal(gate.completed([file], t0 + 1000).length, 0);
  // 时间超过静默期：显示。
  assert.equal(gate.completed([file], t0 + 3000).length, 1);
});

test('完成度门控：文件大小变化会重置稳定计数', () => {
  const gate = new DownloadCompletionGate({ requiredSamples: 2, quietPeriod: 1 });
  const t0 = 2_000_000;
  const a = makeFile('/tmp/x.bin', 10, t0 - 9000, t0 - 9000, false);
  const b = makeFile('/tmp/x.bin', 20, t0 - 8000, t0 - 9000, false);
  assert.equal(gate.completed([a], t0).length, 0);
  assert.equal(gate.completed([b], t0 + 1000).length, 0); // 变了 → 计数重新开始
  assert.equal(gate.completed([b], t0 + 2000).length, 1); // 第二次一致且已过静默期
});

test('fingerprint：大小或修改时间变化会产生新指纹（可重新显示被取下的文件）', () => {
  const a = makeFile('/tmp/f', 1, 100, 50, false);
  const b = makeFile('/tmp/f', 1, 200, 50, false);
  const c = makeFile('/tmp/f', 2, 100, 50, false);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.equal(a.fingerprint, makeFile('/tmp/f', 1, 100, 50, false).fingerprint);
});