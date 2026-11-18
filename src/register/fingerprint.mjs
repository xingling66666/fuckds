/**
 * 指纹池：每次注册随机挑一台「真实存在的设备」，而不是永远同一台。
 *
 * 为什么：同一指纹反复注册，本身就是强特征（设备维度累计风控分）。
 * 但随机也不能瞎编 —— UA / UA-CH / navigator.platform / 触控点数 / GPU 字符串
 * 必须相互自洽，否则比不换更容易被识别（典型矛盾：UA 说 Windows 而 GPU 报 Adreno）。
 *
 * 每个 profile 里所有字段都是一套自洽组合，直接喂给 vnc-session 应用。
 * 视口一律用宽视口（hCaptcha 无障碍题的面板选择器只在桌面布局下稳定），
 * 视口尺寸不参与风控判断，只影响布局。
 */

const CHROME_MAJOR = '156'; // 与 bin 里的 Chromium 大版本对齐，运行时会再校准

export const PROFILES = [
  /* ---------------- Android ---------------- */
  {
    id: 'android-adreno735',
    label: 'Android · 骁龙8 Gen3（Adreno 735）',
    kind: 'mobile',
    os: 'android',
    model: '24069RA21C',
    platformVersion: '16.0.0',
    androidVersion: '10',
    dpr: 3,
    maxTouchPoints: 5,
    gpu: { unmaskedVendor: 'Google Inc. (Qualcomm)', unmaskedRenderer: 'ANGLE (Qualcomm, Adreno (TM) 735, OpenGL ES 3.2)' },
  },
  {
    id: 'android-adreno740',
    label: 'Android · 骁龙8 Gen2（Adreno 740）',
    kind: 'mobile',
    os: 'android',
    model: 'SM-S918B',
    platformVersion: '15.0.0',
    androidVersion: '10',
    dpr: 2.625,
    maxTouchPoints: 5,
    gpu: { unmaskedVendor: 'Google Inc. (Qualcomm)', unmaskedRenderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)' },
  },
  {
    id: 'android-malig715',
    label: 'Android · 天玑9300（Mali-G715）',
    kind: 'mobile',
    os: 'android',
    model: 'V2309A',
    platformVersion: '14.0.0',
    androidVersion: '10',
    dpr: 3.5,
    maxTouchPoints: 5,
    gpu: { unmaskedVendor: 'Google Inc. (ARM)', unmaskedRenderer: 'ANGLE (ARM, Mali-G715 MC11, OpenGL ES 3.2)' },
  },
  {
    id: 'android-pixel-adreno730',
    label: 'Pixel 8 · Adreno 730',
    kind: 'mobile',
    os: 'android',
    model: 'Pixel 8',
    platformVersion: '15.0.0',
    androidVersion: '10',
    dpr: 2.625,
    maxTouchPoints: 5,
    gpu: { unmaskedVendor: 'Google Inc. (Qualcomm)', unmaskedRenderer: 'ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)' },
  },
  {
    id: 'android-xiaomi-adreno725',
    label: 'Xiaomi 13 · 骁龙8 Gen2（Adreno 725）',
    kind: 'mobile',
    os: 'android',
    model: '2211133C',
    platformVersion: '14.0.0',
    androidVersion: '10',
    dpr: 3,
    maxTouchPoints: 5,
    gpu: { unmaskedVendor: 'Google Inc. (Qualcomm)', unmaskedRenderer: 'ANGLE (Qualcomm, Adreno (TM) 725, OpenGL ES 3.2)' },
  },

  /* ---------------- iOS（Chrome on iOS，WebKit 内核） ---------------- */
  {
    id: 'ios-iphone15pro',
    label: 'iPhone 15 Pro · iOS 17.5（CriOS）',
    kind: 'mobile',
    os: 'ios',
    model: 'iPhone 15 Pro',
    iosVersion: '17_5',
    dpr: 3,
    maxTouchPoints: 5,
    gpu: { unmaskedVendor: 'Apple Inc.', unmaskedRenderer: 'ANGLE (Apple, Apple GPU, OpenGL ES 3.0)' },
  },
  {
    id: 'ios-iphone13',
    label: 'iPhone 13 · iOS 16.6（CriOS）',
    kind: 'mobile',
    os: 'ios',
    model: 'iPhone 13',
    iosVersion: '16_6',
    dpr: 3,
    maxTouchPoints: 5,
    gpu: { unmaskedVendor: 'Apple Inc.', unmaskedRenderer: 'ANGLE (Apple, Apple GPU, OpenGL ES 3.0)' },
  },
  {
    id: 'ios-ipad-air',
    label: 'iPad Air · iPadOS 17.4（CriOS）',
    kind: 'tablet',
    os: 'ios',
    model: 'iPad Air',
    iosVersion: '17_4',
    dpr: 2,
    maxTouchPoints: 5,
    gpu: { unmaskedVendor: 'Apple Inc.', unmaskedRenderer: 'ANGLE (Apple, Apple GPU, OpenGL ES 3.0)' },
  },

  /* ---------------- Windows ---------------- */
  {
    id: 'windows-intel-uhd630',
    label: 'Windows 11 · 核显 Intel UHD 630',
    kind: 'desktop',
    os: 'windows',
    model: '',
    platformVersion: '15.0.0',
    osVersion: '10.0',
    dpr: 1,
    maxTouchPoints: 0,
    gpu: {
      unmaskedVendor: 'Google Inc. (Intel)',
      unmaskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  },
  {
    id: 'windows-nvidia3060',
    label: 'Windows 10 · 独显 RTX 3060',
    kind: 'desktop',
    os: 'windows',
    model: '',
    platformVersion: '10.0.0',
    osVersion: '10.0',
    dpr: 1.25,
    maxTouchPoints: 0,
    gpu: {
      unmaskedVendor: 'Google Inc. (NVIDIA)',
      unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  },
  {
    id: 'windows-amd-rx6700',
    label: 'Windows 11 · RX 6700 XT',
    kind: 'desktop',
    os: 'windows',
    model: '',
    platformVersion: '15.0.0',
    osVersion: '10.0',
    dpr: 1,
    maxTouchPoints: 0,
    gpu: {
      unmaskedVendor: 'Google Inc. (AMD)',
      unmaskedRenderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  },

  /* ---------------- Linux ---------------- */
  {
    id: 'linux-ubuntu-intel',
    label: 'Ubuntu · Intel UHD 620（Mesa）',
    kind: 'desktop',
    os: 'linux',
    model: '',
    platformVersion: '',
    dpr: 1,
    maxTouchPoints: 0,
    gpu: {
      unmaskedVendor: 'Google Inc. (Intel)',
      unmaskedRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
    },
  },
  {
    id: 'linux-fedora-amd',
    label: 'Fedora · AMD Radeon（Mesa）',
    kind: 'desktop',
    os: 'linux',
    model: '',
    platformVersion: '',
    dpr: 1,
    maxTouchPoints: 0,
    gpu: {
      unmaskedVendor: 'Google Inc. (AMD)',
      unmaskedRenderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir, LLVM 17.0.6), OpenGL 4.6)',
    },
  },
];

export const PROFILE_IDS = PROFILES.map((p) => p.id);

/** 把 profile 展开成会话要用的具体值（UA / UA-CH / navigator.* 全都在这里定死） */
export function expandProfile(profile, { chromeMajor = CHROME_MAJOR, width = 1280, height = 900 } = {}) {
  const major = String(chromeMajor);
  const full = `${major}.0.8078.79`;
  const os = profile.os || (profile.kind === 'mobile' ? 'android' : 'windows');
  const isIOS = os === 'ios';
  const isAndroid = os === 'android';
  const isLinux = os === 'linux';
  const isMobileish = isAndroid || isIOS || profile.kind === 'tablet';

  let ua;
  let platform;
  let uaData = null;

  if (isAndroid) {
    ua = `Mozilla/5.0 (Linux; Android ${profile.androidVersion || '10'}; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
    platform = 'Linux armv81';
  } else if (isIOS) {
    // Chrome on iOS（CriOS）：WebKit 内核 → **没有** navigator.userAgentData
    const device = profile.kind === 'tablet' ? 'iPad' : 'iPhone';
    ua = `Mozilla/5.0 (${device}; CPU ${device} OS ${profile.iosVersion || '17_5'} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${major}.0.0.0 Mobile/15E148 Safari/604.1`;
    platform = profile.kind === 'tablet' ? 'iPad' : 'iPhone';
  } else if (isLinux) {
    ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    platform = 'Linux x86_64';
  } else {
    ua = `Mozilla/5.0 (Windows NT ${profile.osVersion || '10.0'}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    platform = 'Win32';
  }

  // Android / Windows / Linux 有 UA-CH；iOS 没有
  if (!isIOS) {
    const brands = isAndroid
      ? [
          { brand: 'Not-A.Brand', version: '99' },
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
        ]
      : [
          { brand: 'Not;A=Brand', version: '24' },
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
        ];
    uaData = {
      brands,
      mobile: isAndroid,
      platform: isAndroid ? 'Android' : isLinux ? 'Linux' : 'Windows',
      architecture: isAndroid ? '' : 'x86',
      bitness: isAndroid ? '' : '64',
      model: profile.model || '',
      platformVersion: profile.platformVersion || '',
      fullVersionList: brands.map((b) => ({
        brand: b.brand,
        version: b.brand.startsWith('Not') ? '99.0.0.0' : full,
      })),
      uaFullVersion: full,
      wow64: false,
      formFactors: isAndroid ? ['Mobile'] : ['Desktop'],
    };
  }

  return {
    id: profile.id,
    label: profile.label,
    kind: profile.kind,
    os,
    ua,
    viewport: { width, height },
    dpr: profile.dpr,
    hasTouch: isMobileish,
    maxTouchPoints: isMobileish ? profile.maxTouchPoints || 5 : 0,
    pdfViewerEnabled: isIOS ? false : !isMobileish,
    platform,
    uaData,
    gpu: profile.gpu,
  };
}

/** 随机挑一台（四种 OS 全在池里；不再支持固定机型） */
export function pickProfile(_setting = 'random', opts = {}) {
  const profile = PROFILES[Math.floor(Math.random() * PROFILES.length)];
  return { profile, expanded: expandProfile(profile, opts) };
}
