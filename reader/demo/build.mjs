import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const here = new URL('./', import.meta.url);
const script = text => text.replace(/<\/script/gi, '<\\/script');
const [html, css, extra, scorer, js, icon] = await Promise.all([
  readFile(new URL('index.html', here), 'utf8'), readFile(new URL('../public/styles.css', here), 'utf8'),
  readFile(new URL('demo.css', here), 'utf8'), readFile(new URL('../../filter.js', here), 'utf8'),
  readFile(new URL('demo.js', here), 'utf8'), readFile(new URL('../public/icons/icon-192.png', here)),
]);
const hash = text => createHash('sha256').update(script(text)).digest('base64');
const csp = `default-src 'none'; script-src 'sha256-${hash(scorer)}' 'sha256-${hash(js)}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`;
const output = html.replace('<title>', `<meta http-equiv="Content-Security-Policy" content="${csp}">\n  <title>`).replaceAll('__ICON__', `data:image/png;base64,${icon.toString('base64')}`)
  .replace('/* __READER_CSS__ */', () => css).replace('/* __DEMO_CSS__ */', () => extra)
  .replace('/* __SCORER__ */', () => script(scorer)).replace('/* __DEMO_JS__ */', () => script(js));
await mkdir(new URL('dist/', here), { recursive: true });
await writeFile(new URL('dist/paradise-demo.html', here), output);
console.log('Built self-contained reader/demo/dist/paradise-demo.html');
