const express = require("express");
const cheerio = require("cheerio");
const PDFDocument = require("pdfkit");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const MEDIA = path.join(DATA, "media");
fs.mkdirSync(MEDIA, { recursive: true });
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));
app.get("/health",(_req,res)=>res.json({ok:true}));

const UA = "Mozilla/5.0 (compatible; ComicVault/1.1; personal comic archiver)";
const MAX_COMICFURY_PAGES = 1500;
const MAX_MANGADEX_CHAPTERS = 500;
const MAX_TOTAL_PAGES = 3000;

function allowedUrl(raw) {
  const u = new URL(raw);
  if (!["http:","https:"].includes(u.protocol)) throw new Error("Paste a valid http or https comic URL.");
  if (["localhost","127.0.0.1","0.0.0.0"].includes(u.hostname) || u.hostname.endsWith(".local")) throw new Error("That address cannot be imported.");
  return u;
}
function absolute(base, value) {
  try { return new URL(value,base).href; } catch { return null; }
}
async function getHtml(url) {
  const r = await fetch(url,{redirect:"follow",headers:{"User-Agent":UA,"Accept":"text/html,application/xhtml+xml"},signal:AbortSignal.timeout(25000)});
  if (!r.ok) throw new Error(`The comic site returned HTTP ${r.status}.`);
  const type=r.headers.get("content-type")||"";
  if(!type.includes("text/html")) throw new Error("That link did not return a readable comic webpage.");
  return await r.text();
}
async function getJson(url) {
  const r=await fetch(url,{headers:{"User-Agent":UA,"Accept":"application/json"},signal:AbortSignal.timeout(25000)});
  if(!r.ok) throw new Error(`The comic service returned HTTP ${r.status}.`);
  return r.json();
}
function imageCandidates(html,pageUrl) {
  const $=cheerio.load(html), out=[];
  $("img").each((_,e)=>{
    const el=$(e);
    const src=el.attr("data-src")||el.attr("data-lazy-src")||el.attr("data-original")||el.attr("data-cfsrc")||el.attr("src");
    if(!src||src.startsWith("data:")) return;
    const url=absolute(pageUrl,src); if(!url) return;
    const hint=((el.attr("id")||"")+" "+(el.attr("class")||"")+" "+(el.attr("alt")||"")+" "+(el.attr("title")||"")).toLowerCase();
    let score=0;
    if(/comic|toon|manga|episode|webtoon|panel|page|reader|chapter/.test(hint)) score+=12;
    if(/logo|avatar|profile|banner|icon|ad|emoji|cover|thumbnail/.test(hint)) score-=25;
    const w=Number(el.attr("width")||0),h=Number(el.attr("height")||0);
    score+=Math.min(w,2000)/200+Math.min(h,3000)/300;
    if(/\.(jpe?g|png|webp|avif)(\?|$)/i.test(url)) score+=2;
    out.push({url,score});
  });
  // Open Graph images are a fallback only, never ranked above an actual reader image.
  $("meta[property='og:image'],meta[name='twitter:image']").each((_,e)=>{
    const src=$(e).attr("content"); if(src) out.push({url:absolute(pageUrl,src),score:1});
  });
  const seen=new Set();
  return out.filter(x=>x.url&&/^https?:/.test(x.url)&&!seen.has(x.url)&&seen.add(x.url))
    .sort((a,b)=>b.score-a.score).map(x=>x.url);
}

// ComicFury pages have stable /comics/{id} URLs. The reader may be hosted at
// comicfury.com/read/{comic}/... or on a creator's thecomicseries.com domain.
function comicFuryPageLinks(html,base) {
  const $=cheerio.load(html), urls=[];
  const baseUrl=new URL(base);
  const readMatch=baseUrl.pathname.match(/^\/read\/([^/]+)/i);
  const slug=readMatch?.[1];
  $("a[href]").each((_,e)=>{
    const href=absolute(base,$(e).attr("href")); if(!href) return;
    try {
      const u=new URL(href);
      if(u.hostname!==baseUrl.hostname) return;
      const isReadComic=!!slug && u.pathname.toLowerCase().startsWith(`/read/${slug.toLowerCase()}/comics/`) && /^\/read\/[^/]+\/comics\/\d+\/?$/i.test(u.pathname);
      const isHostedComic=/^\/comics\/\d+\/?$/i.test(u.pathname);
      if(isReadComic||isHostedComic) urls.push(u.href);
    } catch {}
  });
  return [...new Set(urls)];
}
function comicFuryArchiveUrls(url) {
  const u=new URL(url.href), m=u.pathname.match(/^\/read\/([^/]+)/i);
  if(m) return [`${u.origin}/read/${m[1]}/archive/`,`${u.origin}/read/${m[1]}/archive/comics`,`https://comicfury.com/comicprofile.php?url=${encodeURIComponent(m[1])}`];
  return [`${u.origin}/archive/`,`${u.origin}/archive/comics`];
}
function comicFuryArchiveLinks(html,base) {
  const $=cheerio.load(html), out=[];
  const host=new URL(base).hostname;
  $("a[href]").each((_,e)=>{
    const href=absolute(base,$(e).attr("href")); if(!href) return;
    try {
      const u=new URL(href), label=$(e).text().trim().toLowerCase();
      if(u.hostname!==host) return;
      if(/archive/i.test(u.pathname) && !/\/comics\/\d+/.test(u.pathname)) out.push(u.href);
      if(label.includes("archive") && /comicfury\.com$/i.test(u.hostname)) out.push(u.href);
    } catch {}
  });
  return [...new Set(out)];
}
async function collectComicFury(url,initialHtml) {
  const pagesById=new Map(), visited=new Set();
  let archiveHtmls=[];
  for(const archiveUrl of comicFuryArchiveUrls(url)) {
    try { archiveHtmls.push({url:archiveUrl,html:await getHtml(archiveUrl)}); } catch {}
  }
  const queue=[url.href], archiveQueue=[];
  for(const a of archiveHtmls) {
    queue.push(...comicFuryPageLinks(a.html,a.url));
    archiveQueue.push(...comicFuryArchiveLinks(a.html,a.url));
  }
  let count=0, archiveCount=0;
  while((queue.length || archiveQueue.length) && count<MAX_COMICFURY_PAGES) {
    if(archiveQueue.length && archiveCount<100) {
      const archiveUrl=archiveQueue.shift();
      if(!visited.has(archiveUrl)) {
        visited.add(archiveUrl); archiveCount++;
        try {
          const ah=await getHtml(archiveUrl);
          queue.push(...comicFuryPageLinks(ah,archiveUrl));
          archiveQueue.push(...comicFuryArchiveLinks(ah,archiveUrl));
        } catch(e) { console.warn("ComicFury archive skipped",archiveUrl,e.message); }
      }
      continue;
    }
    const pageUrl=queue.shift();
    if(!pageUrl||visited.has(pageUrl)) continue;
    visited.add(pageUrl); count++;
    try {
      const html=pageUrl===url.href?initialHtml:await getHtml(pageUrl);
      const $=cheerio.load(html);
      const links=comicFuryPageLinks(html,pageUrl);
      for(const link of links) if(!visited.has(link)) queue.push(link);
      const imgs=imageCandidates(html,pageUrl);
      const img=imgs.find(src=>!/(logo|avatar|banner|icon|thumbnail)/i.test(src));
      const pathId=new URL(pageUrl).pathname.match(/\/comics\/(\d+)/i)?.[1];
      if(img&&pathId) pagesById.set(Number(pathId),{url:img,source:pageUrl,title:$("title").text().trim()||`Page ${pathId}`});
    } catch(e) { console.warn("ComicFury page skipped",pageUrl,e.message); }
  }
  return [...pagesById.entries()].sort((a,b)=>a[0]-b[0]).map(([,p])=>p);
}

function slugify(s){return String(s||"").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");}
async function mangaDexMangaId(url,html) {
  const pathMatch=url.pathname.match(/\/title\/([0-9a-f-]{36})/i);
  if(pathMatch) return pathMatch[1];
  const chapterMatch=url.pathname.match(/\/chapter\/([0-9a-f-]{36})/i);
  if(chapterMatch) {
    const chapter=await getJson(`https://api.mangadex.org/chapter/${chapterMatch[1]}?includes[]=manga`);
    const rel=chapter.data?.relationships?.find(x=>x.type==="manga");
    if(rel?.id) return rel.id;
  }
  const $=cheerio.load(html);
  const title=$("meta[property='og:title']").attr("content")||$("h1").first().text()||$("title").text();
  const cleaned=String(title).replace(/\s*[-|].*$/," ").trim();
  const result=await getJson(`https://api.mangadex.org/manga?title=${encodeURIComponent(cleaned)}&limit=10&order[relevance]=desc`);
  const slug=url.pathname.split("/").filter(Boolean).pop();
  const exact=(result.data||[]).find(m=>slugify(m.attributes?.title?.en||Object.values(m.attributes?.title||{})[0])===slug);
  return (exact||result.data?.[0])?.id||null;
}
async function collectMangaDex(url,html) {
  const mangaId=await mangaDexMangaId(url,html);
  if(!mangaId) throw new Error("I couldn't identify this MangaDex series. Paste its MangaDex title or chapter link.");
  const all=[];
  async function loadFeed(language) {
    let offset=0;
    while(all.length<MAX_MANGADEX_CHAPTERS) {
      const api=`https://api.mangadex.org/manga/${mangaId}/feed?limit=500&offset=${offset}&order[volume]=asc&order[chapter]=asc&translatedLanguage[]=${encodeURIComponent(language)}&includes[]=scanlation_group`;
      const data=await getJson(api);
      all.push(...(data.data||[]));
      if(!data.data?.length||offset+(data.data?.length||0)>=(data.total||0)) break;
      offset+=data.data.length;
    }
  }
  await loadFeed("en");
  if(!all.length) await loadFeed("ja");
  if(!all.length) {
    let offset=0;
    while(all.length<MAX_MANGADEX_CHAPTERS) {
      const data=await getJson(`https://api.mangadex.org/manga/${mangaId}/feed?limit=500&offset=${offset}&order[volume]=asc&order[chapter]=asc`);
      all.push(...(data.data||[]));
      if(!data.data?.length||offset+(data.data?.length||0)>=(data.total||0)) break;
      offset+=data.data.length;
    }
  }
  if(!all.length) throw new Error("MangaDex did not return any publicly available chapters for this series.");
  const pages=[];
  for(const chapter of all.slice(0,MAX_MANGADEX_CHAPTERS)) {
    const atHome=await getJson(`https://api.mangadex.org/at-home/server/${chapter.id}`);
    const hash=atHome.chapter?.hash, base=atHome.baseUrl;
    const files=atHome.chapter?.dataSaver?.length?atHome.chapter.dataSaver:atHome.chapter?.data||[];
    const chapterNo=chapter.attributes?.chapter||"?";
    for(let i=0;i<files.length;i++) {
      pages.push({url:`${base}/${atHome.chapter.dataSaver?.length?"data-saver":"data"}/${hash}/${files[i]}`,source:"https://mangadex.org/",title:`Chapter ${chapterNo} — Page ${i+1}`});
      if(pages.length>=MAX_TOTAL_PAGES) break;
    }
    if(pages.length>=MAX_TOTAL_PAGES) break;
  }
  return pages;
}

// Comix.to is a JavaScript-heavy reader. This adapter discovers the public
// chapter links exposed in the series HTML and extracts reader images from
// each chapter. If the site changes its client-side API, it reports that
// rather than silently returning a cover as if it were the whole series.
function comixChapterLinks(html,base) {
  const $=cheerio.load(html), out=[];
  $("a[href]").each((_,e)=>{
    const href=absolute(base,$(e).attr("href")); if(!href) return;
    try { const u=new URL(href); if(/(^|\.)comix\.to$/i.test(u.hostname)&&/\/chapter\//i.test(u.pathname)) out.push(u.href); } catch {}
  });
  // Some Comix pages embed chapter routes in hydration JSON rather than anchors.
  const pattern=/(?:https?:\/\/comix\.to)?\/title\/[^"'\s<>]+\/chapter\/[^"'\s<>\\]+/gi;
  for(const match of html.matchAll(pattern)) { const href=absolute(base,match[0]); if(href) out.push(href); }
  return [...new Set(out)];
}
async function collectComix(url,initialHtml) {
  let seriesUrl=url.href;
  const chapterMatch=url.pathname.match(/^(.*?\/title\/[^/]+)\/chapter\//i);
  if(chapterMatch) seriesUrl=url.origin+chapterMatch[1];
  const seriesHtml=seriesUrl===url.href?initialHtml:await getHtml(seriesUrl);
  const chapters=comixChapterLinks(seriesHtml,seriesUrl).reverse();
  if(!chapters.length) {
    const candidates=imageCandidates(initialHtml,url.href);
    throw new Error(candidates.length?"Comix.to loaded the series shell but its chapter list is JavaScript-rendered and wasn't exposed to the server. This link needs a site API update.":"I couldn't read the public Comix.to chapter list from that link.");
  }
  const pages=[];
  for(const chapterUrl of chapters.slice(0,500)) {
    try {
      const html=chapterUrl===url.href?initialHtml:await getHtml(chapterUrl);
      const $=cheerio.load(html);
      const imgs=imageCandidates(html,chapterUrl).filter(src=>!/(logo|avatar|banner|icon|cover|thumbnail)/i.test(src));
      // Reader pages are commonly emitted as multiple images on a chapter page.
      for(const img of imgs) pages.push({url:img,source:chapterUrl,title:$("title").text().trim()||"Comix chapter"});
    } catch(e) { console.warn("Comix chapter skipped",chapterUrl,e.message); }
    if(pages.length>=MAX_TOTAL_PAGES) break;
  }
  if(!pages.length) throw new Error("Comix.to chapters were found, but their page images were not exposed in the public HTML. The site's reader may require a JavaScript/API adapter update.");
  return pages.slice(0,MAX_TOTAL_PAGES);
}

async function imageToFile(url, referer) {
  const response=await fetch(url,{redirect:"follow",headers:{"User-Agent":UA,"Referer":referer,"Accept":"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"},signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw new Error(`A comic image could not be retrieved (HTTP ${response.status}).`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>25*1024*1024) throw new Error("A page image exceeded the 25 MB limit.");
  const meta=await sharp(bytes,{failOn:"none"}).metadata();
  if(!meta.width||!meta.height||meta.width<180||meta.height<180) throw new Error("The source returned an image too small to be a comic page.");
  const file=path.join(MEDIA,crypto.randomUUID()+".jpg");
  await sharp(bytes,{failOn:"none"}).rotate().jpeg({quality:90}).toFile(file);
  return {file,width:meta.width,height:meta.height};
}
async function collect(url) {
  const html=await getHtml(url.href);
  const host=url.hostname.toLowerCase();
  let pages=[];
  if(host==="mangadex.org"||host.endsWith(".mangadex.org")) pages=await collectMangaDex(url,html);
  else if(host==="comix.to"||host.endsWith(".comix.to")) pages=await collectComix(url,html);
  else if(host==="comicfury.com"||host.endsWith(".comicfury.com")||host.endsWith(".thecomicseries.com")) pages=await collectComicFury(url,html);
  else {
    const imgs=imageCandidates(html,url.href);
    const $=cheerio.load(html);
    const title=$("h1").first().text().trim()||$("title").text().trim()||"Comic";
    for(const img of imgs.slice(0,80)) pages.push({url:img,source:url.href,title});
  }
  if(!pages.length) throw new Error("I couldn't find public comic-page images at that link. The site may load pages dynamically or require access that ComicVault cannot use.");
  if(pages.length>MAX_TOTAL_PAGES) pages=pages.slice(0,MAX_TOTAL_PAGES);
  const downloaded=[]; let failures=0;
  for(let i=0;i<pages.length;i++) {
    try {
      const image=await imageToFile(pages[i].url,pages[i].source);
      downloaded.push({...image,title:pages[i].title,number:i+1});
    } catch(e) { failures++; console.warn("Image skipped:",pages[i].url,e.message); }
  }
  if(!downloaded.length) throw new Error("The page images were detected but could not be downloaded. The site may be blocking server requests.");
  if(failures) console.warn(`${failures} of ${pages.length} image requests failed.`);
  return {title:cheerio.load(html)("title").text().trim()||"ComicVault comic",pages:downloaded};
}
app.post("/api/download",async(req,res)=>{
  let files=[];
  try {
    const url=allowedUrl(String(req.body.url||"").trim());
    const comic=await collect(url);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",'attachment; filename="ComicVault-comic.pdf"');
    const pdf=new PDFDocument({autoFirstPage:false,compress:true,margin:18});
    pdf.pipe(res);
    for(const p of comic.pages) {
      const maxW=576,maxH=1100;
      const scale=Math.min(maxW/p.width,maxH/p.height,1);
      const w=p.width*scale,h=p.height*scale;
      pdf.addPage({size:[w+36,h+36],margin:18});
      pdf.image(p.file,18,18,{width:w,height:h});
    }
    pdf.end();
    files=comic.pages.map(p=>p.file);
    res.on("finish",()=>files.forEach(f=>{try{fs.unlinkSync(f)}catch{}}));
  } catch(e) {
    if(!res.headersSent) res.status(400).json({error:e.message||"Comic download failed."});
  }
});
app.listen(PORT,()=>console.log(`ComicVault listening on ${PORT}`));
