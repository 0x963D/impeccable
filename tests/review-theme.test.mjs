import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { engineEnv, findEngineBinary, ENGINE_MISSING_MESSAGE } from './lib/engine-bin.mjs';

const engine = findEngineBinary();
let browser;
before(async () => {
  assert.ok(engine, ENGINE_MISSING_MESSAGE);
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

function run(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, args, {
      cwd, env: engineEnv(engine, { IMPECCABLE_QUESTION_FORCE: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(out) : reject(new Error(`${args[0]} exited ${code}: ${out} ${err}`)));
  });
}

async function screenshot(page, name) {
  const dir = process.env.IMPECCABLE_REVIEW_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true, animations: 'disabled' });
}

// Exclude rounded borders and overlaid chrome from the inspected image's pixels.
async function pixels(page, art) {
  const box = await art.boundingBox();
  return page.screenshot({ clip: { x: box.x + 12, y: box.y + 12, width: box.width - 24, height: box.height - 52 }, animations: 'disabled' });
}

async function samePixels(page, before, after) {
  const equal = await page.evaluate(async ([a, b]) => {
    const decode = async value => {
      const img = new Image();
      img.src = `data:image/png;base64,${value}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return { width: img.width, height: img.height, pixels: ctx.getImageData(0, 0, img.width, img.height).data };
    };
    const [x, y] = await Promise.all([decode(a), decode(b)]);
    // Chromium can dither the same CSS gradient one sRGB level differently after recompositing.
    return x.width === y.width && x.height === y.height && x.pixels.every((v, i) => Math.abs(v - y.pixels[i]) <= 1);
  }, [before.toString('base64'), after.toString('base64')]);
  assert.ok(equal, 'artwork and its background must stay identical within one sRGB rounding level');
}

async function image(cwd) {
  const page = await browser.newPage();
  try {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 400;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#b95437'; ctx.fillRect(80, 80, 180, 240);
      ctx.fillStyle = '#2c8176'; ctx.fillRect(300, 80, 260, 100);
      ctx.fillStyle = '#e4bc54'; ctx.fillRect(300, 220, 260, 100);
      return canvas.toDataURL().split(',')[1];
    });
    writeFileSync(path.join(cwd, 'sample.png'), Buffer.from(png, 'base64'));
  } finally { await page.close(); }
}

async function appearance(page, selector) {
  return page.locator(selector).evaluate(el => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, color: style.color, scheme: style.colorScheme };
  });
}

async function readableText(page, selector, backgroundSelector) {
  const ratio = await page.locator(selector).evaluate((el, bgSelector) => {
    const ctx = document.createElement('canvas').getContext('2d');
    const luminance = color => {
      ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const root = el.getRootNode();
    const fg = luminance(getComputedStyle(el).color);
    const bg = luminance(getComputedStyle(root.querySelector(bgSelector)).backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  }, backgroundSelector);
  assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)} must reach 4.5:1`);
}

async function waitForExit(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(20);
  }
  throw new Error(`Review server ${pid} did not stop`);
}

test('picker follows live OS changes while comp pixels and their background stay fixed', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'review-theme-picker-'));
  const key = 'theme';
  let serverPid;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    await image(cwd);
    writeFileSync(path.join(cwd, 'question.json'), JSON.stringify({
      title: 'Choose a direction', question: 'Compare the artwork on its own background.',
      options: [{ id: 'sample', kind: 'assigned', label: 'Review sample', hero: path.join(cwd, 'sample.png') }],
      steer: true, reroll: true, buildPath: { value: 'code', toggle: true },
    }));
    const started = await run(cwd, 'serve-question', '--start', '--payload', 'question.json', '--no-open', '--key', key);
    const url = started.match(/QUESTION URL: (\S+)/)?.[1];
    assert.ok(url, started);
    serverPid = JSON.parse(readFileSync(path.join(cwd, '.impeccable', 'questions', `${key}.state.json`))).pid;
    await page.goto(url);
    const art = page.locator('.media > img').first();
    await art.evaluate(img => img.decode());
    const light = await appearance(page, 'body');
    const lightArt = await pixels(page, art);
    await screenshot(page, 'picker-light-desktop');
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await appearance(page, 'body');
    await screenshot(page, 'picker-dark-desktop');
    assert.notEqual(dark.background, light.background);
    assert.equal(dark.scheme, 'dark');
    await readableText(page, '.question', 'body');
    await readableText(page, '.face.front h2', '.face.front');
    await samePixels(page, lightArt, await pixels(page, art));
    await art.click();
    await page.locator('#lightbox.open').waitFor();
    const darkLightbox = await appearance(page, '#lightbox');
    const lightboxArt = await pixels(page, page.locator('#lightbox img'));
    await screenshot(page, 'picker-dark-lightbox');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.notEqual((await appearance(page, '#lightbox')).background, darkLightbox.background);
    await samePixels(page, lightboxArt, await pixels(page, page.locator('#lightbox img')));
    await page.keyboard.press('Escape');
    await page.locator('#lightbox[hidden]').waitFor({ state: 'attached' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('.bp-opt[data-bp="comp"]').click();
    await page.getByRole('dialog').waitFor();
    assert.equal((await appearance(page, '.bp-confirm-panel')).scheme, 'dark');
    await screenshot(page, 'picker-dark-confirm');
    await page.keyboard.press('Escape');
    await page.locator('#steer').focus();
    assert.notEqual(await page.locator('#steer').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, 'picker-dark-mobile');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('.choose').first().click();
    await page.locator('.done').waitFor();
    assert.equal((await appearance(page, 'body')).scheme, 'dark');
  } finally {
    await page.close();
    await run(cwd, 'serve-question', '--stop', '--key', key);
    if (serverPid) await waitForExit(serverPid);
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function componentServer(cwd, manifest) {
  const store = path.join(cwd, 'store');
  const project = path.join(cwd, 'project');
  mkdirSync(project);
  await image(project);
  const spec = JSON.stringify({ comp: 'sample.png', compSize: { width: 640, height: 400 }, regions: manifest.components.map(c => ({ id: c.id, kind: c.kind, box: c.box, plate: 'sample.png', note: c.note })) });
  mkdirSync(path.join(project, '.impeccable', 'build'), { recursive: true });
  writeFileSync(path.join(project, '.impeccable', 'build', 'spec.json'), spec);
  if (manifest.schemaVersion === 3) manifest.specSha256 = createHash('sha256').update(spec).digest('hex');
  writeFileSync(path.join(project, 'preview.html'), '<!doctype html><style>:root{color-scheme:light}body{margin:0;background:#eee;color:#222}</style><p>Preview</p>');
  writeFileSync(path.join(project, 'review.json'), JSON.stringify(manifest));
  const prepared = JSON.parse(await run(project, 'component-review', 'prepare', '--manifest', 'review.json', '--store', store));
  const child = spawn(engine, ['component-review', 'serve', '--session', prepared.session, '--store', store, '--port', '0', '--idle-timeout', '60'], {
    cwd: project, env: engineEnv(engine, { IMPECCABLE_QUESTION_FORCE: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Review server did not start: ${output}`)); }, 15000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/COMPONENT REVIEW: (\{[^\n]+\})/);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1]).url); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Review server exited ${code}: ${output}`)); });
  });
  return { url, child };
}

for (const kind of ['component', 'plan', 'page']) {
  const plan = kind === 'plan';
  test(`${kind} review follows OS chrome and preserves preview pixels`, async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'review-theme-components-'));
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
    let child;
    try {
      const manifest = {
        schemaVersion: plan ? 3 : 1, id: 'theme-review', stage: kind === 'page' ? 'hero' : 'components', title: 'Theme review',
        comp: { path: 'sample.png', width: 640, height: 400, background: '#e8d8b8' },
        components: [{ id: 'art', name: 'Review sample', kind: 'image', role: 'asset', medium: 'Raster', note: 'Transparent sample',
          box: { x: 0, y: 0, w: 1, h: 1 }, preview: { kind: 'image', path: 'sample.png' }, dependencies: [],
          material: { format: 'png', width: 640, height: 400, alpha: 'transparent' } }],
      };
      if (kind === 'page') manifest.components[0].preview = { kind: 'page', path: 'preview.html' };
      if (plan) manifest.codeRegions = [];
      const server = await componentServer(cwd, manifest);
      child = server.child;
      await page.goto(server.url);
      const prefix = kind;
      if (plan) await page.getByRole('button', { name: /Start/ }).click();
      const shell = plan ? '.rv' : '.review';
      const art = page.locator(plan ? '.frame > .pic.gen' : '.output.crop-stage');
      await art.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const light = await appearance(page, shell);
      const lightArt = await pixels(page, art);
      await screenshot(page, `${prefix}-light-desktop`);
      await page.emulateMedia({ colorScheme: 'dark' });
      await screenshot(page, `${prefix}-dark-desktop`);
      assert.notEqual((await appearance(page, shell)).background, light.background);
      await readableText(page, plan ? '.bar-name' : kind === 'page' ? '.review h1' : '.material strong', shell);
      await samePixels(page, lightArt, await pixels(page, art));
      if (plan) {
        await page.locator('#backdrop').click();
        const onLight = await pixels(page, art);
        await page.emulateMedia({ colorScheme: 'light' });
        await samePixels(page, onLight, await pixels(page, art));
        await page.emulateMedia({ colorScheme: 'dark' });
      } else {
        if (kind === 'component') {
          await page.getByRole('button', { name: 'Page color background' }).click();
          const onPage = await pixels(page, art);
          await page.emulateMedia({ colorScheme: 'light' });
          await samePixels(page, onPage, await pixels(page, art));
          await page.emulateMedia({ colorScheme: 'dark' });
        }
        await page.getByRole('button', { name: 'Enlarge comparison' }).click();
        await page.getByRole('dialog').waitFor();
        await screenshot(page, 'component-dark-expanded');
        await page.keyboard.press('Escape');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot(page, `${prefix}-dark-mobile`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.route('**/packet', route => route.fulfill({ status: 500, body: 'Unavailable' }));
      await page.reload();
      await page.getByRole('alert').waitFor();
      assert.equal((await appearance(page, 'body')).scheme, 'dark');
      assert.notEqual((await appearance(page, '[role="alert"] strong')).color, 'oklch(0.13 0 0)');
    } finally {
      await page.close();
      if (child && child.exitCode === null) {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
      }
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
