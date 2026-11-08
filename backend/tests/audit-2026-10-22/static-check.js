// Heuristic source/link check; deliberately not a native WXML compiler or device rendering test.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
  const file = path.posix.join(dir, entry.name);
  return entry.isDirectory() ? walk(file) : [file];
});
const files = ['backend/src', 'miniprogram'].flatMap(walk);
const problems = [];
let scripts = 0, json = 0, templates = 0, handlers = 0, images = 0;
for (const file of files) {
  if (file.endsWith('.js')) {
    scripts++;
    const check = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8', windowsHide: true });
    if (check.status !== 0) problems.push({ file, type: 'syntax', error: check.stderr });
  }
  if (file.endsWith('.json')) {
    json++; try { JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
    catch (error) { problems.push({ file, type: 'json', error: error.message }); }
  }
  if (file.endsWith('.wxml')) {
    templates++;
    const template = fs.readFileSync(path.join(root, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const scriptPath = path.join(root, file.replace(/\.wxml$/, '.js'));
    const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
    for (const [, handler] of template.matchAll(/\b(?:bind|catch)(?::)?[\w-]+="([A-Za-z_$][\w$]*)"/g)) {
      handlers++;
      if (!new RegExp('\\b' + handler + '\\s*(?:\\(|:)').test(script)) problems.push({ file, type: 'handler', handler });
    }
    for (const [, src] of template.matchAll(/\bsrc="(\/assets\/[^"{}]+)"/g)) {
      images++; if (!fs.existsSync(path.join(root, 'miniprogram', src.slice(1)))) problems.push({ file, type: 'image', src });
    }
  }
}
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
for (const page of app.pages) for (const extension of ['js', 'json', 'wxml', 'wxss']) {
  if (!fs.existsSync(path.join(root, 'miniprogram', page + '.' + extension))) problems.push({ page, type: 'page', extension });
}
console.log(JSON.stringify({ scripts, json, templates, handlers, images, pages: app.pages.length, problems }, null, 2));
process.exitCode = problems.length ? 1 : 0;
