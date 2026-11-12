/**
 * 独立音源插件（无需 go-music-dl / 无需本地服务）
 *
 * 直连六个平台官方接口，纯前端 JS 实现，逻辑参考 guohuiyuan/music-lib（AGPL-3.0）后重写。
 *   千千音乐  music.91q.com        —— 搜索 / 播放 / 歌词
 *   酷我音乐  kuwo.cn              —— 搜索 / 播放 / 歌词
 *   酷狗音乐  kugou.com            —— 搜索 / 播放 / 歌词（仅免费曲目可播）
 *   咪咕音乐  migu.cn              —— 搜索 / 播放 / 歌词（PQ 试听档免费）
 *   5sing     search.5sing.kugou   —— 搜索 / 播放 / 歌词（翻唱、古风、二次元）
 *   Jamendo   jamendo.com          —— 搜索 / 播放（免费版权音乐，多为纯音乐无歌词）
 *
 * 不需要登录，不需要跑任何后台程序。装进 MusicFree 即可用。
 */

const axios = require("axios");
const CryptoJS = require("crypto-js");
const he = require("he");

// ---------------------------------------------------------------- 公共部分

const UA_PC =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1";

const TIMEOUT = 15000;

/** 随机生成一个国内 IP，酷我 / 酷狗对境外或机房 IP 有风控，必须伪装 */
function randomChinaIP() {
  const prefixes = [
    [116, 255], [116, 228], [218, 192], [124, 0],
    [14, 132], [183, 14], [58, 14], [113, 116], [120, 230]
  ];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  return `${p[0]}.${p[1]}.${1 + Math.floor(Math.random() * 254)}.${1 + Math.floor(Math.random() * 254)}`;
}

function spoofedHeaders(extra) {
  const ip = randomChinaIP();
  return Object.assign(
    { "X-Forwarded-For": ip, "X-Real-IP": ip },
    extra || {}
  );
}

function qs(obj) {
  return Object.keys(obj)
    .filter((k) => obj[k] !== undefined && obj[k] !== null)
    .map((k) => `${k}=${encodeURIComponent(obj[k])}`)
    .join("&");
}

function get(url, options) {
  return axios.get(url, Object.assign({ timeout: TIMEOUT, proxy: false }, options));
}

function post(url, body, options) {
  return axios.post(url, body, Object.assign({ timeout: TIMEOUT, proxy: false }, options));
}

/** 把秒数格式化成 03:45 */
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 去掉 HTML 标签与实体，酷狗搜索结果里带 <em> 高亮 */
function cleanText(s) {
  if (!s) return "";
  return he.decode(String(s).replace(/<[^>]*>/g, "")).trim();
}

/** id 编解码：source|主键|附加信息 */
function makeId(source, key, extra) {
  return [source, key, extra || ""].join("|");
}
function parseId(id) {
  const parts = String(id).split("|");
  return { source: parts[0], key: parts[1], extra: parts[2] || "" };
}

// ---------------------------------------------------------------- 千千音乐

const QIANQIAN_APPID = "16073360";
const QIANQIAN_SECRET = "0b50b02fd0d73a9c4c8c3a781c30845f";

/** 千千的签名：参数按 key 升序拼成 k=v&k=v，末尾拼 secret，取 md5 */
function qianqianSign(params) {
  params.timestamp = String(Math.floor(Date.now() / 1000));
  const raw =
    Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&") + QIANQIAN_SECRET;
  params.sign = CryptoJS.MD5(raw).toString(CryptoJS.enc.Hex);
  return params;
}

const qianqian = {
  async search(keyword, page) {
    const params = qianqianSign({
      word: keyword,
      type: "1",
      pageNo: String(page || 1),
      pageSize: "20",
      appid: QIANQIAN_APPID
    });
    const res = await get("https://music.91q.com/v1/search?" + qs(params), {
      headers: { "User-Agent": UA_PC, Referer: "https://music.91q.com/player" }
    });
    const list = (res.data && res.data.data && res.data.data.typeTrack) || [];
    const out = [];
    for (const item of list) {
      if (item.isVip && Number(item.isVip) !== 0) continue; // 会员曲目跳过
      const artists = (item.artist || []).map((a) => cleanText(a.name)).filter(Boolean);
      out.push({
        id: makeId("qianqian", item.TSID),
        title: cleanText(item.title),
        artist: artists.join(" / "),
        album: cleanText(item.albumTitle),
        artwork: item.pic || "",
        duration: Number(item.duration) || 0,
        source: "qianqian"
      });
    }
    return out;
  },

  async getMediaSource(key) {
    const rates = ["3000", "320", "128", "64"];
    for (const rate of rates) {
      const params = qianqianSign({ TSID: key, appid: QIANQIAN_APPID, rate });
      try {
        const res = await get("https://music.91q.com/v1/song/tracklink?" + qs(params), {
          headers: { "User-Agent": UA_PC, Referer: "https://music.91q.com/player" }
        });
        const data = (res.data && res.data.data) || {};
        const url = data.path || (data.trail_audio_info && data.trail_audio_info.path);
        if (url) return url;
      } catch (e) {
        // 换下一个码率
      }
    }
    throw new Error("千千音乐：未取到播放地址（可能是会员曲目）");
  },

  async getLyric(key) {
    const params = qianqianSign({ TSID: key, appid: QIANQIAN_APPID });
    const res = await get("https://music.91q.com/v1/song/info?" + qs(params), {
      headers: { "User-Agent": UA_PC, Referer: "https://music.91q.com/player" }
    });
    const lyricUrl = res.data && res.data.data && res.data.data[0] && res.data.data[0].lyric;
    if (!lyricUrl) return "";
    const lrc = await get(lyricUrl, { headers: { "User-Agent": UA_PC } });
    return typeof lrc.data === "string" ? lrc.data : "";
  }
};

// ---------------------------------------------------------------- 酷我音乐

const kuwo = {
  async search(keyword, page) {
    const pn = Math.max(0, (Number(page) || 1) - 1);
    const params = {
      vipver: "1", client: "kt", ft: "music", cluster: "0", strategy: "2012",
      encoding: "utf8", rformat: "json", mobi: "1", issubtitle: "1",
      show_copyright_off: "1", pn: String(pn), rn: "20", all: keyword
    };
    const res = await get("http://www.kuwo.cn/search/searchMusicBykeyWord?" + qs(params), {
      headers: spoofedHeaders({ "User-Agent": UA_PC })
    });
    const list = (res.data && res.data.abslist) || [];
    const out = [];
    for (const item of list) {
      if (Number(item.bitSwitch) === 0) continue;
      const rid = String(item.MUSICRID || "").replace("MUSIC_", "");
      if (!rid) continue;
      out.push({
        id: makeId("kuwo", rid),
        title: cleanText(item.SONGNAME),
        artist: cleanText(item.ARTIST),
        album: cleanText(item.ALBUM),
        artwork: item.hts_MVPIC || "",
        duration: Number(item.DURATION) || 0,
        source: "kuwo"
      });
    }
    return out;
  },

  async getMediaSource(key) {
    const qualities = ["128kmp3", "320kmp3", "flac"];
    for (const br of qualities) {
      const params = {
        f: "web",
        source: "kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk",
        from: "PC",
        type: "convert_url_with_sign",
        br,
        rid: key,
        user: "C_APK_" + Date.now() + Math.floor(Math.random() * 1000)
      };
      try {
        const res = await get("https://mobi.kuwo.cn/mobi.s?" + qs(params), {
          headers: spoofedHeaders({ "User-Agent": UA_PC })
        });
        const url = res.data && res.data.data && res.data.data.url;
        if (url) return url;
      } catch (e) {
        // 换下一个音质
      }
    }
    // 兜底：网页版接口
    try {
      const res = await get(
        "http://www.kuwo.cn/api/v1/www/music/playUrl?" + qs({ mid: key, type: "music", httpsStatus: "1" }),
        { headers: spoofedHeaders({ "User-Agent": UA_PC, Cookie: "kw_token=secret_token", Secret: "kuwo_web_secret" }) }
      );
      const url = res.data && res.data.data && res.data.data.url;
      if (url) return url;
    } catch (e) {
      // ignore
    }
    throw new Error("酷我音乐：未取到播放地址（可能是版权受限曲目）");
  },

  async getLyric(key) {
    const res = await get(
      "http://m.kuwo.cn/newh5/singles/songinfoandlrc?" + qs({ musicId: key, httpsStatus: "1" }),
      { headers: spoofedHeaders({ "User-Agent": UA_PC }) }
    );
    const lines = (res.data && res.data.data && res.data.data.lrclist) || [];
    if (!lines.length) return "";
    return lines
      .map((line) => {
        const sec = parseFloat(line.time) || 0;
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        const stamp = `[${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}]`;
        return stamp + (line.lineLyric || "");
      })
      .join("\n");
  }
};

// ---------------------------------------------------------------- 酷狗音乐

const kugou = {
  async search(keyword, page) {
    const params = {
      keyword,
      platform: "WebFilter",
      format: "json",
      page: String(page || 1),
      pagesize: "20",
      userid: "-1",
      clientver: "",
      tag: "em",
      filter: "2",
      iscorrection: "1",
      privilege_filter: "0",
      _: String(Date.now())
    };
    const res = await get("http://songsearch.kugou.com/song_search_v2?" + qs(params), {
      headers: spoofedHeaders({ "User-Agent": UA_PC })
    });
    const list = (res.data && res.data.data && res.data.data.lists) || [];
    const out = [];
    for (const item of list) {
      const hash = item.FileHash;
      if (!hash) continue;
      // 付费曲目（Privilege 10 / PayType 非 0）拿不到播放地址，直接过滤掉
      const privilege = Number(item.Privilege) || 0;
      const payType = Number(item.PayType) || 0;
      if (privilege >= 10 || (payType !== 0 && privilege > 8)) continue;
      out.push({
        id: makeId("kugou", hash, String(item.Duration || 0)),
        title: cleanText(item.SongName),
        artist: cleanText(item.SingerName),
        album: cleanText(item.AlbumName),
        artwork: item.Image ? String(item.Image).replace("{size}", "400") : "",
        duration: Number(item.Duration) || 0,
        source: "kugou"
      });
    }
    return out;
  },

  async getMediaSource(key) {
    // trackercdn 需要 md5(hash + 固定盐) 作为 key
    const attempts = [
      { salt: "kgcloudv2", br: "hq" },
      { salt: "kgcloudv2", br: "flac" },
      { salt: "kgcloud", br: "" }
    ];
    for (const a of attempts) {
      const key32 = CryptoJS.MD5(key + a.salt).toString(CryptoJS.enc.Hex);
      const params = a.br
        ? { hash: key, key: key32, br: a.br, appid: "1005", pid: "2", cmd: "25", behavior: "play" }
        : { cmd: "4", hash: key, key: key32, pid: "1", forceDown: "0", vip: "1" };
      const base = a.br ? "http://trackercdn.kugou.com/i/v2/?" : "http://trackercdn.kugou.com/i/?";
      try {
        const res = await get(base + qs(params), { headers: { "User-Agent": UA_MOBILE } });
        const url = Array.isArray(res.data && res.data.url) ? res.data.url[0] : res.data && res.data.url;
        if (url) return url;
      } catch (e) {
        // 换下一个通道
      }
    }
    throw new Error("酷狗音乐：未取到播放地址（该曲目需要付费或登录）");
  },

  async getLyric(key, extra) {
    let keyword = "";
    let duration = Number(extra) || 0;
    // 歌词检索必须带歌名，这里用 hash 反查一次歌曲信息
    try {
      const info = await get("http://m.kugou.com/app/i/getSongInfo.php?" + qs({ cmd: "playInfo", hash: key }), {
        headers: { "User-Agent": UA_MOBILE, Referer: "http://m.kugou.com" }
      });
      keyword = cleanText(info.data && info.data.songName);
      duration = Number(info.data && info.data.timeLength) || duration;
    } catch (e) {
      // 反查失败就只用 hash 检索
    }
    const searchRes = await get(
      "http://krcs.kugou.com/search?" + qs({ ver: "1", man: "yes", client: "mobi", keyword, duration, hash: key }),
      { headers: { "User-Agent": UA_MOBILE } }
    );
    const cand = (searchRes.data && searchRes.data.candidates && searchRes.data.candidates[0]) || null;
    if (!cand) return "";
    const dl = await get(
      "http://lyrics.kugou.com/download?" +
        qs({ ver: "1", client: "pc", id: cand.id, accesskey: cand.accesskey, fmt: "lrc", charset: "utf8" }),
      { headers: { "User-Agent": UA_MOBILE } }
    );
    const content = (dl.data && dl.data.content) || "";
    // 沙箱里没有 Buffer，用 crypto-js 解 base64
    return content ? CryptoJS.enc.Base64.parse(content).toString(CryptoJS.enc.Utf8) : "";
  }
};

// ---------------------------------------------------------------- 5sing（翻唱 / 古风 / 二次元）

const fivesing = {
  async search(keyword, page) {
    const params = {
      keyword,
      sort: "1",
      page: String(page || 1),
      filter: "0",
      type: "0"
    };
    const res = await get("http://search.5sing.kugou.com/home/json?" + qs(params), {
      headers: { "User-Agent": UA_PC }
    });
    const list = (res.data && res.data.list) || [];
    const out = [];
    for (const item of list) {
      const songId = item.songId;
      const typeEname = item.typeEname;
      if (!songId || !typeEname) continue;
      out.push({
        id: makeId("fivesing", songId, typeEname),
        title: cleanText(item.songName),
        artist: cleanText(item.singer),
        album: "",
        artwork: "",
        duration: item.songSize ? Math.floor((Number(item.songSize) * 8) / 320000) : 0,
        source: "fivesing"
      });
    }
    return out;
  },

  async getMediaSource(key, extra) {
    const songType = extra || "";
    const res = await get(
      "http://mobileapi.5sing.kugou.com/song/getSongUrl?" + qs({ songid: key, songtype: songType }),
      { headers: { "User-Agent": UA_PC } }
    );
    const data = (res.data && res.data.data) || {};
    // 优先无损，其次高品质，最后 mp3
    const url = data.squrl || data.squrl_backup || data.hqurl || data.hqurl_backup || data.url || data.lqurl;
    if (url) return url;
    throw new Error("5sing：未取到播放地址");
  },

  async getLyric(key, extra) {
    const res = await get(
      "http://mobileapi.5sing.kugou.com/song/newget?" + qs({ songid: key, songtype: extra || "" }),
      { headers: { "User-Agent": UA_PC } }
    );
    return (res.data && res.data.data && res.data.data.dynamicWords) || "";
  }
};

// ---------------------------------------------------------------- 咪咕音乐（华语主流，PQ 试听档免费）

const migu = {
  UA: "Android_migu/7.41.13",
  CHANNEL: "0146832",
  VERSION: "7.41.13",
  REFERER: "https://music.migu.cn/",

  headers() {
    return {
      "User-Agent": this.UA,
      Referer: this.REFERER,
      channel: this.CHANNEL,
      version: this.VERSION
    };
  },

  async search(keyword, page) {
    const params = {
      ua: "Android_migu",
      version: "5.0.1",
      text: keyword,
      pageNo: String(page || 1),
      pageSize: "20",
      searchSwitch: JSON.stringify({ song: 1, album: 0, singer: 0, tagSong: 0, mvSong: 0, songlist: 0, bestShow: 1 })
    };
    const res = await get("http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?" + qs(params), {
      headers: { "User-Agent": this.UA, Referer: this.REFERER }
    });
    const list = (res.data && res.data.songResultData && res.data.songResultData.result) || [];
    const out = [];
    for (const item of list) {
      const contentId = item.contentId;
      if (!contentId) continue;
      // 从 rateFormats/newRateFormats/audioFormats 里选一个可用的 format（优先 PQ 免费档）
      const formats = item.newRateFormats || item.rateFormats || item.audioFormats || [];
      const fmt = formats[0] || {};
      const resourceType = fmt.resourceType || item.resourceType || "2";
      const formatType = fmt.formatType || "PQ";

      // 歌手名：singers/artists 数组，或 singer 字段
      let artist = "";
      const singerArr = item.singers || item.artists || [];
      if (singerArr.length) artist = singerArr.map((s) => s.name).filter(Boolean).join(" / ");
      else artist = cleanText(item.singer || "");

      // 封面：imgItems 优先，否则 albumImgs，否则 img1
      let artwork = "";
      const imgs = item.imgItems || item.albumImgs || [];
      if (imgs.length) artwork = imgs[0].img || imgs[0].imageUrl || "";
      else artwork = item.img1 || item.img2 || item.img3 || "";

      // 专辑名
      let album = item.album || "";
      if (!album && item.albums && item.albums.length) album = item.albums[0].name || "";

      // id = contentId|resourceType|formatType，extra 存取流所需字段 + 歌词地址
      const extra = JSON.stringify({
        content_id: contentId,
        copyright_id: item.copyrightId || "",
        resource_type: resourceType,
        format_type: formatType,
        lyric: item.lyricUrl || item.trcUrl || ""
      });

      out.push({
        id: makeId("migu", contentId, extra),
        title: cleanText(item.name || item.songName),
        artist,
        album: cleanText(album),
        artwork,
        duration: Number(item.duration) || 0,
        source: "migu"
      });
    }
    return out;
  },

  async getMediaSource(key, extra) {
    let ex = {};
    try { ex = JSON.parse(extra || "{}"); } catch (e) { ex = {}; }
    const contentId = key;
    const copyrightId = ex.copyright_id || "";
    const resourceType = ex.resource_type || "2";

    // 音质优先级：PQ（免费）→ LQ → HQ → SQ（后两者多为会员，会自动失败）
    const tones = ["PQ", "LQ", "HQ", "SQ"];
    for (const tone of tones) {
      const params = {
        netType: "01",
        resourceType,
        contentId,
        toneFlag: tone
      };
      if (copyrightId) params.copyrightId = copyrightId;
      try {
        const res = await get(
          "https://c.musicapp.migu.cn/MIGUM2.0/v2.1/content/listen-url?" + qs(params),
          { headers: this.headers() }
        );
        const data = (res.data && res.data.data) || {};
        const url = data.url;
        if (url) return url;
      } catch (e) {
        // 换下一档
      }
    }
    throw new Error("咪咕音乐：未取到播放地址（可能是会员曲目）");
  },

  async getLyric(key, extra) {
    let ex = {};
    try { ex = JSON.parse(extra || "{}"); } catch (e) { ex = {}; }
    // 优先用搜索结果里自带的歌词地址
    let lyricUrl = ex.lyric || "";
    if (lyricUrl) {
      if (lyricUrl.indexOf("http") !== 0) lyricUrl = "https:" + lyricUrl;
      try {
        const res = await get(lyricUrl, { headers: { "User-Agent": UA_PC, Referer: "https://y.migu.cn/" } });
        if (typeof res.data === "string") return res.data;
      } catch (e) { /* 回退到 resourceinfo */ }
    }
    // 回退：resourceinfo 拿 lrcUrl
    try {
      const res = await get(
        "http://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?" + qs({ resourceId: key, resourceType: "2" }),
        { headers: { "User-Agent": this.UA, Referer: this.REFERER } }
      );
      const r = (res.data && res.data.resource && res.data.resource[0]) || {};
      const url = (r.lrcUrl || r.lyricUrl || "").replace(/^http:/, "https:");
      if (url) {
        const lrc = await get(url, { headers: { "User-Agent": UA_PC, Referer: "https://y.migu.cn/" } });
        return typeof lrc.data === "string" ? lrc.data : "";
      }
    } catch (e) { /* ignore */ }
    return "";
  }
};

// ---------------------------------------------------------------- Jamendo（免费版权音乐）

const jamendo = {
  UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  VERSION: "4gvfvv",

  /** 生成 x-jam-call 签名头：$sha1(path + 随机数) * 随机数 ~ */
  jamCall(path) {
    const rand = Math.random().toString();
    const digest = CryptoJS.SHA1(path + rand).toString(CryptoJS.enc.Hex);
    return "$" + digest + "*" + rand + "~";
  },

  headers(path) {
    return {
      "User-Agent": this.UA,
      Referer: "https://www.jamendo.com/search?q=musicdl",
      "x-jam-call": this.jamCall(path),
      "x-jam-version": this.VERSION,
      "x-requested-with": "XMLHttpRequest"
    };
  },

  async search(keyword, page) {
    const path = "/api/search";
    const res = await get(
      "https://www.jamendo.com/api/search?" +
        qs({ query: keyword, type: "track", limit: "20", identities: "www" }),
      { headers: this.headers(path) }
    );
    const list = Array.isArray(res.data) ? res.data : [];
    const out = [];
    for (const item of list) {
      if (!item.id) continue;
      const cover =
        (item.cover && item.cover.medium && item.cover.medium.url) ||
        (item.cover && item.cover.thumbnail && item.cover.thumbnail.url) ||
        "";
      // stream 直链带时效签名，必须在搜索时就取下来（URL 内是 %7C，不含裸 |，可安全存进 extra）
      const stream = item.stream || item.download || {};
      const streamUrl = stream.flac || stream.mp33 || stream.mp32 || stream.mp3 || stream.ogg || "";
      out.push({
        id: makeId("jamendo", String(item.id), streamUrl),
        title: item.name || "",
        artist: (item.artist && item.artist.name) || "",
        album: (item.album && item.album.name) || "",
        artwork: cover,
        duration: Number(item.duration) || 0,
        source: "jamendo"
      });
    }
    return out;
  },

  async getMediaSource(key, extra) {
    // 搜索时已把直链存进 extra，直接返回即可
    if (extra) return extra;
    throw new Error("Jamendo：未取到播放地址（直链已过期，请重新搜索）");
  },

  async getLyric() {
    // Jamendo 绝大多数是纯音乐/无歌词，直接返回空
    return "";
  }
};

// ---------------------------------------------------------------- 插件出口

const SOURCES = { qianqian, kuwo, kugou, migu, fivesing, jamendo };
const SOURCE_LABEL = { qianqian: "千千", kuwo: "酷我", kugou: "酷狗", migu: "咪咕", fivesing: "5sing", jamendo: "Jamendo" };

/** 三平台并发搜索，结果交错合并，避免同一平台刷屏 */
function interleave(groups) {
  const out = [];
  const max = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < max; i++) {
    for (const g of groups) {
      if (g[i]) out.push(g[i]);
    }
  }
  return out;
}

module.exports = {
  platform: "独立音源",
  version: "3.0.0",
  author: "本地构建",
  srcUrl: "",
  cacheControl: "no-cache",
  primaryKey: ["id"],
  supportedSearchType: ["music"],
  supportedMethod: ["search", "getMediaSource", "getLyric"],
  hints: {
    search: ["聚合千千、酷我、酷狗、咪咕、5sing、Jamendo 六个平台，无需登录、无需后台服务"]
  },

  async search(query, page, type) {
    if (type !== "music") {
      return { isEnd: true, data: [] };
    }
    const names = Object.keys(SOURCES);
    const results = await Promise.all(
      names.map((name) =>
        SOURCES[name]
          .search(query, page || 1)
          .catch(() => [])
      )
    );
    return {
      isEnd: true,
      data: interleave(results)
    };
  },

  async getMediaSource(mediaItem, quality) {
    const { source, key, extra } = parseId(mediaItem.id);
    const impl = SOURCES[source];
    if (!impl) throw new Error("未知音源：" + source);
    const url = await impl.getMediaSource(key, extra, quality);
    return { url };
  },

  async getLyric(mediaItem) {
    const { source, key, extra } = parseId(mediaItem.id);
    const impl = SOURCES[source];
    if (!impl) return { rawLrc: "" };
    try {
      const rawLrc = await impl.getLyric(key, extra);
      return { rawLrc: rawLrc || "" };
    } catch (e) {
      return { rawLrc: "" };
    }
  }
};

// 供本地自测使用（MusicFree 沙箱里 module.exports 之外的东西不会生效）
module.exports.__sources = SOURCES;
module.exports.__fmtDuration = fmtDuration;
