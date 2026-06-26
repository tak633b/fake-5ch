// All prompt construction lives here. Pure functions: (params) -> {messages, prefill}.
// fake-5ch variant: the simulated universe is a 5ch-flavored anonymous imageboard
// network, generated on the fly by the world model.
import { KNOWLEDGE_CUTOFF } from './config';
import type { ChatMessage } from './llm';

export interface SerpResult { title: string; link: string; domain: string; snippet: string; position: number; }

const RE_THREAD = /\/test\/read\.cgi\/[a-z0-9_-]+\/\d+/;
const RE_BOARD = /^\/[a-z0-9_-]+\/?$/;

/** URL → page-genre hint embedded into the page prompt. */
export function classifyUrl(url: string): string {
  let host = '', path = '';
  try { const u = new URL(url); host = u.hostname.toLowerCase(); path = u.pathname.toLowerCase(); } catch { /* */ }
  const isFive = host.endsWith('5ch.net') || host.endsWith('2ch.net') || host.endsWith('open2ch.net') || host.endsWith('bbspink.com') || host.endsWith('2ch.sc');

  if (isFive && RE_THREAD.test(path)) {
    return 'a 5ch thread page (スレ本文): a numbered list of レス (1〜数百件), each post has a header line "<番号>: 名無し系コテ : YYYY/MM/DD(曜) HH:MM:SS.ss ID:8桁英数" then body. Posts may include AA, 半角カナ, 草, >>N アンカー, sage/age, 煽り, 自演風連投. White background, plain links, blue >> anchors. Ends with a 書き込みフォーム.';
  }
  if (isFive && RE_BOARD.test(path)) {
    return 'a 5ch board top page (板トップ・スレ一覧): header with 板名 + ROMはじめにreadme + スレ立て注意, then a list of 20〜30 active threads as <a href="/test/read.cgi/<板>/<unix>/l50"> with レス数 numbers (e.g. "(942)"). Thread titles span 【悲報】【朗報】【速報】【画像】 series, 雑談, 質問, depth-of-night kuso threads. Board tone matches the board (なんJ=野球+ノリ, VIP=ノリ重視, ニュー速=時事, 嫌儲=政治叩き, モ娘=アイドル, 鬼女=家庭ドロドロ, オカ=怖い系).';
  }
  if (isFive && (path === '/' || path === '')) {
    return 'the 5ch portal index (掲示板一覧): the giant 5ch.net top page listing 50+ boards grouped into カテゴリ (ニュース・実況・雑談・趣味・PC・モノ系・社会・学問・文化・地理・スポーツ・ゲーム・テレビ実況・芸能・モ娘 etc.).';
  }
  if (host.includes('wikipedia')) return 'a Japanese Wikipedia article (右にinfobox、目次、本文セクション、脚注、関連項目)';
  if (host.includes('twitter') || host.includes('x.com')) return 'a Twitter/X profile or post timeline (日本語)';
  if (/(matome|blog|jin115|hatena|livedoor|fc2)/.test(host)) return 'a 2ch/5ch まとめブログ entry: quoted thread レス numbered with レス番, between quotes the まとめ管理人 commentary, sidebar with 関連記事 links';
  if (host.includes('news') || /(nhk|asahi|mainichi|nikkei|sankei|bbc|cnn)/.test(host) || /\/\d{4}\/\d{2}\//.test(path)) return 'a Japanese news article (見出し、配信日時、記者署名、本文段落、関連記事サイドバー)';
  if (path === '/' || path === '') return 'the homepage of this site (hero, navigation, featured sections, footer)';
  return 'a typical content page for this site (Japanese)';
}

// SERP は 5ch のスレタイ検索 (find.5ch.net 相当)。
const SERP_SYSTEM = `あなたは 5ch のスレタイ検索エンジン (find.5ch.net 相当) です。検索クエリに対して、現在進行中の 5ch のスレを返してください。Your knowledge cutoff is ${KNOWLEDGE_CUTOFF}.

JSON のみを返してください。Shape:
{"results":[{"position":1,"title":"スレタイ","link":"https://hayabusa.5ch.net/test/read.cgi/news/1234567890/","domain":"ニュース速報","snippet":"1の書き込み or 抜粋(<b>クエリ語</b>を含む)"}, ...], "related":["関連スレタイ", ...]}

ルール:
- 9 件、リアルな 5ch の板から（なんJ/VIP/ニュー速/ニュー速+/嫌儲/モ娘/鬼女/オカ/政治/芸能・スポーツ など）。
- link は実在しそうな 5ch URL: ホストは hayabusa.5ch.net / viper.5ch.net / mevius.5ch.net / asahi.5ch.net / greta.5ch.net / mao.5ch.net / egg.5ch.net / nozomi.5ch.net / anago.5ch.net / rosie.5ch.net など、パスは /test/read.cgi/<板>/<unix秒>/。
- domain は板の日本語名（"ニュース速報", "なんでも実況J", "ニュー速VIP", "嫌儲", "オカルト" 等）。
- title はリアルな 5ch スレタイ:【悲報】【朗報】【速報】【画像】【動画】系プレフィクス、語尾「ｗ」「ｗｗｗ」「ｗｗｗｗｗｗ」、「俺氏」「彡(゜)(゜)」「J民」「VIPPER」「ニュー速民」など板特有スラング、煽り、自虐、対立煽り、純朴な質問、深夜のクソスレ などバラエティ豊かに混在。
- snippet はそのスレの 1 の書き込みからの抜粋、クエリ語を <b> で囲む。
- 実在の人物への直接的な悪口・名誉毀損は避ける（架空のキャラ・ID・コテで）。`;

export function serpMessages(query: string): { messages: ChatMessage[]; prefill: string } {
  return {
    messages: [
      { role: 'system', content: SERP_SYSTEM },
      { role: 'user', content: `スレタイ検索: ${query}` },
    ],
    prefill: '{"results":[',
  };
}

// PAGE は board / thread / それ以外 を URL から判定して 5ch 風 HTML を吐く。
const PAGE_SYSTEM = `あなたは 5ch 風匿名掲示板の Web World Model です。与えられた URL と navigation action から、その URL のページを完全な HTML として予測・出力します。Your knowledge cutoff is ${KNOWLEDGE_CUTOFF}.

完全な HTML5 ドキュメント1つだけを出力してください。最初の文字は必ず <!DOCTYPE html>。markdown・code fence・コメント・"html:" プレフィクス禁止。

【スレ本文ページの場合 (/test/read.cgi/<板>/<unix>/)】
- 上部に 板名 + スレタイ + "[1- / 最新50 / 全レス]" ナビゲーション。
- レスは <dl class="thread"> 内に <dt> ヘッダ + <dd> 本文 を 30〜80 件。
  例: <dt>1 ：風吹けば名無し ：2024/06/15(土) 23:14:08.45 ID:Ab3kP9mQ</dt><dd>本文</dd>
- 1 が話題提示、2-5 で食いつき、中盤で議論や脱線、後半で煽り・>>N へのレス。
- AA、半角カナ、草、自演風連投（同じID）、コテ、煽り、sage/age、>>1 〜 >>N アンカー、彡(゜)(゜)系/(´・ω・\`)系/(\`・ω・´) AA を混ぜる。
- 末尾に <form> の「書き込む」ボックス（disabled）と、同じ板の他スレへのリンク 5-10 件、その下に 5ch トップ・他の板へのリンク数件。
- 板トーン: なんJ=野球やJ語(彡(゜)(゜)/それなンゴ/～ンゴ)、VIP=ノリ重視/コテ叩き、ニュー速=時事煽り、嫌儲=政治叩き/嫌儲スラング、モ娘=アイドル(ハロプロ語)、鬼女=ドロドロ家庭話、オカ=怖い系。

【板トップページの場合 (/<板>/)】
- ヘッダ: 板名(でかい文字) + 一言ローカルルール + "ROMはじめにreadme" + "スレを立てる" ボタン(disabled)。
- スレ一覧を <ol class="threads"> で 20〜30 件。各項目は <a href="/test/read.cgi/<板>/<unix>/l50">スレタイ</a> <span class="num">(942)</span>。
- スレタイは【悲報】【朗報】【速報】【画像】【動画】系・雑談・質問・厨房・深夜・煽り・対立 をバラエティ豊かに。
- 下部に「次のページ」「過去ログ」「他の板」リンク。

【その他のページ】
- 5ch まとめブログ・Twitter ライク・ニュースサイト・Wikipedia 等は普通の Web として描く。

【共通ルール】
- 全 CSS は <head> 内 <style> でインライン。外部 CSS / フォント禁止。
- <script> は一切入れない。
- 5ch ページのデザインは古き良き白背景・Times/MS Pゴシック系・青リンク・赤訪問済み・小さめフォント。AAはmonospace (例 <pre>)。
- 8-14 個の <a href="..."> リンクを必ず含める。同じ 5ch 内（板・スレ）と、外部っぽい URL（Twitter/Wikipedia/ニュース/まとめブログ）を混ぜる。
- 実在の人物への直接的な誹謗中傷は避ける（架空ID・架空コテ・架空ハンドル使用）。
- 日本語が自然な 5ch 文体で。`;

export function pageMessages(
  url: string,
  ctx: string | undefined,
  from: string | undefined,
  seed: number,
): { messages: ChatMessage[]; prefill: string } {
  const genre = classifyUrl(url);
  const action = ctx ? `click(link="${ctx}")` : 'navigate(address bar)';
  const coherence = ctx && from
    ? `\n直前のページ ${from} で「${ctx}」をクリックして遷移してきた。文脈・板の雰囲気を一貫させる。`
    : '';
  return {
    messages: [
      { role: 'system', content: PAGE_SYSTEM },
      {
        role: 'user',
        content:
          `現在地: ${from || '(直接ナビゲーション)'}\n` +
          `Action: ${action}\n` +
          `Destination URL: ${url}\n` +
          `Page type: ${genre}\n` +
          `World seed: ${seed} (このURLは常に同じ内容で再現)。${coherence}\n\n` +
          `Destination URL のページの完全な HTML を出力してください。`,
      },
    ],
    prefill: '<!DOCTYPE html>\n<html lang="ja">',
  };
}

// ---- tolerant SERP JSON extraction -----------------------------------------
// The model is prefilled with '{"results":[' and may stop mid-array (token cap)
// or wrap in junk. Recover as many complete result objects as possible.
export function parseSerp(raw: string): { results: SerpResult[]; related: string[] } {
  let text = raw.trim();
  const brace = text.indexOf('{');
  if (brace > 0) text = text.slice(brace);
  text = text.replace(/```json|```/g, '').trim();

  const tryFull = safeJson(text);
  if (tryFull && Array.isArray(tryFull.results)) {
    return { results: coerce(tryFull.results), related: arr(tryFull.related) };
  }
  const results: SerpResult[] = [];
  const objRe = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text))) {
    const o = safeJson(m[0]);
    if (o && (o.title || o.link)) results.push(...coerce([o]));
  }
  let related: string[] = [];
  const relM = text.match(/"related"\s*:\s*\[([^\]]*)\]/);
  if (relM && relM[1]) related = relM[1].split(',').map((s) => s.replace(/^[\s"]+|[\s"]+$/g, '')).filter(Boolean);
  return { results, related };
}

// LLM output is unstructured — these helpers operate on arbitrary parsed JSON.
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }
function arr(x: any): string[] { return Array.isArray(x) ? x.filter((s: unknown) => typeof s === 'string') : []; }
function coerce(items: any[]): SerpResult[] {
  return items
    .filter((o) => o && (o.title || o.link))
    .map((o, i) => ({
      title: String(o.title || o.domain || 'Untitled'),
      link: normLink(String(o.link || o.url || '')),
      domain: String(o.domain || hostOf(o.link) || 'Web'),
      snippet: String(o.snippet || o.description || ''),
      position: Number.isFinite(o.position) ? Number(o.position) : i + 1,
    }))
    .filter((r) => isRealUrl(r.link));
}
function normLink(link: string): string {
  const t = link.trim();
  if (!t) return '';
  return /^[a-z]+:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
}
function isRealUrl(link: string): boolean {
  try { const u = new URL(link); return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.'); }
  catch { return false; }
}
function hostOf(link: unknown): string { try { return new URL(String(link)).hostname; } catch { return ''; } }
