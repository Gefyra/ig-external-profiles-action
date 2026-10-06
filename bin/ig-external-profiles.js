#!/usr/bin/env node
// ig-external-profiles: renders profiles from dependency packages (e.g. ISiKPatient) through a
// helper IG and copies the fragments the IG Publisher generates (differential, snapshot,
// must-support view, definitions) into the target IG as includes. The profiles themselves do
// not become part of the target IG's package, only their HTML rendering does.
//
// Usage:  ig-external-profiles [--ig <dir>] [--config <file>] [--publisher <jar>] [--keep]
// See README.md for the configuration file.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execSync } = require('child_process');

const DEFAULT_FRAGMENTS = ['diff', 'snapshot', 'snapshot-by-mustsupport', 'dict'];
const PREFIX = 'extern-';
const CANONICAL_TYPES = 'StructureDefinition|ValueSet|CodeSystem|NamingSystem|SearchParameter|CapabilityStatement|OperationDefinition';

const LABELS = {
  en: {
    canonical: 'Canonical', version: 'Version', status: 'Status', package: 'Package', publisher: 'Publisher',
    base: 'Base', original: 'Original', originalText: 'in the published specification',
    reading: 'How to read', readingText: 'Reading StructureDefinitions',
    overview: 'Profile', diff: 'Differential', snapshot: 'Snapshot', ms: 'Must Support', definitions: 'Definitions',
    noteTitle: 'External profile – not part of this Implementation Guide',
    noteSource: (t, v, pkg, pub) => `${t} (version ${v}) comes from the package ${pkg}${pub ? ` and is published by ${pub}` : ''}. This IG uses the profile unchanged. It is not contained in this IG's package but referenced as a dependency.`,
    noteAuthority: (link, url) => `The rendering below is for orientation only; the ${link} is authoritative. For validation and <code>meta.profile</code>, use the canonical URL ${url}.`,
    noteLink: 'published specification',
  },
  de: {
    canonical: 'Canonical', version: 'Version', status: 'Status', package: 'Paket', publisher: 'Herausgeber',
    base: 'Basis', original: 'Original', originalText: 'in der veröffentlichten Spezifikation',
    reading: 'Lesehilfe', readingText: 'Wie man StructureDefinitions liest',
    overview: 'Profil', diff: 'Differential', snapshot: 'Snapshot', ms: 'Must-Support', definitions: 'Definitionen',
    noteTitle: 'Externes Profil – nicht Teil dieses Implementation Guides',
    noteSource: (t, v, pkg, pub) => `${t} (Version ${v}) stammt aus dem Paket ${pkg}${pub ? ` und wird von ${pub} herausgegeben` : ''}. Dieser IG nutzt das Profil unverändert. Es ist nicht in seinem Package enthalten, sondern wird als Abhängigkeit eingebunden.`,
    noteAuthority: (link, url) => `Die folgende Darstellung dient der Orientierung, maßgeblich ist die ${link}. Für Validierung und <code>meta.profile</code> gilt die Canonical-URL ${url}.`,
    noteLink: 'veröffentlichte Spezifikation',
  },
};

function log(msg) { console.log(`[ig-external-profiles] ${msg}`); }
function fail(msg) { console.error(`[ig-external-profiles] ERROR: ${msg}`); process.exit(1); }

// --- Arguments -----------------------------------------------------------------
function parseArgs(argv) {
  const args = { ig: '.', config: null, publisher: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ig') args.ig = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--publisher') args.publisher = argv[++i];
    else if (a === '--keep') args.keep = true;
    else if (a === '-h' || a === '--help') {
      console.log('ig-external-profiles [--ig <dir>] [--config <file>] [--publisher <jar>] [--keep]');
      process.exit(0);
    } else fail(`Unknown argument: ${a}`);
  }
  args.ig = path.resolve(args.ig);
  args.config = path.resolve(args.ig, args.config || 'external-profiles.yaml');
  return args;
}

// --- YAML: SUSHI ships the library, so no dependencies of our own are needed -----
function loadYamlLib() {
  try { return require('yaml'); } catch (_) { /* fall through */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(root, 'fsh-sushi', 'node_modules', 'yaml'));
  } catch (_) {
    fail('Library "yaml" not found. Is SUSHI (fsh-sushi) installed globally?');
  }
}

// --- Package cache -------------------------------------------------------------
// In the CI container $HOME is /github/home while Java uses /root, so check every candidate.
function packageCacheDirs() {
  const dirs = [];
  if (process.env.FHIR_PACKAGE_CACHE) dirs.push(process.env.FHIR_PACKAGE_CACHE);
  dirs.push(path.join(os.homedir(), '.fhir', 'packages'));
  try { dirs.push(path.join(os.userInfo().homedir, '.fhir', 'packages')); } catch (_) { /* ignore */ }
  dirs.push('/root/.fhir/packages', '/github/home/.fhir/packages');
  return [...new Set(dirs)].filter((d) => fs.existsSync(d));
}

function findProfile(pkg, id) {
  for (const dir of packageCacheDirs()) {
    const pkgDir = path.join(dir, pkg, 'package');
    if (!fs.existsSync(pkgDir)) continue;
    const direct = path.join(pkgDir, `StructureDefinition-${id}.json`);
    const candidates = fs.existsSync(direct)
      ? [direct]
      : fs.readdirSync(pkgDir).filter((f) => f.endsWith('.json')).map((f) => path.join(pkgDir, f));
    for (const file of candidates) {
      try {
        const res = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (res.resourceType === 'StructureDefinition' && res.id === id) return { file, res };
      } catch (_) { /* not a resource */ }
    }
  }
  return null;
}

// --- Processes -----------------------------------------------------------------
function runSushi(dir) {
  log('Running SUSHI in the helper IG (downloads missing packages) ...');
  const r = spawnSync('sushi', ['.'], { cwd: dir, encoding: 'utf8', shell: true });
  fs.writeFileSync(path.join(dir, 'sushi.log'), (r.stdout || '') + (r.stderr || ''));
  if (r.status !== 0) fail(`SUSHI failed in the helper IG, see ${path.join(dir, 'sushi.log')}`);
}

function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
  }
}

// The publisher writes every fragment to temp/pages/_includes before it starts Jekyll.
// The helper IG needs neither Jekyll nor anything after it, so the process is stopped at
// that point. This saves minutes and sidesteps hanging Jekyll runs.
function runPublisher(dir, jar) {
  return new Promise((resolve) => {
    log('Running the IG Publisher in the helper IG ...');
    const logFile = fs.createWriteStream(path.join(dir, 'publisher.log'));
    const child = spawn('java', ['-Dfile.encoding=UTF-8', '-Xmx4g', '-jar', jar, '-ig', '.', '-no-sushi'],
      { cwd: dir, detached: process.platform !== 'win32' });
    let stopped = false;
    let buffer = '';
    const onData = (chunk) => {
      logFile.write(chunk);
      buffer = (buffer + chunk.toString()).slice(-4000);
      if (!stopped && /Generating combined package|Run jekyll:/.test(buffer)) {
        stopped = true;
        log('Fragments generated, stopping the publisher before Jekyll.');
        killTree(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      logFile.end();
      if (!stopped) fail(`IG Publisher exited before generating fragments (code ${code}), see ${path.join(dir, 'publisher.log')}`);
      resolve();
    });
  });
}

function findPublisherJar(args) {
  const candidates = [
    args.publisher,
    process.env.IG_PUBLISHER_JAR,
    path.join(args.ig, 'input-cache', 'publisher.jar'),
    path.join(args.ig, '..', 'publisher.jar'),
    '/opt/ig/publisher.jar',
  ].filter(Boolean);
  const jar = candidates.find((c) => fs.existsSync(c));
  if (!jar) fail(`publisher.jar not found (looked in: ${candidates.join(', ')})`);
  return path.resolve(jar);
}

// --- Fragments -----------------------------------------------------------------
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolverUrl(canonical, pkg) {
  const scope = pkg ? `scope=${encodeURIComponent(pkg.replace('#', '@'))}&amp;` : '';
  return `https://simplifier.net/resolve?${scope}canonical=${encodeURIComponent(canonical)}`;
}

function rewriteLinks(html, id, profilePages) {
  // In the helper IG, links into the definitions point to a separate page. In the target IG
  // the definitions sit on the same page as the tables.
  let out = html.split(`href="StructureDefinition-${id}-definitions.html#`).join('href="#');
  // Links to other externally rendered profiles go to their page
  for (const [otherId, page] of Object.entries(profilePages)) {
    out = out.split(`href="StructureDefinition-${otherId}-definitions.html#`).join(`href="${page}#`);
    out = out.split(`href="StructureDefinition-${otherId}.html`).join(`href="${page}`);
  }
  return out;
}

function remainingRelativeLinks(html) {
  const found = new Set();
  for (const m of html.matchAll(/href="(?![a-z][a-z0-9+.-]*:)([^"#][^"]*)"/gi)) found.add(m[1].split('#')[0]);
  return [...found];
}

// Markdown links to canonical URLs are not web pages (the publisher's link check fails on
// them), so they are resolved through Simplifier.
function rewriteDescription(md) {
  const re = new RegExp(`\\]\\((https?://[^)\\s]+/(?:${CANONICAL_TYPES})/[^)\\s]+)\\)`, 'g');
  return (md || '').replace(re, (_, url) => `](${resolverUrl(url).replace('&amp;', '&')})`);
}

function infoFragment(p, res, L) {
  const original = p.link ? escapeHtml(p.link) : resolverUrl(res.url, p.package);
  const rows = [
    [L.canonical, `<code>${escapeHtml(res.url)}</code>`],
    [L.version, escapeHtml(res.version)],
    [L.status, escapeHtml(res.status)],
    [L.package, `<code>${escapeHtml(p.package)}</code>`],
    [L.publisher, escapeHtml(res.publisher)],
    [L.base, `<code>${escapeHtml(res.baseDefinition)}</code>`],
    [L.original, `<a href="${original}">${escapeHtml(res.title || res.name)} ${L.originalText}</a>`],
  ].filter(([, v]) => v);
  const table = rows.map(([k, v]) => `<tr><th style="text-align:left;padding-right:1em">${k}</th><td>${v}</td></tr>`).join('\n');
  return `{% raw %}<div data-fhir="generated">\n<table class="grid">\n${table}\n</table>\n</div>{% endraw %}\n`;
}

// Notice box: the profile is external and not part of the IG package. Uses the base
// template's "stu-note" box; the extra class lets a template restyle it.
// Per profile, "disclaimer: false" switches it off and a string replaces the text.
function disclaimerFragment(p, res, L) {
  if (p.disclaimer === false) return '{% comment %}disclaimer disabled{% endcomment %}\n';
  const original = p.link ? escapeHtml(p.link) : resolverUrl(res.url, p.package);
  const title = escapeHtml(res.title || res.name || p.id);
  const body = typeof p.disclaimer === 'string'
    ? `<p>${escapeHtml(p.disclaimer)}</p>`
    : `<p>${L.noteSource(`<b>${title}</b>`, escapeHtml(res.version), `<code>${escapeHtml(p.package)}</code>`, escapeHtml(res.publisher))}</p>
<p>${L.noteAuthority(`<a href="${original}">${L.noteLink}</a>`, `<code>${escapeHtml(res.url)}</code>`)}</p>`;
  return `{% raw %}<div class="stu-note external-profile-note" data-fhir="generated">
<p><b>${L.noteTitle}</b></p>
${body}
</div>{% endraw %}\n`;
}

// Page include that assembles the fragments: notice box, description, info table, tabs,
// definitions. Usage on a page: {% include extern-<id>.html %}
// Headings are Markdown on purpose: the page templates show the page TOC as soon as the
// HTML contains <h3, but kramdown only collects Markdown headings into it. HTML headings
// would leave an empty TOC box. The description is Markdown as well, so its own headings
// appear in the TOC.
function pageInclude(id, L) {
  const f = (frag) => `{% include ${PREFIX}${id}-${frag}.xhtml %}`;
  return `{% comment %}Generated by ig-external-profiles. Do not edit.{% endcomment %}
{::nomarkdown}
${f('disclaimer')}
{:/}

${f('description')}

### ${L.overview} {#profile}

{::nomarkdown}
${f('info')}
<p>${L.reading}: <a href="https://build.fhir.org/ig/FHIR/ig-guidance/readingIgs.html#structure-definitions">${L.readingText}</a>.</p>
<div id="tabs">
  <ul>
    <li><a href="#tabs-diff">${L.diff}</a></li>
    <li><a href="#tabs-snap">${L.snapshot}</a></li>
    <li><a href="#tabs-ms">${L.ms}</a></li>
  </ul>
  <div id="tabs-diff"><div id="tbl-diff"><div id="tbl-diff-inner">
${f('diff')}
  </div></div></div>
  <div id="tabs-snap"><div id="tbl-snap"><div id="tbl-snap-inner">
${f('snapshot')}
  </div></div></div>
  <div id="tabs-ms"><div id="tbl-ms"><div id="tbl-ms-inner">
${f('snapshot-by-mustsupport')}
  </div></div></div>
</div>
{:/}

### ${L.definitions} {#definitions}

{::nomarkdown}
${f('dict')}
<script type="text/javascript">
  document.addEventListener('DOMContentLoaded', function () {
    if (window.jQuery && jQuery.fn.tabs) { jQuery('#tabs').tabs(); }
  });
</script>
{:/}
`;
}

// --- Main ----------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const YAML = loadYamlLib();

  if (!fs.existsSync(args.config)) { log(`No configuration at ${args.config}, nothing to do.`); return; }
  const config = YAML.parse(fs.readFileSync(args.config, 'utf8')) || {};
  const profiles = config.profiles || [];
  if (profiles.length === 0) { log('No profiles configured, nothing to do.'); return; }
  for (const p of profiles) {
    if (!p.id || !p.package || !/^[^#]+#[^#]+$/.test(p.package)) fail(`Profile entry needs "id" and "package" (name#version): ${JSON.stringify(p)}`);
  }
  const fragments = config.fragments || DEFAULT_FRAGMENTS;
  const outDir = path.resolve(args.ig, config.output || path.join('input', 'includes'));
  const dataDir = path.resolve(args.ig, config.data || path.join('input', 'data'));
  const profilePages = Object.fromEntries(profiles.map((p) => [p.id, p.page || `${PREFIX}${p.id}.html`]));

  const igConfig = YAML.parse(fs.readFileSync(path.join(args.ig, 'sushi-config.yaml'), 'utf8'));
  const lang = config.lang || igConfig.parameters?.['i18n-default-lang'] || 'en';
  const L = LABELS[lang] || LABELS.en;
  const jar = findPublisherJar(args);

  // Helper IG: same dependencies and language as the target IG, so the rendering (links,
  // texts) matches the target IG.
  const dependencies = { ...(igConfig.dependencies || {}) };
  for (const p of profiles) {
    const [name, version] = p.package.split('#');
    const existing = dependencies[name];
    const existingVersion = typeof existing === 'object' ? existing?.version : existing;
    if (existing && existingVersion !== version) {
      fail(`${name} is ${existingVersion} in sushi-config.yaml but ${version} in the configuration`);
    }
    if (!existing) dependencies[name] = version;
  }
  const igLang = igConfig.parameters?.['i18n-default-lang'];
  const helperConfig = {
    id: 'helper.external.profiles',
    canonical: 'http://example.org/fhir/helper-external-profiles',
    name: 'HelperExternalProfiles',
    title: 'Helper IG for external profiles',
    status: 'draft',
    version: '0.0.0',
    copyrightYear: '2026+',
    releaseLabel: 'ci-build',
    fhirVersion: igConfig.fhirVersion || '4.0.1',
    publisher: { name: 'ig-external-profiles' },
    dependencies,
    ...(igLang ? { parameters: { 'i18n-default-lang': igLang } } : {}),
  };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-external-profiles-'));
  log(`Helper IG in ${work}`);
  fs.mkdirSync(path.join(work, 'input', 'resources'), { recursive: true });
  fs.mkdirSync(path.join(work, 'input', 'pagecontent'), { recursive: true });
  fs.writeFileSync(path.join(work, 'sushi-config.yaml'), YAML.stringify(helperConfig));
  fs.writeFileSync(path.join(work, 'input', 'pagecontent', 'index.md'), 'Helper IG, not published.\n');
  fs.writeFileSync(path.join(work, 'ig.ini'),
    `[IG]\nig = fsh-generated/resources/ImplementationGuide-${helperConfig.id}.json\ntemplate = ${config.template || 'fhir.base.template#current'}\n`);

  // Take the profiles from the package cache. If a package is missing, the first SUSHI run loads it.
  let found = profiles.map((p) => findProfile(p.package, p.id));
  if (found.some((f) => !f)) {
    runSushi(work);
    found = profiles.map((p) => findProfile(p.package, p.id));
  }
  profiles.forEach((p, i) => {
    if (!found[i]) fail(`StructureDefinition "${p.id}" not found in package ${p.package}`);
    fs.copyFileSync(found[i].file, path.join(work, 'input', 'resources', `StructureDefinition-${p.id}.json`));
  });
  runSushi(work);
  await runPublisher(work, jar);

  // Copy fragments
  const includes = path.join(work, 'temp', 'pages', '_includes');
  fs.mkdirSync(outDir, { recursive: true });
  for (const old of fs.readdirSync(outDir).filter((f) => f.startsWith(PREFIX) && /\.(xhtml|html)$/.test(f))) {
    fs.unlinkSync(path.join(outDir, old));
  }
  profiles.forEach((p, i) => {
    for (const frag of fragments) {
      const src = path.join(includes, `StructureDefinition-${p.id}-${frag}.xhtml`);
      if (!fs.existsSync(src)) fail(`Fragment missing in the helper IG: ${path.basename(src)}`);
      const html = rewriteLinks(fs.readFileSync(src, 'utf8'), p.id, profilePages);
      const rest = remainingRelativeLinks(html);
      if (rest.length) log(`Warning: ${p.id}-${frag} contains relative links that may be broken in the target IG: ${rest.join(', ')}`);
      fs.writeFileSync(path.join(outDir, `${PREFIX}${p.id}-${frag}.xhtml`), html);
    }
    fs.writeFileSync(path.join(outDir, `${PREFIX}${p.id}-info.xhtml`), infoFragment(p, found[i].res, L));
    fs.writeFileSync(path.join(outDir, `${PREFIX}${p.id}-description.xhtml`),
      `{% raw %}${rewriteDescription(found[i].res.description)}{% endraw %}\n`);
    fs.writeFileSync(path.join(outDir, `${PREFIX}${p.id}-disclaimer.xhtml`), disclaimerFragment(p, found[i].res, L));
    fs.writeFileSync(path.join(outDir, `${PREFIX}${p.id}.html`), pageInclude(p.id, L));
    log(`${p.id}: include ${PREFIX}${p.id}.html and fragments written to ${path.relative(args.ig, outDir) || '.'}`);
  });

  // Data file for templates (Jekyll: site.data.external_profiles), e.g. to link the
  // artifacts page to the profile pages instead of the external resolver. The publisher
  // passes it to Jekyll if the IG parameter path-data points to its folder.
  const data = {
    profiles: profiles.map((p, i) => {
      const res = found[i].res;
      const [pkgName, pkgVersion] = p.package.split('#');
      return {
        id: p.id,
        title: res.title || res.name || p.id,
        url: res.url,
        version: res.version,
        package: p.package,
        publisher: res.publisher,
        page: profilePages[p.id],
        // Links the publisher generates for this profile when the package has no web URL
        resolverUrls: [
          `https://simplifier.net/resolve?scope=${pkgName}@${pkgVersion}&canonical=${res.url}`,
          `https://simplifier.net/resolve?scope=${pkgName}@${pkgVersion}&amp;canonical=${res.url}`,
        ],
      };
    }),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'external_profiles.json'), JSON.stringify(data, null, 2) + '\n');
  log(`Data file ${path.relative(args.ig, path.join(dataDir, 'external_profiles.json'))} written`);
  const pathData = igConfig.parameters?.['path-data'];
  const dataRel = path.relative(args.ig, dataDir).split(path.sep).join('/');
  if (![].concat(pathData || []).includes(dataRel)) {
    log(`Hint: set the IG parameter "path-data: ${dataRel}" in sushi-config.yaml so templates can read site.data.external_profiles`);
  }

  if (args.keep) log(`Helper IG kept at ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
}

main().catch((e) => fail(e.stack || String(e)));
