/**
 * hCaptcha「无障碍挑战」自动过 —— 纯文本问答，不需要视觉模型、不需要打码平台。
 *
 * 实测（2026-11，chat.deepseek.com 注册页）：
 *   hCaptcha 的挑战面板右上「⋮」菜单里有 `Accessibility Challenge`，
 *   点开后题目从「选图/拖拽」变成**自然语言问答**，3 题一组，例如：
 *     - What do you use to wash your hair?          -> shampoo
 *     - A box holds 16 chocolates, 4 are inside. How many more can fit? -> 12
 *     - Is olive oil from olives?                   -> yes
 *   答完点 Verify 即出 token（写进 textarea[name=h-captcha-response]）。
 *
 * 关键约束：**必须快**。challenge/rqdata 有时间窗，人工往返十几秒一轮必被判
 * 「Please try again」。所以这里全用选择器驱动 + fill 直填，3 题压进 1~2 秒。
 *
 * 本模块只做「交互 + 取 token」，识别由调用方注入的 `ask(question)` 提供：
 *   - makeAsk({ engine })     规则/算术优先，未命中问 engine（文本模型，最省）
 *   - 也可以直接传自己的函数
 */

/** 挑战面板里题目文字的容器（实测 id 稳定） */

/* -------------------------------------------------------------------------- *
 * 题目清洗：hCaptcha 的无障碍题会把「请用一个词回答」的说明和**上百个语言名**
 * 拼在同一段文本里发过来（"...have? Afrikaans Albanian Amharic ..."）。
 * 直接喂给模型会让它抓错重点、也更容易输出错格式。
 * -------------------------------------------------------------------------- */

const LANG_NAMES = new Set(
  ('afrikaans albanian amharic arabic armenian azerbaijani basque belarusian bengali bosnian burmese catalan cebuano ' +
    'chinese croatian czech danish dutch esperanto estonian finnish french frisian gaelic galacian georgian german greek ' +
    'gujurati haitian hausa hawaiian hebrew hindi hmong hungarian icelandic igbo indonesian irish italian japanese ' +
    'javanese kannada kazakh khmer kinyarwanda kirghiz korean kurdish lao latin latvian lithuanian luxembourgish ' +
    'macedonian malagasy malay malayalam maltese maori marathi mongolian nepali norwegian nyanja oriya persian polish ' +
    'portuguese pashto punjabi romanian russian samoan shona sindhi sinhalese serbian slovak slovenian somali sotho ' +
    'spanish sundanese swahili swedish tagalog tajik tamil tatar teluga thai turkish turkmen uyghur ukrainian urdu ' +
    'uzbek vietnamese welsh xhosa yiddish yoruba zulu brazil simplified traditional')
    .split(/\s+/),
);

/** 去掉那一长串语言名（连续的、≥3 个都命中语言表才算） */
function stripLanguageList(text) {
  const tokens = String(text || '').split(/\s+/);
  const out = [];
  let run = 0;
  for (const tok of tokens) {
    const key = tok.toLowerCase().replace(/[^a-z]/g, '');
    if (LANG_NAMES.has(key)) {
      run += 1;
      continue;
    }
    if (run >= 3) {
      // 整段语言名丢掉
    } else if (run > 0) {
      out.push(...tokens.slice(Math.max(0, out.length - 0), out.length)); // 保留前文，不补回
    }
    run = 0;
    out.push(tok);
  }
  return out.join(' ');
}

/**
 * 把 hCaptcha 的题面清洗成「真正的那个问题」。
 * 同时抽出 "Answer in English:" 这类语言指令。
 */
export function cleanQuestion(raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();

  // 语言指令
  const langMatch = /answer in ([a-z ]{3,20}):/i.exec(text);
  const lang = langMatch ? langMatch[1].trim().toLowerCase() : '';

  // 去掉「请用一个词回答」这类模板句
  text = text.replace(/please use a single word,? number,? or phrase in your answer to the following question[.:]?/gi, ' ');
  text = text.replace(/answer in [a-z ]{3,20}:/gi, ' ');

  // 去掉语言名录
  text = stripLanguageList(text);

  // 去重模板噪音
  text = text.replace(/\s+/g, ' ').trim();

  // 只保留第一个问句（到 ? / ？ 为止）
  const q = /([^?？]{3,200}[?？])/.exec(text);
  const core = q ? q[1].trim() : text;
  return { question: core, lang };
}

const EN_WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'];
const ZH_WORDS = ['零','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];

/** hCaptcha 对 "how many ..." 这类题更喜欢**单词形式**（4 被判错、four 才过） */
export function spellNumber(n, lang = 'en') {
  const num = Number(String(n).trim());
  if (!Number.isFinite(num) || num < 0 || num > 20) return String(n).trim();
  return lang === 'zh' ? ZH_WORDS[num] : EN_WORDS[num];
}

/** 题目是否在问数量（这类题要输出单词） */
export function asksHowMany(question) {
  return /how many|how much|number of|几个|多少|几只|几条|几位/i.test(String(question || ''));
}

const Q_SEL = '#prompt-question';
/** 文本输入框 */
const INPUT_SEL = 'input.input-field';
/** 「⋮」更多选项按钮；aria-label 会随 widget 语言变，用包含匹配 */
const MENU_BTN =
  'button[aria-label*="Accessibility"], button[aria-label*="无障碍"], button[aria-label*="hCaptcha"], button[aria-label*="hcaptcha"]';
const A11Y_ITEM = /accessibility challenge|无障碍挑战|无障碍验证/i;
const NEXT_TEXTS = ['next', 'verify', 'submit', 'continue', '下一题', '下一步', '确认', '确认提交', '验证', '提交', '确定'];

export function findChallengeFrame(page) {
  const frames = page.frames().filter((f) => (f.url() || '').includes('hcaptcha.html'));
  if (!frames.length) return null;
  // 挑战帧是带 #frame=... 的那个；勾选框帧 url 里没有 hcaptcha.html 的 hash 段
  const challenge = frames.find((f) => (f.url() || '').includes('#frame='));
  return challenge || frames[frames.length - 1];
}

/** 读当前题目：正文里以 ?/？ 结尾的那一行（#prompt-question 只是指令头） */
export async function readQuestion(frame) {
  const body = await frame.evaluate(() => document.body.innerText || '').catch(() => '');
  const CHROME = /^(question\s*\d+ of \d+|第\s*\d+\s*题|please try again\.?|请重试|skip|en|verify|next|confirm|提交|确认|语言).*$/i;
  const lines = body
    .split('\n')
    .map((l) => l.replace(/\t/g, '').trim())
    .filter((l) => l && !/please try again|请重试|\u26a0/i.test(l) && !CHROME.test(l));
  if (!lines.length) return '';
  // 全拼：指令行 + 数字行 + 问句行都要，算术题的数字常在单独一行
  return lines.join(' ').trim();
}

export async function readToken(page) {
  const viaWidget = await page
    .evaluate(() => {
      try {
        return (window.hcaptcha && window.hcaptcha.getResponse && window.hcaptcha.getResponse()) || '';
      } catch {
        return '';
      }
    })
    .catch(() => '');
  if (viaWidget) return viaWidget;
  return page
    .evaluate(
      () =>
        document.querySelector('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]')?.value || '',
    )
    .catch(() => '');
}

async function hasInput(frame) {
  return frame ? !!(await frame.$(INPUT_SEL).catch(() => null)) : false;
}

/** 切到无障碍挑战；已经是无障碍题时直接返回 true */
export async function enterA11y(frame, log = console) {
  if (await hasInput(frame)) return true;
  // 开菜单（aria-label 匹配不到就退化成「最后一个 button」）
  const opened = await (async () => {
    const btn = await frame.$(MENU_BTN).catch(() => null);
    if (btn) {
      await btn.click().catch(() => {});
      return true;
    }
    const buttons = await frame.$$('button');
    if (buttons.length) {
      await buttons[buttons.length - 2 >= 0 ? buttons.length - 2 : 0].click().catch(() => {});
      return true;
    }
    return false;
  })();
  if (!opened) return false;
  await new Promise((r) => setTimeout(r, 250));

  // 点菜单项
  try {
    await frame.getByText(A11Y_ITEM).first().click({ timeout: 2500 });
  } catch {
    const items = await frame.$$('div.option, li, a, div[role="menuitem"]');
    for (const it of items) {
      const t = ((await it.innerText().catch(() => '')) || '').trim();
      if (A11Y_ITEM.test(t)) {
        await it.click().catch(() => {});
        break;
      }
    }
  }

  // 等输入框出现
  for (let i = 0; i < 40; i += 1) {
    if (await hasInput(frame)) {
      log.info?.('hCaptcha 已切到无障碍挑战');
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function clickNext(frame) {
  const els = await frame.$$('div.button, button');
  for (const el of els) {
    const t = ((await el.innerText().catch(() => '')) || '').trim().toLowerCase();
    if (NEXT_TEXTS.includes(t)) {
      await el.click().catch(() => {});
      return true;
    }
  }
  return false;
}

async function clickSkip(frame) {
  // 先用 aria-label（实测最稳）
  const byAria = await frame.$('[aria-label^="Skip Challenge"], [aria-label*="跳过"]').catch(() => null);
  if (byAria) {
    await byAria.click().catch(() => {});
    return true;
  }
  const els = await frame.$$('div.button, button');
  for (const el of els) {
    const t = ((await el.innerText().catch(() => '')) || '').trim().toLowerCase();
    if (t === 'skip' || t.includes('跳过')) {
      await el.click().catch(() => {});
      return true;
    }
  }
  return false;
}

/**
 * 主入口：自动完成后返回 token；失败抛错。
 *
 * @param {import('playwright').Page} page 注册页
 * @param {object} opts
 * @param {(q: string) => Promise<string>} opts.ask 答题函数
 * @param {object} [opts.log]
 * @param {number} [opts.rounds] 最多换几批（默认 4）
 * @param {number} [opts.questions] 每批题数（hCaptcha 固定 3）
 */
export async function solveA11y(page, { ask, log = console, rounds = 4, questions = 3 } = {}) {
  if (typeof ask !== 'function') throw new Error('solveA11y 需要 ask(question) 函数');
  const stats = { batches: 0, questions: [] };

  // 等挑战帧渲染（点完「发送验证码」到 widget 弹出有几秒延迟）
  let waited = null;
  for (let i = 0; i < 150; i += 1) {
    waited = findChallengeFrame(page);
    if (waited) break;
    await page.waitForTimeout(100);
  }
  if (!waited) throw new Error('没找到 hCaptcha 挑战帧（15s 内未出现）');

  for (let r = 0; r < rounds; r += 1) {
    const frame = findChallengeFrame(page);
    if (!frame) throw new Error('没找到 hCaptcha 挑战帧');
    if (!(await enterA11y(frame, log))) {
      log.warn?.('切无障碍挑战失败，尝试下一轮');
      await clickSkip(frame);
      await page.waitForTimeout(600);
      continue;
    }
    stats.batches += 1;

    let ok = true;
    for (let i = 0; i < questions; i += 1) {
      const f = findChallengeFrame(page);
      const q = await readQuestion(f);
      if (!q) {
        ok = false;
        break;
      }
      const a = await ask(q);
      stats.questions.push({ q, a });
      if (!a) {
        log.warn?.('题目未识别，换一批', { q });
        ok = false;
        break;
      }
      const input = await f.$(INPUT_SEL).catch(() => null);
      if (!input) {
        ok = false;
        break;
      }
      await input.click().catch(() => {});
      await input.fill(String(a)).catch(() => {});
      const val = await input.inputValue().catch(() => '');
      const prog = (await f.evaluate(() => document.body.innerText || '')).match(/Question\s*(\d)\s*of\s*(\d)/i);
      await page.waitForTimeout(120);
      await clickNext(f);
      await page.waitForTimeout(250);
      const prog2 = (await (findChallengeFrame(page)?.evaluate(() => document.body.innerText || '') || Promise.resolve('')).catch(() => '')).match(/Question\s*(\d)\s*of\s*(\d)/i);
      log.info?.(`  fmt q=${prog ? prog[1] + '/' + prog[2] : '?'} value=${JSON.stringify(val)} -> after=${prog2 ? prog2[1] + '/' + prog2[2] : '?'}`);
      const tok = await readToken(page);
      if (tok) return { token: tok, stats };
    }

    if (!ok) {
      const f = findChallengeFrame(page);
      const lastQ = stats.questions[stats.questions.length - 1]?.q;
      const again = lastQ && stats.questions.filter((x) => x.q === lastQ).length > 1;
      if (f) {
        if (again) await f.click('[aria-label^="Refresh Challenge"]', { timeout: 1500 }).catch(() => {});
        else await clickSkip(f);
      }
      await page.waitForTimeout(800);
      continue;
    }

    // 第 3 题的 clickNext 已经点了 Verify（交卷）。这里**只轮询，不要再点一次**，
    // 重复点 Verify 会把刚提交的挑战重置成新一批，是之前一直过不去的根因。
    for (let i = 0; i < 60; i += 1) {
      await page.waitForTimeout(200);
      const tok = await readToken(page);
      if (tok) return { token: tok, stats };
    }
    const f = findChallengeFrame(page);
    if (f) await clickSkip(f);
    await page.waitForTimeout(600);
  }
  throw new Error(`无障碍挑战未通过（${stats.batches} 批，${stats.questions.length} 题）`);
}

// ---------------------------------------------------------------- 答题器

/** 算术/常识规则表：命中就不花模型 token，毫秒级 */
const RULES = [
  [/wash your hair/i, 'shampoo'],
  [/round and red .*vegetable/i, 'tomato'],
  [/grain .*(milled into white powder|flour for bread)/i, 'wheat'],
  [/moving snow down a mountain/i, 'avalanche'],
  [/flows? down from mountains? to the sea/i, 'river'],
  [/material .*bottles? made of/i, 'glass'],
  [/is olive oil from olives/i, 'yes'],
  [/capital of france/i, 'paris'],
  [/capital of japan/i, 'tokyo'],
  [/days in a week/i, '7'],
  [/months in a year/i, '12'],
  [/letters in the (english )?alphabet/i, '26'],
  [/minutes in an hour/i, '60'],
  [/seconds in a minute/i, '60'],
  [/hours in a day/i, '24'],
  [/legs does a spider/i, '8'],
  [/legs does an? insect/i, '6'],
  [/legs does a (dog|cat)/i, '4'],
  [/fingers .*(hand|two)/i, '10'],
  [/says (meow|喵)/i, 'cat'],
  [/says (woof|bark|汪汪)/i, 'dog'],
  [/largest (ocean|sea)/i, 'pacific'],
  [/closest star/i, 'sun'],
  [/planet .*(we live|third)/i, 'earth'],
  [/color .*sky/i, 'blue'],
  [/color .*grass/i, 'green'],
  [/color .*(snow|milk)/i, 'white'],
  [/what do (you|we) (use|drink) .*(thirst|water)/i, 'water'],
  // --- 常识家族（无障碍题库高频） ---
  [/balls? of snow/i, 'snowman'],
  [/falls from your eyes/i, 'tears'],
  [/horizontal steps you climb/i, 'stairs'],
  [/what do (you|we) (wear|use) .*(sun|bright)/i, 'sunglasses'],
  [/what do (you|we) (use|need) .*(see) in the dark/i, 'light'],
  [/what (covers|falls on) .*ground in winter/i, 'snow'],
  [/what (do|does) (you|we) (use|need) to (write|writing)/i, 'pen'],
  [/what tool .*(cut|chop)/i, 'knife'],
  [/what .*use to (sweep|clean the floor)/i, 'broom'],
  [/what .*use to (dry|wipe) (your body|after shower)/i, 'towel'],
  [/what .*use to (brush your teeth)/i, 'toothbrush'],
  [/what .*use to (comb|brush) your hair/i, 'comb'],
  [/what .*use to (tell|measure) (the )?time/i, 'clock'],
  [/what .*use to (open|unlock) a door/i, 'key'],
  [/what .*(lives|grows) in water and has gills/i, 'fish'],
  [/what animal .*(barks|woof)/i, 'dog'],
  [/what animal .*(meows|purrs)/i, 'cat'],
  [/what animal .*(moos|cow)/i, 'cow'],
  [/what animal .*(neighs|horse)/i, 'horse'],
  [/what animal .*black and white.*bamboo/i, 'panda'],
  [/what animal .*(trunk).*(large ears)/i, 'elephant'],
  [/what (insect|animal) .*(honey|buzz|beehive)/i, 'bee'],
  [/what (insect|animal) .*(web|eight legs)/i, 'spider'],
  [/what (bird) .*(cannot fly|ice|antarctic)/i, 'penguin'],
  [/what (fruit) .*(yellow|peel|monkey)/i, 'banana'],
  [/what (fruit) .*(red|tree|doctor)/i, 'apple'],
  [/what (fruit) .*(green|sour|pear)/i, 'pear'],
  [/what (fruit) .*(summer|juicy|watermelon)/i, 'watermelon'],
  [/what (drink) .*(cow|white|calcium)/i, 'milk'],
  [/what (drink) .*(bean|hot|morning)/i, 'coffee'],
  [/what (drink) .*(leaves|tea|hot water)/i, 'tea'],
  [/what .*use to (sit|lying down) .*(sleep)/i, 'bed'],
  [/what .*(four legs).*(sit|eat|table)/i, 'chair'],
  [/what .*(rain|wet weather).*(cover|hold over your head)/i, 'umbrella'],
  [/what .*(carry|school).*(books|back)/i, 'backpack'],
  [/what (vehicle) .*(rails|tracks)/i, 'train'],
  [/what (vehicle) .*(fly|wings|air)/i, 'airplane'],
  [/what (vehicle) .*(sea|water|float)/i, 'ship'],
  [/what (vehicle) .*(two wheels|pedals)/i, 'bicycle'],
  [/how many (are|is) in a (dozen)/i, '12'],
  [/what (color) .*(blood)/i, 'red'],
  [/what (color) .*(egg shell|cloud|milk)/i, 'white'],
  [/what (color) .*(lemon|banana)/i, 'yellow'],
  [/what (color) .*(leaf|grass|tree)/i, 'green'],
  [/what (color) .*(night|coal|sky at night)/i, 'black'],
  [/what (color) .*(orange).*(fruit)/i, 'orange'],
  [/who (wrote|author) .*romeo and juliet/i, 'shakespeare'],
  [/what (is|are) the largest (planet)/i, 'jupiter'],
  [/what (planet) .*(red)/i, 'mars'],
  [/what (star) .*(closest|nearest)/i, 'sun'],
  [/what (ocean) .*(largest|biggest)/i, 'pacific'],
  [/what (is) (water) (frozen|solid)/i, 'ice'],
  [/what (comes|falls) (down|out) from clouds/i, 'rain'],
  [/what (do|does) (fire) (produce|give)/i, 'smoke'],
  [/what .*(boils) .*100/i, 'water'],
  [/what (grows|plant) .*(tall|yellow flower)/i, 'sunflower'],
  [/what (instrument) .*(keys|piano music)/i, 'piano'],
  [/what (instrument) .*(strings|bow)/i, 'violin'],
  [/what (do|does) (you) (call) .*baby cat/i, 'kitten'],
  [/what (do|does) (you) (call) .*baby dog/i, 'puppy'],
  [/what .*(king of the jungle|lion)/i, 'lion'],
  [/what (is) (the) (fastest) (land) (animal)/i, 'cheetah'],
  [/is .*spider an insect/i, 'no'],
  [/is (the )?sun a (star|planet)/i, 'star'],
  [/does (the )?moon (make|produce) its own light/i, 'no'],
  [/can (fish|it) (swim|breathe underwater)/i, 'yes'],
  [/is olive oil from olives/i, 'yes'],
  [/what (is) (the) (opposite) of (hot)/i, 'cold'],
  [/what (is) (the) (opposite) of (big)/i, 'small'],
  [/what (is) (the) (opposite) of (day)/i, 'night'],
  [/what (is) (the) (opposite) of (up)/i, 'down'],
  [/what color is vanilla ice ?cream/i, 'white'],
  [/what color is chocolate/i, 'brown'],
  [/what color is (a )?strawberry/i, 'red'],
  [/what color is (a )?blueberry/i, 'blue'],
  [/salt'?s? taste/i, 'salty'],
  [/cooking bread in a toaster|what do you call.*(toast)/i, 'toasting'],
  [/machine washes clothes|washes clothes/i, 'washing machine'],
  [/body part inside your mouth.*(eat|chew)/i, 'tongue'],
  [/body part .*(pumps|pump) blood/i, 'heart'],
  [/body part .*(breathe|breathing)/i, 'lungs'],
  [/body part .*(see|sight)/i, 'eyes'],
  [/body part .*(hear|hearing)/i, 'ears'],
  [/body part .*(smell)/i, 'nose'],
  [/body part .*(chew|teeth|bite)/i, 'teeth'],
  [/body part .*(hold|grab|carry)/i, 'hands'],
  [/body part .*(walk|stand|run)/i, 'legs'],
  [/body part .*(think|brain)/i, 'brain'],
  [/body part .*(taste)/i, 'tongue'],
  [/animal .*humps? on its back/i, 'camel'],
  [/\bis\s+.+?\s+similar to\b/i, 'yes'],
  [/\bare\s+.+?\s+similar to\b/i, 'yes'],
  [/animal .*(long neck|tallest)/i, 'giraffe'],
  [/animal .*(stripes|black and white stripes)/i, 'zebra'],
  [/animal .*(mane|roar|king)/i, 'lion'],
  [/animal .*(shell|slow)/i, 'turtle'],
  [/animal .*(hop|pouch|kangaroo)/i, 'kangaroo'],
  [/animal .*(fly at night|sonar|bat)/i, 'bat'],
  [/animal .*(wool|sheep)/i, 'sheep'],
  [/animal .*(milk|moo)/i, 'cow'],
  [/animal .*(oink|pig)/i, 'pig'],
  [/animal .*(cluck|eggs|chicken)/i, 'chicken'],
  [/animal .*(quack|duck)/i, 'duck'],
  [/round snack .*hole in the middle|glazed .*donut/i, 'donut'],
  [/body part connects your head to your body/i, 'neck'],
  [/valley (low or high|high or low)/i, 'low'],
  [/color is paprika/i, 'red'],
  [/hobby .*(fold|folding) paper/i, 'origami'],
  [/(opens and closes|enter|exit).*(room|house)/i, 'door'],
  [/lets light into a room/i, 'window'],
  [/tells the temperature outside/i, 'thermometer'],
  [/holds water in a bathroom/i, 'bathtub'],
  [/grain .*oatmeal|oatmeal .*grain/i, 'oats'],
  [/grain .*(rice|sushi)/i, 'rice'],
  [/grain .*(popcorn)/i, 'corn'],
  [/color is (a )?(carrot)/i, 'orange'],
  [/color is (a )?(eggplant)/i, 'purple'],
  [/color is (a )?(cucumber)/i, 'green'],
  [/(lava|fire|sun|boiling water|oven)\b.*\b(hot or cold|cold or hot)\b/i, 'hot'],
  [/(ice|snow|freezer|fridge)\b.*\b(hot or cold|cold or hot)\b/i, 'cold'],
  [/is (a )?valley .*\b(low|high)\b/i, 'low'],
  [/mountain .*(high|low) land/i, 'high'],
  [/\bis (a |an )?(valley|lowland)\b.*\b(low|high)\b/i, 'low'],
  [/what (is) (a )?(large )?(body of )?(salt )?water .*(surrounded by land)/i, 'lake'],
  [/what (is) (a )?(large )?land .*(surrounded by water)/i, 'island'],
  [/what (is) (a )?(dry|sandy) .*(region|land) .*(little rain)/i, 'desert'],
  [/what (is) (a )?(very )?(tall) (landform|rock) .*(steep)/i, 'mountain'],
  [/frozen water .*(falls|river) .*(mountain)/i, 'glacier'],
  [/what .*(covers) (most of) (the )?(earth|planet)/i, 'water'],
  [/body part .*(connect).*(head)/i, 'neck'],
  [/nut .*pistachio ice cream/i, 'pistachio'],
  [/fruit .*peach ice cream/i, 'peach'],
  [/use(d)? to make (\w+) ice cream/i, '__ICE__'],
  [/hangs clothes in a closet|what .*hang(s)? clothes/i, 'hanger'],
  [/machine dries (wet )?clothes/i, 'dryer'],
  [/keeps food (cold|fresh) .*(appliance|machine)/i, 'refrigerator'],
  [/machine cleans (the )?(floor|carpet)/i, 'vacuum cleaner'],
  [/machine washes dishes/i, 'dishwasher'],
  [/device (cuts|mows) grass/i, 'lawnmower'],
  [/sugar'?s? taste/i, 'sweet'],
  [/lemon'?s? taste/i, 'sour'],
  [/coffee'?s? taste/i, 'bitter'],
  [/how does .*salt taste/i, 'salty'],
  [/what (is) (the) taste of (salt|seawater)/i, 'salty'],
  [/what (is) (the) taste of (sugar|honey|candy)/i, 'sweet'],
  [/what (is) (the) taste of (lemon|vinegar)/i, 'sour'],
  [/top covering of a building/i, 'roof'],
  [/what .*(holds) .*(rain|water) .*(building edge|gutter)/i, 'gutter'],
  [/what (is) (the) (bottom) (part) (of) (a) (building)/i, 'foundation'],
  [/what (do) (you) (call) .*(person) (who) (puts out) (fires)/i, 'firefighter'],
  [/what (do) (you) (call) .*person .*(treats|care for) (the )?sick/i, 'doctor'],
  [/what .*(use) .*(measure) (temperature)/i, 'thermometer'],
  [/what .*(use) .*(make) (calls|phone calls)/i, 'phone'],
];

/** 通用算术：「A 能装 24，现有 7，还能放几个」→ 17 */
const SINK_WORDS = /iron|steel|metal|rock|stone|coin|nail|brick|anchor|marble|glass|sand|lead|concrete|pebble|screw|key|spoon|fork|knife/i;
const FLOAT_WORDS = /ball|balloon|beach|wood|wooden|cork|foam|sponge|life ?jacket|boat|ship|raft|leaf|plastic bottle|oil|ice|apple|orange|melon|log|stick|feather|paper/i;

/** 「会沉还是会浮」按物体/材质判定 */
export function sinkOrFloat(q) {
  const m = String(q).match(
    /(?:will|does|do|would)\s+(?:a|an|the)?\s*(.+?)\s+(?:when\s+[^?]*?)?(sink or float|float or sink)/i,
  );
  if (!m) return null;
  const thing = m[1];
  if (SINK_WORDS.test(thing)) return 'sink';
  if (FLOAT_WORDS.test(thing)) return 'float';
  return null;
}

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** 方位题：面朝 X 时背后是反方向 */
export function compassAnswer(q) {
  const m = String(q).match(/facing\s+(north|south|east|west)/i);
  if (!m) return null;
  const d = m[1].toLowerCase();
  if (/behind|back|left|right/i.test(q)) {
    if (/left/i.test(q)) return { north: 'west', south: 'east', east: 'north', west: 'south' }[d];
    if (/right/i.test(q)) return { north: 'east', south: 'west', east: 'south', west: 'north' }[d];
    return OPPOSITE[d];
  }
  return null;
}


/* -------------------------------------------------------------------------- *
 * 常见计数题的直接答案（单词形式）。
 * 这些题出现频率极高，模型要 3~10 秒，本地直接答 0ms —— 也是解决「过得特别慢」的关键。
 * -------------------------------------------------------------------------- */
const EN_TO_ZH = {
  two: '二', three: '三', four: '四', seven: '七', eight: '八', eleven: '十一', twelve: '十二',
  sixty: '六十', 'twenty-four': '二十四', 'twenty-six': '二十六', 'three hundred and sixty-five': '三百六十五',
};

const COUNTING_RULES = [
  [/how many wheels (does|do) a (car|automobile|vehicle)|汽车.*几(个|只)轮|轮子.*汽车/i, 'four'],
  [/how many days (are there )?in a week|一周有几天|一个星期有几(天|日)/i, 'seven'],
  [/how many days (are there )?in a year|一年有几(天|日)/i, 'three hundred and sixty-five'],
  [/how many months (are there )?in a year|一年有几(个)?月/i, 'twelve'],
  [/how many hours (are there )?in a day|一天有几(个)?小时/i, 'twenty-four'],
  [/how many minutes (are there )?in an hour|一小时有几(个)?分钟/i, 'sixty'],
  [/how many seconds (are there )?in a minute|一分钟有几(个)?秒/i, 'sixty'],
  [/how many legs does a (dog|cat|horse|cow|chair)|(狗|猫|马|牛|椅子).*几(条|只)腿/i, 'four'],
  [/how many legs does a (spider|ant)|蜘蛛.*几(条|只)腿/i, 'eight'],
  [/how many legs does a bird|鸟.*几(条|只)腿/i, 'two'],
  [/how many colors (are there )?in a rainbow|彩虹有几(种|个)?颜色/i, 'seven'],
  [/how many letters (are there )?in the (english )?alphabet|字母表有几(个)?字母/i, 'twenty-six'],
  [/how many sides does a triangle|三角形有几(条|个)边/i, 'three'],
  [/how many sides does a square|正方形有几(条|个)边/i, 'four'],
  [/how many players (are there )?on a (football|soccer) team|足球.*几(个|名)球员/i, 'eleven'],
  [/how many continents (are there )?on earth|地球有几(个)?大洲/i, 'seven'],
];

export function answerByRules(q) {
  const text = String(q || '');
  // 本地常识题库优先（0ms，且天然是单词形式）
  for (const [re, ans] of COUNTING_RULES) {
    if (!re.test(text)) continue;
    return CJK.test(text) ? (EN_TO_ZH[ans] || ans) : ans;
  }
  const cc = compassAnswer(text);
  if (cc) return cc;
  const sf = sinkOrFloat(text);
  if (sf) return sf;
  // 是非题优先交给模型（本地规则容易抓成名词，例如 "Is the sun a star?" → "star"）
  const isYesNo = /^(is|are|was|were|does|do|did|can|could|will|would|should|has|have)\b/i.test(text.trim());
  for (const [re, ans] of (isYesNo ? [] : RULES)) {
    const m = text.match(re);
    if (!m) continue;
    if (ans === '__ICE__') return (m[1] || '').toLowerCase();
    return ans;
  }

  const WORD_NUM = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
    eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,
    nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,hundred:100 };
  const nums = [...text.matchAll(/\b(\d{1,4})\b/g)].map((m) => Number(m[1]));
  if (nums.length < 2) {
    for (const w of text.toLowerCase().matchAll(/\b([a-z]+)\b/g)) {
      if (WORD_NUM[w[1]] !== undefined) nums.push(WORD_NUM[w[1]]);
    }
  }
  // 算术题：只处理**显式运算符**，绝不猜
  // 旧代码把 "What is 3 + 4?" 算成 max-min=1，直接把验证码答错 —— 必须删掉那种兜底。
  const arith = normalizeArithmetic(text);
  if (arith !== null) return arith;

  if (nums.length >= 2) {
    const lower = text.toLowerCase();
    if (/how many more|can fit|left|remain|still|还(能|剩|差)|剩余/.test(lower)) {
      return String(Math.max(...nums) - Math.min(...nums));
    }
    if (/total|altogether|in all|combined|sum|一共|总共/.test(lower)) {
      return String(nums.reduce((a, b) => a + b, 0));
    }
    // 其它情况不猜 —— 交给模型
    return null;
  }
  return null;
}

/**
 * 解析显式算术：3 + 4 / 7-2 / 6 * 3 / 8 / 2 / "twelve minus five"。
 * 认不出来返回 null（交给模型），**绝不猜**。
 */
function normalizeArithmetic(text) {
  const t = String(text || '').toLowerCase();
  const WORD_NUM = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
    eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,
    nineteen:19,twenty:20 };
  const OPS = { '+': '+', plus: '+', '-': '-', minus: '-', '*': '*', x: '*', times: '*',
    multiplied: '*', '/': '/', divided: '/' };
  let expr = t.replace(/(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)/g,
    (w) => String(WORD_NUM[w]));
  expr = expr.replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-').replace(/\b(times|multiplied by)\b/g, '*')
    .replace(/\bdivided by\b/g, '/').replace(/\bwhat is\b|\bwhat's\b|\bcalculate\b|等于多少|计算|是多少/g, '');
  const m = /(\d+)\s*([+\-*/])\s*(\d+)/.exec(expr);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  let v = null;
  if (m[2] === '+') v = a + b;
  else if (m[2] === '-') v = a - b;
  else if (m[2] === '*') v = a * b;
  else if (m[2] === '/' && b !== 0) v = a / b;
  if (v === null) return null;
  if (!Number.isInteger(v)) v = Math.round(v * 100) / 100;
  return String(v);
}

/** 把模型输出洗成「一个词/数字/短语」 */
export function sanitizeAnswer(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’。.！!]+$/g, '')
    .trim()
    .slice(0, 40);
}

const SYS_PROMPT = [
  'You are answering a captcha accessibility question.',
  'The question text may contain a long list of language names and boilerplate — IGNORE all of that, answer only the actual question.',
  'Reply with ONLY the answer: one word, one number, or a very short phrase.',
  'IMPORTANT: answer in the SAME language as the question (Chinese question -> Chinese answer).',
  'No punctuation, no quotes, no explanation, do not repeat the question.',
  'Yes/No questions: answer yes/no (or 是/否 for Chinese).',
  'Counting questions ("how many / how much / number of"): answer with the NUMBER AS A WORD, e.g. four, seven, twelve (中文题用 四、七、十二).',
  'Other arithmetic (1+2): digits only.',
].join('\n');

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 造一个答题器：规则 → 缓存 → 文本模型。
 * @param {object} opts
 * @param {{chat: Function}} [opts.engine] opends-freetoken 的引擎（DirectEngine / DeepSeekWeb）
 * @param {Map<string,string>} [opts.cache]
 */
export function makeAsk({ engine = null, cache = new Map(), log = console, thinking = true } = {}) {
  return async function ask(question) {
    const { question: core, lang } = cleanQuestion(question);
    const rule = answerByRules(core);
    if (rule) return rule;
    const key = String(core).trim().toLowerCase();
    if (cache.has(key)) return cache.get(key);
    if (!engine) return null;
    try {
      const res = await engine.chat({
        prompt: `${SYS_PROMPT}\n\nQuestion: ${core}\nAnswer${lang ? ` (in ${lang})` : ''}:`,
        // 你实测：关掉深度思考时模型给 "4"，开了才给 "four" 并过关 —— 默认打开
        thinking,
        meta: { purpose: 'hcaptcha-a11y' },
      });
      const zhQuestion = CJK.test(core) || lang === 'chinese';
      const counting = asksHowMany(core);
      let ans = sanitizeAnswer(res?.text);
      if (ans && !zhQuestion && CJK.test(ans)) {
        // 语言不对 —— 再来一次，明确要求英文
        const res2 = await engine.chat({
          prompt: `${SYS_PROMPT}\n\nQuestion: ${question}\nAnswer in English:`,
          thinking: false,
          meta: { purpose: 'hcaptcha-a11y-retry' },
        });
        ans = sanitizeAnswer(res2?.text);
      }
      if (ans && !zhQuestion && CJK.test(ans)) {
        log.warn?.('a11y 答案非英文，丢弃', { ans });
        return null;
      }
      // 数量题：模型可能给 "4"，hCaptcha 只认单词形式
      if (ans && counting && /^\d{1,2}$/.test(ans)) {
        const spelled = spellNumber(ans, zhQuestion ? 'zh' : 'en');
        log.info?.(`数量题答案 ${ans} → ${spelled}（hCaptcha 要求单词形式）`);
        ans = spelled;
      }
      if (ans) cache.set(key, ans);
      return ans || null;
    } catch (err) {
      log.warn?.('a11y 答题模型失败', { err: String(err?.message || err) });
      return null;
    }
  };
}

// ---------------------------------------------------------------- 题库缓存

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE = path.resolve(process.cwd(), 'data/a11y-cache.json');

export function loadCache(file = DEFAULT_CACHE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

export function saveCache(cache, file = DEFAULT_CACHE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const obj = {};
    for (const [k, v] of cache) obj[k] = v;
    fs.writeFileSync(file, JSON.stringify(obj, null, 1));
  } catch {}
}

/**
 * OpenAI 兼容的答题器（外部 API 兜底；opends 号池挂了时用这个）。
 * @param {{base:string, key?:string, model:string, timeoutMs?:number, cache?:Map}} opts
 */
export function makeHttpAsk({ base, key = '', model, timeoutMs = 15000, cache = new Map(), log = console } = {}) {
  const url = String(base).replace(/\/$/, '') + '/chat/completions';
  return async function ask(question) {
    const { question: core, lang } = cleanQuestion(question);
    const rule = answerByRules(core);
    if (rule) return rule;
    const k = String(question).trim().toLowerCase();
    if (cache.has(k)) return cache.get(k);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 16,
          messages: [
            { role: 'system', content: SYS_PROMPT },
            { role: 'user', content: question },
          ],
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const ans = sanitizeAnswer(d?.choices?.[0]?.message?.content);
      if (ans) { cache.set(k, ans); saveCache(cache); }
      return ans || null;
    } catch (err) {
      log.warn?.('a11y HTTP 答题失败', { err: String(err?.message || err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
