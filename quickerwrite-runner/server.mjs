#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(runnerDir, '..');
const outputRoot = path.resolve(process.env.QW_RUNNER_OUTPUT_DIR || path.join(root, '.runner-output'));
const host = process.env.QW_RUNNER_HOST || '0.0.0.0';
const port = Number(process.env.QW_RUNNER_PORT || 8080);
const sharedSecret = process.env.QW_RUNNER_SHARED_SECRET || '';
const jobs = new Map();
const sessionQueues = new Map();
fs.mkdirSync(outputRoot, { recursive: true });

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function authenticate(req, body = Buffer.alloc(0)) {
  if (!sharedSecret) return true;
  const timestamp = String(req.headers['x-quickerwrite-timestamp'] || '');
  const supplied = String(req.headers['x-quickerwrite-signature'] || '').replace(/^sha256=/, '');
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', sharedSecret).update(`${timestamp}.`).update(body).digest('hex');
  const left = Buffer.from(supplied, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Neutral slide specs may contain validated, embedded image data. Keep the
    // runner self-contained while still enforcing a firm request ceiling.
    if (size > 32 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function slug(value, fallback) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || fallback;
}

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function cssColor(value, fallback = 'currentColor') {
  const color = String(value || '').trim();
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|transparent|white|black)$/i.test(color) ? color : fallback;
}

function imageSource(value) {
  const source = String(value || '').trim();
  return /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(source) ? source : '';
}

function elementBox(element) {
  const x = clamp(element.x, 0, 100, 6);
  const y = clamp(element.y, 0, 100, 18);
  const w = clamp(element.w, 1, 100 - x, 88);
  const h = clamp(element.h, 1, 100 - y, 20);
  return `left:${x}%;top:${y}%;width:${w}%;height:${h}%`;
}

function textStyle(element, kind) {
  const defaults = { title: 44, heading: 38, subtitle: 25, quote: 34, callout: 30, text: 20, list: 20, numbered_list: 20 };
  const size = clamp(element.font_size, 12, 96, defaults[kind] || 18);
  const color = cssColor(element.color, 'currentColor');
  const align = ['left', 'center', 'right'].includes(element.align) ? element.align : 'left';
  const weight = element.bold ? 700 : (kind === 'title' || kind === 'heading' ? 300 : 450);
  const lineHeight = clamp(element.line_spacing, .85, 2.5, kind === 'title' ? 1.03 : 1.35);
  return `font-size:${size}px;color:${color};text-align:${align};font-weight:${weight};font-style:${element.italic ? 'italic' : 'normal'};line-height:${lineHeight}`;
}

function renderElement(element, index) {
  const kind = String(element?.kind || '').toLowerCase();
  const box = elementBox(element || {});
  const common = `position:absolute;${box};box-sizing:border-box;overflow:hidden`;
  const text = escapeHtml(element?.text || '');
  const anim = escapeHtml(element?.animation || (kind === 'image' ? 'image' : 'item'));
  if (kind === 'image') {
    const src = imageSource(element.src || element.image_data || element.image_url);
    const fit = element.object_fit === 'contain' ? 'contain' : 'cover';
    const position = /^[a-z\d% .-]+$/i.test(String(element.object_position || '')) ? element.object_position : 'center center';
    return src
      ? `<figure data-anim="${anim}" style="${common};margin:0;background:rgba(127,127,127,.08)"><img src="${src}" alt="" style="width:100%;height:100%;display:block;object-fit:${fit};object-position:${escapeHtml(position)}">${element.caption ? `<figcaption style="position:absolute;left:12px;bottom:10px;padding:5px 8px;background:rgba(0,0,0,.62);color:white;font:500 13px/1.25 var(--sans),sans-serif">${escapeHtml(element.caption)}</figcaption>` : ''}</figure>`
      : `<div data-anim="${anim}" style="${common};display:grid;place-items:center;border:1px dashed currentColor;opacity:.3"><span class="t-meta">IMAGE</span></div>`;
  }
  if (kind === 'divider') {
    return `<div data-anim="${anim}" style="${common};height:${clamp(element.border_width, 1, 8, 2)}px;top:calc(${clamp(element.y, 0, 100, 50)}% + 1px);background:${cssColor(element.color || element.border_color, 'var(--accent)')}"></div>`;
  }
  if (kind === 'shape') {
    const radius = element.rounded || /round/i.test(String(element.shape_type || '')) ? '14px' : '0';
    return `<div data-anim="${anim}" style="${common};display:grid;place-items:center;padding:18px;background:${cssColor(element.fill_color || element.background_color, 'rgba(127,127,127,.10)')};border:${clamp(element.border_width, 0, 8, 1)}px solid ${cssColor(element.border_color, 'transparent')};border-radius:${radius};${textStyle(element, 'text')}">${text}</div>`;
  }
  if (kind === 'table') {
    const headers = Array.isArray(element.headers) ? element.headers : [];
    const rows = Array.isArray(element.rows) ? element.rows : [];
    return `<div data-anim="${anim}" style="${common};overflow:auto"><table style="width:100%;height:100%;border-collapse:collapse;font-size:${clamp(element.font_size, 12, 30, 17)}px"><thead><tr>${headers.map(cell => `<th style="padding:10px 12px;text-align:left;border-bottom:2px solid var(--accent);font-weight:650;color:${cssColor(element.header_color, 'currentColor')};background:${cssColor(element.header_bg_color, 'transparent')}">${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td style="padding:9px 12px;border-bottom:1px solid var(--border-subtle)">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  if (kind === 'list' || kind === 'numbered_list') {
    const items = Array.isArray(element.items) ? element.items : [];
    const tag = kind === 'numbered_list' ? 'ol' : 'ul';
    return `<${tag} data-anim="${anim}" style="${common};margin:0;padding:0 0 0 ${kind === 'numbered_list' ? '1.65em' : '1.2em'};display:grid;align-content:start;gap:clamp(8px,1.4vh,18px);${textStyle(element, kind)}">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
  }
  if (kind === 'progress_bar') {
    const max = Math.max(1, Number(element.max ?? element.max_value) || 100);
    const value = clamp(element.value, 0, max, 0);
    return `<div data-anim="${anim}" style="${common};display:grid;grid-template-rows:auto 12px;gap:10px;align-content:center"><div style="display:flex;justify-content:space-between;font-size:16px"><span>${escapeHtml(element.label || element.text || '')}</span><b>${Math.round(value / max * 100)}%</b></div><div style="background:${cssColor(element.track_color, 'rgba(127,127,127,.18)')}"><i style="display:block;width:${value / max * 100}%;height:100%;background:${cssColor(element.bar_color, 'var(--accent)')}"></i></div></div>`;
  }
  const supportedText = new Set(['title', 'heading', 'subtitle', 'text', 'quote', 'callout', 'icon_text']);
  if (!supportedText.has(kind)) return '';
  const decorated = kind === 'callout'
    ? `padding:18px 22px;background:${cssColor(element.background_color || element.fill_color, 'var(--accent)')};border-left:5px solid ${cssColor(element.border_color, 'currentColor')}`
    : kind === 'quote' ? 'padding-left:24px;border-left:5px solid var(--accent)' : '';
  return `<div data-anim="${anim}" data-element-index="${index}" style="${common};${decorated};${textStyle(element, kind)}">${kind === 'quote' ? '“' : ''}${text}${kind === 'quote' ? '”' : ''}</div>`;
}

function hasMeaningfulElements(slide) {
  return Array.isArray(slide.elements) && slide.elements.some(element => element && typeof element === 'object' && element.kind);
}

function heroFontSize(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (text.length > 24) return 'min(4.5vw,8vh)';
  if (text.length > 16) return 'min(5.2vw,9.2vh)';
  if (text.length > 11) return 'min(5.8vw,10.2vh)';
  return 'min(8.2vw,14vh)';
}

function pageLabel(index, total) {
  return '';
}

function cleanSlideChrome(fragment) {
  // Remove only runner-owned decorations, never presentation body content.
  return fragment.replace(/<div class="t-meta" style="position:absolute;left:5%;bottom:3\.5%;opacity:\.48">GUIZANG · <\/div>/g, '')
    .replace(/<div class="t-cat" data-anim="item">GUIZANG PRESENTS<\/div>/g, '')
    .replace(/<span>GUIZANG · FIELD NOTE<\/span>/g, '')
    .replace(/<div class="r"><\/div>|<span><\/span>/g, '');
}

function selectSwiss(theme, title) {
  const selected = String(theme || 'auto').trim().toLowerCase();
  if (['default', 'classic', 'editorial', 'template'].includes(selected)) return false;
  if (['swiss', 'template-swiss', '瑞士'].includes(selected)) return true;
  return /swiss|瑞士|科技|发布会|智能|硬件|数据|极简|modern|tech|launch|product/i.test(selected === 'auto' ? title : selected);
}

function presetCss(theme) {
  const selected = String(theme || '').trim().toLowerCase();
  if (!selected || selected === 'auto') return '';
  const aliases = {classic:'monocle', default:'monocle', indigo:'indigo porcelain', forest:'forest ink', kraft:'kraft paper'};
  const key = aliases[selected] || selected;
  const presets = fs.readFileSync(path.join(root, 'references/themes.md'), 'utf8');
  for (const section of presets.split(/^## /m)) {
    if (!section.split('\n')[0].toLowerCase().includes(key)) continue;
    const css = section.match(/```css\s*([\s\S]*?)```/)?.[1] || '';
    return css.split('\n').filter(line => /^--[a-z-]+:\s*[#\d,a-f .]+;$/i.test(line.trim())).join('\n');
  }
  return '';
}

function renderFreeLayout(slide, index, total, swiss) {
  const id = slug(slide.id, `slide-${index + 1}`);
  const elements = slide.elements.map(renderElement).join('');
  const hasTitle = slide.elements.some(element => ['title', 'heading'].includes(String(element?.kind || '').toLowerCase()));
  const bg = slide.background && typeof slide.background === 'object' ? slide.background : {};
  const bgColor = cssColor(bg.color, index % 4 === 3 ? 'var(--ink, #101216)' : 'var(--paper, #ffffff)');
  const dark = bg.color ? /^(#(?:0[0-9a-f]|1[0-9a-f]|2[0-9a-f])|black|rgb\(\s*[0-4]?\d\s*,)/i.test(bgColor) : index % 4 === 3;
  const bgImage = imageSource(bg.src);
  const title = escapeHtml(slide.title || `第 ${index + 1} 页`);
  return `<section class="slide ${dark ? 'dark' : 'light'}" data-animate="${escapeHtml(slide.transition || 'stagger')}" data-layout="QW-FREE" data-slide-id="${id}" style="background:${bgColor};${bgImage ? `background-image:linear-gradient(${dark ? 'rgba(0,0,0,.24),rgba(0,0,0,.24)' : 'rgba(255,255,255,.10),rgba(255,255,255,.10)'}),url('${bgImage}');background-size:cover;background-position:center` : ''}"><div style="position:absolute;inset:0;overflow:hidden">${hasTitle ? '' : `<h2 data-anim="title" style="position:absolute;left:6%;top:7%;width:88%;font-size:42px;font-weight:300;line-height:1.05">${title}</h2>`}${elements}<div class="t-meta" style="position:absolute;left:5%;bottom:3.5%;opacity:.48">GUIZANG · ${pageLabel(index, total)}</div></div></section>`;
}

function renderFallback(slide, index, total, swiss) {
  const title = escapeHtml(slide.title || `第 ${index + 1} 页`);
  const points = (Array.isArray(slide.points) ? slide.points : []).slice(0, 8);
  const id = slug(slide.id, `slide-${index + 1}`);
  const role = String(slide.role || '').toLowerCase();
  const isCover = index === 0 || role === 'cover';
  const isSection = /section|divider|chapter/.test(role);
  const isClosing = /conclusion|closing|end/.test(role) || /结束|致谢|谢谢/.test(String(slide.title || ''));
  const page = pageLabel(index, total);
  if (isClosing) {
    const note = points[0] ? `<p class="lead" data-anim="item" style="max-width:58vw">${escapeHtml(points[0])}</p>` : '';
    return swiss
      ? `<section class="slide accent" data-animate="hero" data-layout="S21" data-slide-id="${id}"><div class="canvas-card"><canvas class="ascii-bg" aria-hidden="true"></canvas><div class="chrome-min"><div class="l">ONE MORE THING</div><div class="r">${page}</div></div><div style="flex:1;display:grid;align-content:center;gap:4vh"><h1 data-anim="title" style="max-width:86vw;font-family:var(--sans),var(--sans-zh);font-weight:200;font-size:${heroFontSize(slide.title)};line-height:.98;color:#fff">${title}</h1>${note}</div></div></section>`
      : `<section class="slide hero dark" data-animate="hero" data-slide-id="${id}"><div class="chrome"><span>EPILOGUE</span><span>${page}</span></div><div class="frame" style="display:grid;align-content:center;gap:4vh"><h1 data-anim="title" style="font-size:${heroFontSize(slide.title)};line-height:.98">${title}</h1>${note}</div></section>`;
  }
  if (isCover || isSection) {
    const subtitle = points[0] ? `<p class="lead" data-anim="item" style="max-width:58vw">${escapeHtml(points[0])}</p>` : '';
    return swiss
      ? `<section class="slide accent" data-animate="hero" data-layout="S01" data-slide-id="${id}"><div class="canvas-card"><canvas class="ascii-bg" aria-hidden="true"></canvas><div class="chrome-min"><div class="l">${isCover ? 'PRODUCT STORY' : 'NEXT CHAPTER'}</div><div class="r">${page}</div></div><div style="flex:1;display:grid;align-content:center;gap:4vh"><div class="t-cat" data-anim="item">GUIZANG PRESENTS</div><h1 data-anim="title" style="max-width:88vw;font-family:var(--sans),var(--sans-zh);font-weight:200;font-size:${heroFontSize(slide.title)};line-height:.96;color:#fff">${title}</h1>${subtitle}</div></div></section>`
      : `<section class="slide hero dark" data-animate="hero" data-slide-id="${id}"><div class="chrome"><span>GUIZANG · FIELD NOTE</span><span>${page}</span></div><div class="frame" style="display:grid;align-content:center;gap:4vh"><div class="kicker" data-anim="item">A NEW PERSPECTIVE</div><h1 class="h-hero" data-anim="title">${title}</h1>${subtitle}</div></section>`;
  }
  const numeric = points.filter(point => /\d/.test(String(point))).slice(0, 4);
  if (numeric.length >= 2 || index % 5 === 1) {
    const cards = (numeric.length ? numeric : points.slice(0, 4)).map((point, pointIndex) => `<div class="${pointIndex === 0 ? 'card-accent' : 'card-fill'}" data-anim="item" style="padding:2.4vh 1.8vw;display:grid;align-content:space-between;min-height:19vh"><span class="t-meta">0${pointIndex + 1}</span><p style="font-size:max(18px,1.55vw);line-height:1.35">${escapeHtml(point)}</p></div>`).join('');
    return `<section class="slide light" data-animate="grid-reveal" data-layout="${swiss ? 'S06' : 'STATS'}" data-slide-id="${id}"><div class="${swiss ? 'canvas-card' : 'frame'}"><div class="${swiss ? 'chrome-min' : 'chrome'}"><div class="l">DATA · SIGNAL</div><div class="r">${page}</div></div><div style="display:grid;grid-template-rows:auto 1fr;gap:5vh;flex:1"><h2 class="${swiss ? 'h-xl-zh' : 'h-xl'}" data-anim="title">${title}</h2><div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1.3vw;align-content:center">${cards}</div></div></div></section>`;
  }
  if (index % 3 === 2) {
    const left = points.slice(0, Math.ceil(points.length / 2));
    const right = points.slice(Math.ceil(points.length / 2));
    const column = items => items.map((point, i) => `<div data-anim="item" style="padding:2vh 0;border-top:1px solid var(--border-subtle)"><span class="t-meta">0${i + 1}</span><p style="margin-top:1vh;font-size:max(18px,1.35vw);line-height:1.5">${escapeHtml(point)}</p></div>`).join('');
    return `<section class="slide dark" data-animate="stagger" data-layout="${swiss ? 'S08' : 'SPLIT'}" data-slide-id="${id}"><div class="${swiss ? 'canvas-card' : 'frame'}"><div class="${swiss ? 'chrome-min' : 'chrome'}"><div class="l">INSIGHT · CONTEXT</div><div class="r">${page}</div></div><div style="display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:6vw;align-items:start;flex:1"><h2 class="${swiss ? 'h-xl-zh' : 'h-xl'}" data-anim="title">${title}</h2><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 2vw">${column(left)}${column(right)}</div></div></div></section>`;
  }
  const items = points.map((point, pointIndex) => `<li data-anim="item" style="display:grid;grid-template-columns:3.2rem 1fr;gap:1vw;padding:1.8vh 0;border-top:1px solid var(--border-subtle)"><span class="t-meta">${String(pointIndex + 1).padStart(2, '0')}</span><span style="font-size:max(18px,1.4vw);line-height:1.45">${escapeHtml(point)}</span></li>`).join('');
  return `<section class="slide light" data-animate="stagger" data-layout="${swiss ? 'S11' : 'EDITORIAL'}" data-slide-id="${id}"><div class="${swiss ? 'canvas-card' : 'frame'}"><div class="${swiss ? 'chrome-min' : 'chrome'}"><div class="l">EDITORIAL · NOTE</div><div class="r">${page}</div></div><div style="display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:6vw;flex:1"><h2 class="${swiss ? 'h-xl-zh' : 'h-xl'}" data-anim="title">${title}</h2><ol style="list-style:none;margin:0;padding:0;align-self:center">${items}</ol></div></div></section>`;
}

function renderSlides(slides, swiss) {
  return slides.map((slide, index) => hasMeaningfulElements(slide)
    ? renderFreeLayout(slide, index, slides.length, swiss)
    : renderFallback(slide, index, slides.length, swiss)
  ).join('\n');
}

function replaceDeck(template, slidesHtml) {
  const start = template.indexOf('<div id="deck">');
  const end = template.indexOf('\n</div>\n\n<div id="nav">', start);
  if (start < 0 || end < 0) throw new Error('deck boundary not found');
  return template.slice(0, start) + `<div id="deck">\n${slidesHtml}` + template.slice(end);
}

function replaceNotes(template, slides) {
  const startMarker = 'const SPEAKER_NOTES = [';
  const endMarker = '];\nwindow.__SPEAKER_NOTES__';
  const start = template.indexOf(startMarker);
  const end = template.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('speaker-notes boundary not found');
  const notes = slides.map((slide, index) => ({
    id: slug(slide.id, `slide-${index + 1}`), title: String(slide.title || ''), purpose: '传达本页核心信息',
    talk: (Array.isArray(slide.points) ? slide.points : []).slice(0, 5), transition: index + 1 < slides.length ? '进入下一页' : '结束演示',
  }));
  return template.slice(0, start) + `const SPEAKER_NOTES = ${JSON.stringify(notes, null, 2)}` + template.slice(end + 1);
}

function inlineMotion(template) {
  const source = fs.readFileSync(path.join(root, 'assets/motion.min.js'), 'utf8');
  const replacement = `await import(URL.createObjectURL(new Blob([${JSON.stringify(source)}],{type:'text/javascript'})))`;
  return template.replace("await import('./assets/motion.min.js')", replacement);
}

function sourceArchive() {
  const target = path.join(outputRoot, 'guizang-ppt-skill-source.tar.gz');
  const result = spawnSync('tar', ['--exclude=.git', '--exclude=.runner-output', '-czf', target, '-C', path.dirname(root), path.basename(root)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'could not build source archive');
  return target;
}

async function generate(jobId, spec) {
  const job = jobs.get(jobId);
  try {
    job.status = 'running'; job.progress = 10; job.stage = 'building_html';
    const slides = Array.isArray(spec.slides) && spec.slides.length ? spec.slides : [{ id: 'cover', role: 'cover', title: spec.title, points: [] }];
    const sessionId = crypto.createHash('sha256').update(String(spec.task_id || jobId)).digest('hex');
    const sessionDir = path.join(outputRoot, 'sessions', sessionId);
    fs.mkdirSync(sessionDir, {recursive:true});
    const configPath = path.join(sessionDir, 'config.json');
    const configuration = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : {
      swiss:selectSwiss(spec.theme, spec.title),
      palette:presetCss(spec.theme),
      theme_color:/^#[0-9a-f]{6}$/i.test(spec.theme_color || '') ? spec.theme_color : '',
      font_name:String(spec.font_name || '').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80),
      planned_slides:Number(spec.planned_slides) || (spec.incremental ? 0 : slides.length),
    };
    if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(configuration));
    const swiss = configuration.swiss;
    let html = fs.readFileSync(path.join(root, swiss ? 'assets/template-swiss.html' : 'assets/template.html'), 'utf8');
    html = html.replace('</head>', `<style>:root{${configuration.palette || ''}}</style></head>`);
    html = html.replace('</head>', `<style>:root{${configuration.theme_color ? `--accent:${configuration.theme_color};` : ''}${configuration.font_name ? `--sans:"${configuration.font_name}",sans-serif;--sans-zh:"${configuration.font_name}",sans-serif;` : ''}}</style></head>`);
    const template = inlineMotion(html).replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(spec.title || 'Presentation')}</title>`);
    const fragments = [];
    const pageDir = path.join(outputRoot, jobId, 'pages');
    fs.mkdirSync(pageDir, {recursive:true});
    job.pages = []; job.session_id = sessionId;
    for (let index = 0; index < slides.length; index++) {
      const slide = slides[index];
      const revision = crypto.createHash('sha256').update(JSON.stringify(['clean-chrome-v1',slide,index,configuration])).digest('hex');
      const cached = path.join(sessionDir, `${index}-${revision}.html`);
      const reused = fs.existsSync(cached);
      const fragment = reused ? fs.readFileSync(cached, 'utf8') : cleanSlideChrome(hasMeaningfulElements(slide)
        ? renderFreeLayout(slide,index,configuration.planned_slides,swiss)
        : renderFallback(slide,index,configuration.planned_slides,swiss));
      if (!reused) { fs.writeFileSync(cached + '.tmp',fragment); fs.renameSync(cached + '.tmp',cached); }
      fragments.push(fragment);
      const snapshot = replaceNotes(replaceDeck(template,fragments.join('\n')),slides.slice(0,index + 1));
      const pageFile = path.join(pageDir,`page-${index + 1}.html`);
      fs.writeFileSync(pageFile + '.tmp',snapshot); fs.renameSync(pageFile + '.tmp',pageFile);
      job.pages.push({type:'page_ready',page:index + 1,sequence:index + 1,revision,reused,
        download_url:`/v1/jobs/${jobId}/pages/${index + 1}`});
      job.progress = Math.floor((index + 1) / slides.length * 95);
      await new Promise(resolve => setImmediate(resolve));
    }
    html = replaceDeck(html, fragments.join('\n'));
    html = replaceNotes(html, slides);
    html = inlineMotion(html).replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(spec.title || 'Presentation')}</title>`);
    const dir = path.join(outputRoot, jobId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'presentation.html');
    fs.writeFileSync(file, html);
    job.status = 'succeeded'; job.progress = 100; job.stage = 'completed';
    job.artifacts = [{ type: 'html', file_name: `${String(spec.title || 'presentation').replace(/[\\/:*?"<>|]/g, '_')}.html`, mime_type: 'text/html; charset=utf-8', download_url: `/v1/jobs/${jobId}/artifacts/presentation` }];
  } catch (error) {
    job.status = 'failed'; job.error = String(error?.message || error); job.stage = 'failed';
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://runner.local');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, engine: 'guizang', capabilities:{incremental_pages:true,page_cache:true} });
  if (req.method === 'GET' && url.pathname === '/source') return json(res, 200, { license: 'AGPL-3.0', download_url: '/source/archive' });
  if (req.method === 'GET' && url.pathname === '/source/archive') {
    try { const data = fs.readFileSync(sourceArchive()); res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="guizang-ppt-skill-source.tar.gz"', 'content-length': data.length }); return res.end(data); }
    catch (error) { return json(res, 500, { error: String(error.message) }); }
  }
  if (req.method === 'GET' && new Set([
    '/v1/previews/showcase',
    '/v1/previews/editorial',
    '/v1/previews/swiss',
  ]).has(url.pathname)) {
    const file = path.join(root, 'assets/ppt-skill-showcase.png');
    const data = fs.readFileSync(file); res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length }); return res.end(data);
  }
  let body = Buffer.alloc(0);
  if (req.method === 'POST') {
    try { body = await readBody(req); } catch (error) { return json(res, 413, { error: String(error.message) }); }
  }
  if (!authenticate(req, body)) return json(res, 401, { error: 'invalid signature' });
  if (req.method === 'POST' && url.pathname === '/v1/jobs') {
    let spec; try { spec = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if (spec.protocol_version !== '1.0') return json(res, 400, { error: 'unsupported protocol_version' });
    const jobId = crypto.randomUUID();
    jobs.set(jobId, { job_id: jobId, status: 'queued', progress: 0, stage: 'queued', artifacts: [], engine_version: 'upstream-c91369c-quickerwrite.1', source_offer_url: '/source' });
    const queueKey = String(spec.task_id || jobId);
    const operation = (sessionQueues.get(queueKey) || Promise.resolve()).then(() => generate(jobId,spec));
    sessionQueues.set(queueKey,operation);
    operation.finally(() => { if (sessionQueues.get(queueKey) === operation) sessionQueues.delete(queueKey); });
    return json(res, 202, jobs.get(jobId));
  }
  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1]); return job ? json(res, 200, job) : json(res, 404, { error: 'job not found' });
  }
  const artifactMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)\/artifacts\/presentation$/);
  const pageMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)\/pages\/(\d+)$/);
  if (req.method === 'GET' && pageMatch) {
    const pageFile = path.join(outputRoot,pageMatch[1],'pages',`page-${pageMatch[2]}.html`);
    if (!fs.existsSync(pageFile)) return json(res,404,{error:'page not ready'});
    return res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(fs.readFileSync(pageFile));
  }
  if (req.method === 'GET' && artifactMatch) {
    const file = path.join(outputRoot, artifactMatch[1], 'presentation.html');
    if (!fs.existsSync(file)) return json(res, 404, { error: 'artifact not found' });
    const data = fs.readFileSync(file); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': data.length }); return res.end(data);
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(port, host, () => console.log(`Guizang QuickerWrite runner listening on ${host}:${port}`));
