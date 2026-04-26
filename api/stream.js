import crypto from 'crypto';

// ══════════════════════════════════════════════════════════
//  RC4 — مكتوب من الصفر بدون أي مكتبة خارجية
// ══════════════════════════════════════════════════════════
function rc4(key, data) {
  const k = Buffer.from(key, 'utf8');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
  const S = Array.from({length:256},(_,i)=>i);
  let j=0;
  for(let i=0;i<256;i++){j=(j+S[i]+k[i%k.length])%256;[S[i],S[j]]=[S[j],S[i]];}
  const out=Buffer.alloc(d.length);
  let i=0;j=0;
  for(let n=0;n<d.length;n++){i=(i+1)%256;j=(j+S[i])%256;[S[i],S[j]]=[S[j],S[i]];out[n]=d[n]^S[(S[i]+S[j])%256];}
  return out;
}

const H = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9',
  'Accept-Encoding':'gzip, deflate, br',
  'Connection':'keep-alive',
  'Upgrade-Insecure-Requests':'1',
  'Sec-Fetch-Dest':'document',
  'Sec-Fetch-Mode':'navigate',
  'Sec-Fetch-Site':'none',
};

// ══════════════════════════════════════════════════════════
//  SOURCE 1 — embed.su (RC4 decryption)
// ══════════════════════════════════════════════════════════
async function tryEmbedSu(tmdb, type, season, episode) {
  try {
    const embedUrl = type==='tv'
      ? `https://embed.su/embed/tv/${tmdb}/${season}/${episode}`
      : `https://embed.su/embed/movie/${tmdb}`;

    const pageRes = await fetch(embedUrl, {
      headers:{...H,'Referer':'https://embed.su/'},
      signal:AbortSignal.timeout(10000),
      redirect:'follow'
    });
    if(!pageRes.ok) return null;
    const html = await pageRes.text();

    // استخراج الـ hash من الصفحة
    const hashMatch = html.match(/data-hash=['"]([^'"]+)['"]/) ||
                      html.match(/hash\s*[:=]\s*['"]([A-Za-z0-9+/=_-]{20,})['"]/) ||
                      html.match(/\/api\/e\/([A-Za-z0-9+/=_-]{20,})/);
    if(!hashMatch) return null;
    const hash = hashMatch[1];

    // استدعاء API الداخلي
    const apiRes = await fetch(`https://embed.su/api/e/${hash}`, {
      headers:{
        ...H,
        'Referer': embedUrl,
        'Accept':'application/json, text/plain, */*',
        'X-Requested-With':'XMLHttpRequest',
      },
      signal:AbortSignal.timeout(10000),
    });
    if(!apiRes.ok) return null;
    const data = await apiRes.json();

    if(!data?.source) return null;

    // فك التشفير — المفتاح = base64_decode(hash) معكوس
    const keyBuf = Buffer.from(hash, 'base64');
    const reversed = Buffer.from([...keyBuf].reverse());
    const key = reversed.toString('utf8');
    const decrypted = rc4(key, data.source).toString('utf8');

    const urlMatch = decrypted.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/);
    if(urlMatch) {
      return {
        url: urlMatch[0],
        source: 'embed.su',
        quality: 'auto',
        priority: 1,
        subtitle: data?.subtitles?.[0]?.url || ''
      };
    }

    // إذا كان المحتوى هو الرابط مباشرة
    if(decrypted.startsWith('http') && (decrypted.includes('.m3u8')||decrypted.includes('.mp4'))) {
      return { url:decrypted.trim(), source:'embed.su', quality:'auto', priority:1 };
    }

    return null;
  } catch(e) { return null; }
}

// ══════════════════════════════════════════════════════════
//  SOURCE 2 — vidsrc.rip (VRF token)
// ══════════════════════════════════════════════════════════
function generateVRF(id) {
  const vrfKey = [0x62,0x64,0x65,0x66,0x61,0x63,0x6b,0x62,0x64,0x65];
  let result = '';
  for(let i=0;i<id.length;i++){
    result += String.fromCharCode(id.charCodeAt(i)^vrfKey[i%vrfKey.length]);
  }
  return Buffer.from(result,'binary').toString('base64');
}

async function tryVidSrcRip(tmdb, type, season, episode) {
  try {
    const embedUrl = type==='tv'
      ? `https://vidsrc.rip/embed/tv?tmdb=${tmdb}&season=${season}&episode=${episode}`
      : `https://vidsrc.rip/embed/movie?tmdb=${tmdb}`;

    const pageRes = await fetch(embedUrl, {
      headers:{...H,'Referer':'https://vidsrc.rip/'},
      signal:AbortSignal.timeout(10000),
      redirect:'follow'
    });
    if(!pageRes.ok) return null;
    const html = await pageRes.text();

    // استخراج source URL
    const srcMatch = html.match(/sourceUrl\s*[:=]\s*['"]([^'"]+)['"]/) ||
                     html.match(/src\s*[:=]\s*['"]([^'"]+(?:source|stream)[^'"]+)['"]/i);
    if(!srcMatch) return null;
    let srcUrl = srcMatch[1];
    if(srcUrl.startsWith('/')) srcUrl = 'https://vidsrc.rip'+srcUrl;

    const vrf = generateVRF(tmdb.toString());
    const srcRes = await fetch(`${srcUrl}?vrf=${encodeURIComponent(vrf)}`, {
      headers:{...H,'Referer':embedUrl},
      signal:AbortSignal.timeout(10000),
    });
    if(!srcRes.ok) return null;

    const srcData = await srcRes.json();
    const sources = srcData?.sources || srcData?.data?.sources || [];

    for(const s of sources) {
      const url = s?.file || s?.url || s?.src;
      if(url && (url.includes('.m3u8')||url.includes('.mp4'))) {
        return { url, source:'vidsrc.rip', quality:s?.label||'auto', priority:2 };
      }
    }

    // ابحث عن m3u8 في الـ JSON مباشرة
    const raw = JSON.stringify(srcData);
    const m3u8 = raw.match(/https?:\\?\/\\?\/[^\s"']+\.m3u8[^\s"']*/);
    if(m3u8) {
      return { url:m3u8[0].replace(/\\/g,''), source:'vidsrc.rip', quality:'auto', priority:2 };
    }

    return null;
  } catch(e) { return null; }
}

// ══════════════════════════════════════════════════════════
//  SOURCE 3 — vidsrc.me (multi-step scraping)
// ══════════════════════════════════════════════════════════
function decodeVidsrcMe(str) {
  // vidsrc.me uses a simple char-code based scramble
  let result = '';
  for(let i=0;i<str.length;i++){
    result += String.fromCharCode(str.charCodeAt(i)^2);
  }
  return result;
}

async function tryVidSrcMe(tmdb, type, season, episode) {
  try {
    const embedUrl = type==='tv'
      ? `https://vidsrc.me/embed/tv?tmdb=${tmdb}&season=${season}&episode=${episode}`
      : `https://vidsrc.me/embed/movie?tmdb=${tmdb}`;

    const pageRes = await fetch(embedUrl, {
      headers:{...H,'Referer':'https://vidsrc.me/'},
      signal:AbortSignal.timeout(10000),
      redirect:'follow'
    });
    if(!pageRes.ok) return null;
    const html = await pageRes.text();

    // استخراج iframe src
    const iframeMatch = html.match(/<iframe[^>]+src=['"]([^'"]+)['"]/i);
    if(!iframeMatch) return null;

    let iframeSrc = iframeMatch[1];
    if(iframeSrc.startsWith('//')) iframeSrc = 'https:'+iframeSrc;
    if(iframeSrc.startsWith('/')) iframeSrc = 'https://vidsrc.me'+iframeSrc;

    const iframeRes = await fetch(iframeSrc, {
      headers:{...H,'Referer':embedUrl},
      signal:AbortSignal.timeout(10000),
      redirect:'follow'
    });
    if(!iframeRes.ok) return null;
    const iframeHtml = await iframeRes.text();

    // ابحث عن m3u8 مباشرة
    const m3u8Direct = iframeHtml.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/);
    if(m3u8Direct) {
      return { url:m3u8Direct[0], source:'vidsrc.me', quality:'auto', priority:3 };
    }

    // ابحث عن sources array
    const srcMatch = iframeHtml.match(/sources\s*:\s*\[([^\]]+)\]/);
    if(srcMatch) {
      const fileMatch = srcMatch[1].match(/file\s*:\s*['"]([^'"]+)['"]/);
      if(fileMatch && (fileMatch[1].includes('.m3u8')||fileMatch[1].includes('.mp4'))) {
        return { url:fileMatch[1], source:'vidsrc.me', quality:'auto', priority:3 };
      }
    }

    return null;
  } catch(e) { return null; }
}

// ══════════════════════════════════════════════════════════
//  SOURCE 4 — FlixHQ (public API)
// ══════════════════════════════════════════════════════════
async function tryFlixHQ(tmdb, type, season, episode) {
  try {
    const mediaType = type==='tv' ? 'tv' : 'movie';
    const searchRes = await fetch(
      `https://flixhq.to/ajax/search?keyword=${tmdb}`,
      { headers:{...H,'X-Requested-With':'XMLHttpRequest'}, signal:AbortSignal.timeout(8000) }
    );
    if(!searchRes.ok) return null;
    const searchHtml = await searchRes.text();

    const idMatch = searchHtml.match(/data-id=['"](\d+)['"]/);
    if(!idMatch) return null;
    const mediaId = idMatch[1];

    const episodesRes = await fetch(
      type==='tv'
        ? `https://flixhq.to/ajax/v2/tv/seasons/${mediaId}`
        : `https://flixhq.to/ajax/movie/episodes/${mediaId}`,
      { headers:{...H,'X-Requested-With':'XMLHttpRequest'}, signal:AbortSignal.timeout(8000) }
    );
    if(!episodesRes.ok) return null;
    const episodesData = await episodesRes.json();

    const epId = episodesData?.episodes?.[0]?.id || episodesData?.[0]?.id;
    if(!epId) return null;

    const srcRes = await fetch(
      `https://flixhq.to/ajax/sources/${epId}`,
      { headers:{...H,'X-Requested-With':'XMLHttpRequest'}, signal:AbortSignal.timeout(8000) }
    );
    if(!srcRes.ok) return null;
    const srcData = await srcRes.json();

    const url = srcData?.link || srcData?.url;
    if(url && (url.includes('.m3u8')||url.includes('.mp4'))) {
      return { url, source:'flixhq', quality:'auto', priority:4 };
    }
    return null;
  } catch(e) { return null; }
}

// ══════════════════════════════════════════════════════════
//  MAIN HANDLER
// ══════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(200).end();

  const { tmdb, type='movie', season='1', episode='1' } = req.query;
  if(!tmdb) return res.status(400).json({ success:false, error:'Missing tmdb' });

  const results = await Promise.allSettled([
    tryEmbedSu(tmdb, type, season, episode),
    tryVidSrcRip(tmdb, type, season, episode),
    tryVidSrcMe(tmdb, type, season, episode),
    tryFlixHQ(tmdb, type, season, episode),
  ]);

  const streams = results
    .filter(r=>r.status==='fulfilled'&&r.value)
    .map(r=>r.value)
    .sort((a,b)=>a.priority-b.priority);

  if(!streams.length) {
    return res.status(404).json({
      success:false,
      error:'No streams found',
      tried:['embed.su','vidsrc.rip','vidsrc.me','flixhq'],
    });
  }

  return res.status(200).json({
    success:true,
    primary:streams[0],
    streams,
    count:streams.length,
  });
}
