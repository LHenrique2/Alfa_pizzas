// Verificador estático: sintaxe do JS inline + IDs duplicados + atributos href/src quebrados
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(here, '..');
const files = ['index.html', 'admin.html'];

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

for (const file of files) {
  const html = fs.readFileSync(path.join(base, file), 'utf8');
  console.log('\n' + '='.repeat(60));
  console.log('FILE:', file);
  console.log('='.repeat(60));

  // ---- 1. Sintaxe dos blocos <script> inline ----
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  console.log(`\n[1] Blocos <script> inline: ${scripts.length}`);
  scripts.forEach((m, i) => {
    const code = m[1];
    const line = html.slice(0, m.index).split('\n').length;
    try {
      // Compila sem executar
      new Function(code);
      console.log(`   OK   bloco #${i+1} (linha ~${line}, ${code.split('\n').length} linhas)`);
    } catch (e) {
      console.log(`   ERRO bloco #${i+1} (linha ~${line}): ${e.message}`);
    }
  });

  // ---- 2. IDs duplicados ----
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  console.log(`\n[2] IDs: ${ids.length} total | duplicados: ${dupes.length ? [...new Set(dupes)].join(', ') : 'nenhum'}`);

  // ---- 3. getElementById referenciado mas inexistente ----
  const refs = new Set([...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]));
  const missing = [...refs].filter(r => !ids.includes(r));
  console.log(`\n[3] getElementById: ${refs.size} referenciados | ${missing.length} nao existem:`);
  missing.forEach(r => console.log('     -> #' + r));

  // ---- 4. querySelector com classe de dados ----
  const q = [...html.matchAll(/querySelectorAll?\(['"]\.([a-zA-Z0-9_-]+)['"]\)/g)].map(m => m[1]);
  const noClass = [...new Set(q)].filter(c => !html.includes('class="' + c) && !html.includes(c + ' '));
  console.log(`\n[4] querySelector por classe: ${[...new Set(q)].length} distintas`);

  // ---- 5. URLs http:// (mixed content) ----
  const httpUrls = [...new Set([...html.matchAll(/["'(]http:\/\/[^"')\s]+/g)].map(m => m[0].slice(1)))];
  console.log(`\n[5] URLs http:// (quebram em HTTPS): ${httpUrls.length}`);
  httpUrls.forEach(u => console.log('     -> ' + u));

  // ---- 6. Tamanho dos assets externos por host ----
  const imgSrcs = [...new Set([...html.matchAll(/src="(https?:\/\/[^"]+)"/g)].map(m => m[1]))];
  const hosts = {};
  imgSrcs.forEach(u => { const h = new URL(u).host; hosts[h] = (hosts[h] || 0) + 1; });
  console.log(`\n[6] Hosts de imagem externos: ${Object.keys(hosts).length}`);
  Object.entries(hosts).sort((a,b)=>b[1]-a[1]).forEach(([h,c]) => console.log(`     ${String(c).padStart(2)}x  ${h}`));

  // ---- 7. URLs duplicadas (imagens reusadas) ----
  const allImgs = [...html.matchAll(/img:\s*'([^']+)'/g)].map(m => m[1]);
  const reused = {};
  allImgs.forEach(u => { reused[u] = (reused[u] || 0) + 1; });
  const reusedList = Object.entries(reused).filter(([,c]) => c > 1).sort((a,b)=>b[1]-a[1]);
  console.log(`\n[7] Itens de cardapio: ${allImgs.length} | imagens reusadas por varios itens: ${reusedList.length}`);
  reusedList.slice(0,6).forEach(([u,c]) => console.log(`     ${c}x  ${u.slice(0,80)}`));

  // ---- 8. innerHTML com interpolacao de dado (risco XSS) ----
  const inner = [...html.matchAll(/innerHTML\s*=\s*`([\s\S]*?)`/g)];
  const risky = inner.filter(m => /\$\{(item|product|p)\./.test(m[1]));
  console.log(`\n[8] Blocos innerHTML com template literal: ${inner.length} | com dado interpolado: ${risky.length}`);
}
