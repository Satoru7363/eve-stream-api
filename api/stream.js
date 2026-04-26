import { getEmbedSuVideo, getEmbedSuStreamUrl } from 'vidsrc-bypass';
import { getVidSrcRipVideo, getVidSrcRipStreamUrl } from 'vidsrc-bypass';
import { getVidLinkProVideo } from 'vidsrc-bypass';

// ── EmbedSu (embed.su) ────────────────────────────────────
async function tryEmbedSu(tmdb, type, season, episode) {
  try {
    let details;
    if (type === 'tv') {
      details = await getEmbedSuVideo(Number(tmdb), Number(season), Number(episode));
    } else {
      details = await getEmbedSuVideo(Number(tmdb));
    }
    if (!details?.servers?.length) return null;

    for (const server of details.servers) {
      try {
        const stream = await getEmbedSuStreamUrl(server.hash);
        const url = stream?.url || stream?.stream || stream?.source;
        if (url && (url.includes('.m3u8') || url.includes('.mp4'))) {
          return { url, source: 'embed.su', quality: 'auto', priority: 1 };
        }
      } catch (_) { continue; }
    }
    return null;
  } catch (e) { return null; }
}

// ── VidSrcRip (vidsrc.rip) ───────────────────────────────
async function tryVidSrcRip(tmdb, type, season, episode) {
  try {
    const config = await getVidSrcRipVideo(String(tmdb));
    if (!config) return null;

    const provider = type === 'tv' ? 'flixhq' : 'flixhq';
    const stream = await getVidSrcRipStreamUrl(provider, String(tmdb));
    const url = stream?.url || stream?.stream;
    if (url && (url.includes('.m3u8') || url.includes('.mp4'))) {
      return { url, source: 'vidsrc.rip', quality: 'auto', priority: 2 };
    }
    return null;
  } catch (e) { return null; }
}

// ── VidLink Pro ──────────────────────────────────────────
async function tryVidLink(tmdb, type, season, episode) {
  try {
    let details;
    if (type === 'tv') {
      details = await getVidLinkProVideo({ id: String(tmdb), season: Number(season), episode: Number(episode), type: 'tv' });
    } else {
      details = await getVidLinkProVideo({ id: String(tmdb), type: 'movie' });
    }
    const url = details?.url || details?.stream || details?.source;
    if (url && (url.includes('.m3u8') || url.includes('.mp4'))) {
      return { url, source: 'vidlink.pro', quality: 'auto', priority: 3 };
    }
    return null;
  } catch (e) { return null; }
}

// ── Main Handler ─────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tmdb, type = 'movie', season = '1', episode = '1' } = req.query;
  if (!tmdb) return res.status(400).json({ success: false, error: 'Missing tmdb' });

  const results = await Promise.allSettled([
    tryEmbedSu(tmdb, type, season, episode),
    tryVidLink(tmdb, type, season, episode),
    tryVidSrcRip(tmdb, type, season, episode),
  ]);

  const streams = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)
    .sort((a, b) => a.priority - b.priority);

  if (!streams.length) {
    return res.status(404).json({ success: false, error: 'No streams found' });
  }

  return res.status(200).json({ success: true, primary: streams[0], streams, count: streams.length });
}
